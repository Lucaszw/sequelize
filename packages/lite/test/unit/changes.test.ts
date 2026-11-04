import { PGlite } from '@electric-sql/pglite';
import type { ChangeRecord, Sequelize } from '@sequelize/lite';
import {
  CHANGE_SET_FORMAT,
  DataTypes,
  coalesceChanges,
  decodeValue,
  encodeValue,
} from '@sequelize/lite';
import { expect } from 'chai';
import { createSequelize } from './support';

function strip(changes: ChangeRecord[]) {
  return changes.map(({ model, op, pk, data }) => ({ model, op, pk, data }));
}

describe('change log', () => {
  let sequelize: Sequelize;

  afterEach(async () => {
    await sequelize?.close();
  });

  async function setup() {
    sequelize = await createSequelize();
    const Todo = sequelize.define(
      'Todo',
      {
        id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
        title: DataTypes.STRING,
        done: { type: DataTypes.BOOLEAN, defaultValue: false },
      },
      { timestamps: false },
    );
    const LocalOnly = sequelize.define(
      'LocalOnly',
      { value: DataTypes.STRING },
      { trackChanges: false },
    );
    await sequelize.sync();

    return { Todo, LocalOnly };
  }

  it('records creates, updates (changed fields only) and destroys', async () => {
    const { Todo, LocalOnly } = await setup();
    const todo = await Todo.create({ title: 'a' });
    const id = todo.get('id');
    await todo.update({ title: 'b' });
    await todo.update({ title: 'b' }); // no change, no entry
    await todo.destroy();
    await LocalOnly.create({ value: 'not tracked' });
    await Todo.create({ title: 'untracked' }, { trackChanges: false });

    const changes = await sequelize.getPendingChanges();
    expect(strip(changes)).to.deep.equal([
      { model: 'Todo', op: 'create', pk: { id }, data: { id, title: 'a', done: false } },
      { model: 'Todo', op: 'update', pk: { id }, data: { title: 'b' } },
      { model: 'Todo', op: 'destroy', pk: { id }, data: null },
    ]);
    expect(changes.map(change => change.seq)).to.deep.equal(
      changes.map(change => change.seq).sort((a, b) => a - b),
    );
    expect(changes[0].at).to.be.a('string');
  });

  it('records one entry per row for bulk operations, and none for no-ops', async () => {
    const { Todo } = await setup();
    await Todo.bulkCreate([{ title: 'a' }, { title: 'b' }, { title: 'c' }]);
    await Todo.update({ done: true }, { where: { title: ['a', 'b'] } });
    await Todo.destroy({ where: { title: 'c' } });
    await Todo.destroy({ where: { title: 'nope' } });
    await Todo.update({ done: true }, { where: { title: 'nope' } });

    const ops = (await sequelize.getPendingChanges()).map(
      change => `${change.op}:${(change.data as any)?.done ?? ''}`,
    );
    expect(ops).to.deep.equal([
      'create:false',
      'create:false',
      'create:false',
      'update:true',
      'update:true',
      'destroy:',
    ]);
  });

  it('exports, pushes and acknowledges change sets', async () => {
    const { Todo } = await setup();
    await Todo.create({ title: 'a' });

    const changeSet = await sequelize.exportChanges();
    expect(changeSet).to.include({ format: CHANGE_SET_FORMAT, version: 1 });
    expect(changeSet.clientId).to.equal(await sequelize.getClientId());
    expect(changeSet.changes).to.have.length(1);

    // a failed push keeps the changes
    try {
      await sequelize.pushChanges(async () => {
        throw new Error('offline');
      });
      expect.fail('should have thrown');
    } catch (error) {
      expect((error as Error).message).to.equal('offline');
    }

    expect(await sequelize.countPendingChanges()).to.equal(1);

    // changes made while a push is in flight are kept
    const result = await sequelize.pushChanges(async sent => {
      await Todo.create({ title: 'during push' });

      return sent.changes.length;
    });
    expect(result).to.equal(1);
    expect(
      strip(await sequelize.getPendingChanges()).map(change => change.data?.title),
    ).to.deep.equal(['during push']);
  });

  it('keeps the same client id across instances', async () => {
    const pglite = new PGlite();
    sequelize = await createSequelize({ pglite });
    await sequelize.sync();
    const id = await sequelize.getClientId();
    const second = await createSequelize({ pglite });
    expect(await second.getClientId()).to.equal(id);
  });

  it('coalesces changes to the same row', () => {
    const at = '2026-01-01T00:00:00.000Z';
    const change = (
      seq: number,
      op: ChangeRecord['op'],
      id: string,
      data: Record<string, unknown> | null,
    ): ChangeRecord => ({
      seq,
      model: 'Todo',
      op,
      pk: { id },
      data,
      at,
    });

    const result = coalesceChanges([
      change(1, 'create', 'a', { id: 'a', title: 'one' }),
      change(2, 'update', 'a', { title: 'two' }),
      change(3, 'update', 'b', { title: 'x' }),
      change(4, 'create', 'c', { id: 'c' }),
      change(5, 'update', 'b', { done: true }),
      change(6, 'destroy', 'c', null),
      change(7, 'update', 'd', { title: 'd' }),
      change(8, 'destroy', 'd', null),
    ]);

    expect(result.map(({ seq, op, pk, data }) => ({ seq, op, id: pk.id, data }))).to.deep.equal([
      { seq: 2, op: 'create', id: 'a', data: { id: 'a', title: 'two' } },
      { seq: 5, op: 'update', id: 'b', data: { title: 'x', done: true } },
      { seq: 8, op: 'destroy', id: 'd', data: null },
    ]);
  });

  it('encodes values that JSON cannot represent', () => {
    const roundTrip = (value: unknown) =>
      decodeValue(JSON.parse(JSON.stringify(encodeValue(value))));

    // dates & bigints become strings that the server-side data types parse back
    expect(roundTrip(new Date('2026-01-01T00:00:00.000Z'))).to.equal('2026-01-01T00:00:00.000Z');
    expect(roundTrip(10n ** 20n)).to.equal('100000000000000000000');
    expect(roundTrip(new Uint8Array([1, 2, 255]))).to.deep.equal(new Uint8Array([1, 2, 255]));
    expect(roundTrip({ nested: [1, 'a'] })).to.deep.equal({ nested: [1, 'a'] });
    expect(roundTrip(null)).to.equal(null);
  });
});

import { PGlite } from '@electric-sql/pglite';
import type { ChangeSet, Snapshot } from '@sequelize/lite';
import {
  DataTypes,
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  Sequelize,
  SyncError,
  ValidationError,
} from '@sequelize/lite';
import { expect } from 'chai';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expectRejection } from './support';

type Options = Omit<ConstructorParameters<typeof Sequelize>[0], 'pglite'>;

async function open(dataDir: string | undefined, options: Options = {}) {
  const sequelize = new Sequelize({ pglite: new PGlite(dataDir), ...options });
  const Todo = sequelize.define('Todo', {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    title: { type: DataTypes.STRING, allowNull: false, validate: { notEmpty: true } },
    done: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  });
  const Draft = sequelize.define(
    'Draft',
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      text: DataTypes.TEXT,
    },
    { trackChanges: false },
  );
  await sequelize.sync();

  return { sequelize, Todo, Draft };
}

async function titles(Todo: Awaited<ReturnType<typeof open>>['Todo']) {
  return (await Todo.findAll({ order: [['title', 'ASC']] })).map(todo => todo.get('title'));
}

function overTheWire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/** An in-memory stand-in for a backend calling applyChanges / exportSnapshot */
function createBackend() {
  const rows = new Map<string, Record<string, unknown>>();
  const backend = {
    rows,
    pushes: 0,
    reject: false,
    push(changeSet: ChangeSet) {
      const body = overTheWire(changeSet);
      if (backend.reject) {
        throw new Error('Rejected by the backend');
      }

      backend.pushes++;
      for (const change of body.changes) {
        const id = change.pk.id as string;
        if (change.op === 'destroy') {
          rows.delete(id);
        } else {
          rows.set(id, { ...rows.get(id), ...change.data });
        }
      }

      return { ok: true };
    },
    pull(): Snapshot {
      return overTheWire({
        format: SNAPSHOT_FORMAT,
        version: SNAPSHOT_VERSION,
        exportedAt: new Date().toISOString(),
        models: { Todo: [...rows.values()] },
      });
    },
  };

  return backend;
}

describe('modes', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'sequelize-lite-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('defaults to synced', async () => {
    const { sequelize } = await open(undefined);
    expect(sequelize.mode).to.equal('synced');
    await sequelize.close();
  });

  it('rejects unknown modes, and remote mode without push & pull', () => {
    expect(() => new Sequelize({ pglite: new PGlite(), mode: 'other' as any })).to.throw(
      /Unknown mode/,
    );
    expect(() => new Sequelize({ pglite: new PGlite(), mode: 'remote' })).to.throw(/remote\.push/);
    expect(
      () => new Sequelize({ pglite: new PGlite(), mode: 'remote', remote: { push() {} } }),
    ).to.throw(/remote\.pull/);
  });

  describe('local', () => {
    it('restores its state from PGlite storage, and never records or syncs changes', async () => {
      const first = await open(dataDir, { mode: 'local' });
      const groceries = await first.Todo.create({ title: 'Groceries' });
      await first.Todo.create({ title: 'Laundry' });
      await groceries.update({ done: true });
      await first.Todo.destroy({ where: { title: 'Laundry' } });
      await first.Todo.create({ title: 'Walk the dog' });
      expect(await first.sequelize.countPendingChanges()).to.equal(0);
      await first.sequelize.close();

      const second = await open(dataDir, { mode: 'local' });
      expect(await titles(second.Todo)).to.deep.equal(['Groceries', 'Walk the dog']);
      expect((await second.Todo.findByPk(groceries.get('id') as string))!.get('done')).to.equal(
        true,
      );
      expect(await second.sequelize.countPendingChanges()).to.equal(0);

      await expectRejection(second.sequelize.exportChanges(), SyncError);
      await expectRejection(
        second.sequelize.pushChanges(() => expect.fail('sent')),
        SyncError,
      );
      await expectRejection(
        second.sequelize.pullSnapshot(() => expect.fail('pulled')),
        SyncError,
      );
      await expectRejection(
        second.sequelize.applySnapshot({
          format: SNAPSHOT_FORMAT,
          version: SNAPSHOT_VERSION,
          exportedAt: '',
          models: {},
        }),
        SyncError,
      );
      await second.sequelize.close();
    });
  });

  describe('synced', () => {
    it('restores its data and pending changes from PGlite storage', async () => {
      const first = await open(dataDir);
      const groceries = await first.Todo.create({ title: 'Groceries' });
      await first.Todo.create({ title: 'Laundry' });
      await groceries.update({ done: true });
      await first.Draft.create({ text: 'not synced' });
      const clientId = await first.sequelize.getClientId();
      await first.sequelize.close();

      const second = await open(dataDir);
      expect(await titles(second.Todo)).to.deep.equal(['Groceries', 'Laundry']);
      expect(await second.Draft.count()).to.equal(1);
      expect(await second.sequelize.getClientId()).to.equal(clientId);
      expect(await second.sequelize.countPendingChanges()).to.equal(3);

      const backend = createBackend();
      await second.sequelize.pushChanges(backend.push);
      expect(await second.sequelize.countPendingChanges()).to.equal(0);
      expect(
        [...backend.rows.values()]
          .map(row => row.title as string)
          .sort((x, y) => x.localeCompare(y)),
      ).to.deep.equal(['Groceries', 'Laundry']);
      await second.sequelize.close();
    });

    it('restores a new device from a backend snapshot', async () => {
      const backend = createBackend();
      const device = await open(dataDir, { remote: backend });
      await device.Todo.create({ title: 'Groceries', done: true });
      await device.Todo.create({ title: 'Laundry' });
      await device.sequelize.pushChanges();
      await device.sequelize.close();

      const fresh = await open(undefined, { remote: backend });
      expect(await fresh.Todo.count()).to.equal(0);
      const result = await fresh.sequelize.pullSnapshot();
      expect(result).to.deep.equal({ restored: 2, preserved: 0 });
      expect(await titles(fresh.Todo)).to.deep.equal(['Groceries', 'Laundry']);
      const groceries = await fresh.Todo.findOne({ where: { title: 'Groceries' } });
      expect(groceries!.get('done')).to.equal(true);
      expect(groceries!.get('createdAt')).to.be.instanceOf(Date);
      expect((groceries!.get('createdAt') as Date).toISOString()).to.equal(
        backend.rows.get(groceries!.get('id') as string)!.createdAt,
      );
      // restoring does not create changes to push back
      expect(await fresh.sequelize.countPendingChanges()).to.equal(0);
      await fresh.sequelize.close();
    });

    it('keeps rows with pending changes and local-only models when pulling a snapshot', async () => {
      const backend = createBackend();
      const { sequelize, Todo, Draft } = await open(undefined, { remote: backend });
      const edited = await Todo.create({ title: 'Edited offline' });
      const deleted = await Todo.create({ title: 'Deleted offline' });
      const untouched = await Todo.create({ title: 'Untouched' });
      await Draft.create({ text: 'local only' });
      await sequelize.pushChanges();

      // offline edits
      await edited.update({ title: 'Edited offline (v2)' });
      await deleted.destroy();
      const created = await Todo.create({ title: 'Created offline' });

      // meanwhile, on the backend
      backend.rows.get(edited.get('id') as string)!.title = 'Edited on server';
      backend.rows.get(untouched.get('id') as string)!.title = 'Untouched (server)';
      backend.rows.set('7b0c3b52-8d4e-4bc1-9d7a-1f0f8f0f0f0f', {
        id: '7b0c3b52-8d4e-4bc1-9d7a-1f0f8f0f0f0f',
        title: 'Created on server',
        done: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const result = await sequelize.pullSnapshot();
      expect(result).to.deep.equal({ restored: 2, preserved: 3 });
      expect(await titles(Todo)).to.deep.equal([
        'Created offline',
        'Created on server',
        'Edited offline (v2)',
        'Untouched (server)',
      ]);
      expect(await Draft.count()).to.equal(1);
      expect(await sequelize.countPendingChanges()).to.equal(3);

      await sequelize.pushChanges();
      expect(backend.rows.has(deleted.get('id') as string)).to.equal(false);
      expect(backend.rows.get(created.get('id') as string)!.title).to.equal('Created offline');
      await sequelize.close();
    });

    it('rejects malformed snapshots and unknown models', async () => {
      const { sequelize } = await open(undefined);
      await expectRejection(sequelize.applySnapshot({ format: 'nope' }), /snapshot format/);
      await expectRejection(
        sequelize.applySnapshot({
          format: SNAPSHOT_FORMAT,
          version: SNAPSHOT_VERSION,
          exportedAt: '',
          models: { Secret: [] },
        }),
        /not defined on the client/,
      );
      await sequelize.close();
    });
  });

  describe('remote', () => {
    it('sends every write to the backend before committing it', async () => {
      const backend = createBackend();
      const { sequelize, Todo } = await open(undefined, { mode: 'remote', remote: backend });

      const todo = await Todo.create({ title: 'Groceries' });
      expect(backend.rows.get(todo.get('id') as string)!.title).to.equal('Groceries');
      await todo.update({ done: true });
      expect(backend.rows.get(todo.get('id') as string)!.done).to.equal(true);

      await sequelize.transaction(async () => {
        await Todo.create({ title: 'A' });
        await Todo.create({ title: 'B' });
      });
      expect(backend.pushes).to.equal(3);
      expect(await sequelize.countPendingChanges()).to.equal(0);

      // client-side validation still runs before anything is sent
      await expectRejection(Todo.create({ title: '' }), ValidationError);
      expect(backend.pushes).to.equal(3);
      await sequelize.close();
    });

    it('rolls back writes the backend rejects', async () => {
      const backend = createBackend();
      const { sequelize, Todo } = await open(undefined, { mode: 'remote', remote: backend });
      const todo = await Todo.create({ title: 'Groceries' });

      backend.reject = true;
      await expectRejection(Todo.create({ title: 'Rejected' }), /Rejected by the backend/);
      await expectRejection(todo.update({ done: true }), /Rejected by the backend/);
      const transaction = await sequelize.transaction();
      await Todo.create({ title: 'Rejected too' }, { transaction });
      await expectRejection(transaction.commit(), /Rejected by the backend/);

      expect(await titles(Todo)).to.deep.equal(['Groceries']);
      expect((await Todo.findByPk(todo.get('id') as string))!.get('done')).to.equal(false);
      expect(await sequelize.countPendingChanges()).to.equal(0);
      await sequelize.close();
    });

    it('restores its state from the backend on sync', async () => {
      const backend = createBackend();
      const first = await open(undefined, { mode: 'remote', remote: backend });
      await first.Todo.create({ title: 'Groceries' });
      const laundry = await first.Todo.create({ title: 'Laundry' });
      await first.Todo.create({ title: 'Walk the dog' });
      await laundry.destroy();
      await first.sequelize.close();

      const second = await open(undefined, { mode: 'remote', remote: backend });
      expect(await titles(second.Todo)).to.deep.equal(['Groceries', 'Walk the dog']);

      // changes made elsewhere are picked up with pullSnapshot
      const [id] = [...backend.rows.keys()];
      backend.rows.get(id)!.title = 'Changed elsewhere';
      await second.sequelize.pullSnapshot();
      expect((await second.Todo.findByPk(id))!.get('title')).to.equal('Changed elsewhere');
      await second.sequelize.close();
    });
  });
});

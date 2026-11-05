import { PGlite } from '@electric-sql/pglite';
import { DataTypes as CoreDataTypes, Sequelize as CoreSequelize } from '@sequelize/core';
import type { ChangeSet } from '@sequelize/lite';
import { DataTypes, Sequelize } from '@sequelize/lite';
import { applyChanges } from '@sequelize/lite/server';
import { PostgresDialect } from '@sequelize/postgres';
import { expect } from 'chai';
import { expectRejection } from '../unit/support';

const { env } = process;

function createServer() {
  const server = new CoreSequelize({
    dialect: PostgresDialect,
    host: env.SEQ_PG_HOST ?? '127.0.0.1',
    port: Number(env.SEQ_PG_PORT ?? 5432),
    user: env.SEQ_PG_USER ?? 'pg',
    password: env.SEQ_PG_PW ?? 'pg',
    database: env.SEQ_PG_DB ?? 'sync_test',
    logging: false,
  });

  const Todo = server.define(
    'Todo',
    {
      id: { type: CoreDataTypes.UUID, primaryKey: true, defaultValue: CoreDataTypes.UUIDV4 },
      title: { type: CoreDataTypes.STRING, allowNull: false, validate: { len: [1, 20] } },
      done: { type: CoreDataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      tags: CoreDataTypes.ARRAY(CoreDataTypes.TEXT),
      meta: CoreDataTypes.JSONB,
      due: CoreDataTypes.DATEONLY,
      position: CoreDataTypes.INTEGER,
      createdBy: CoreDataTypes.STRING,
    },
    { underscored: true },
  );

  const Secret = server.define('Secret', {
    id: { type: CoreDataTypes.UUID, primaryKey: true },
    value: CoreDataTypes.STRING,
  });

  return { server, Todo, Secret };
}

async function createClient() {
  const client = new Sequelize({ pglite: new PGlite() });
  const Todo = client.define(
    'Todo',
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      title: { type: DataTypes.STRING, allowNull: false },
      done: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      tags: DataTypes.ARRAY(DataTypes.TEXT),
      meta: DataTypes.JSONB,
      due: DataTypes.DATEONLY,
      position: DataTypes.INTEGER,
    },
    { underscored: true },
  );
  const Secret = client.define('Secret', {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    value: DataTypes.STRING,
  });
  await client.sync();

  return { client, Todo, Secret };
}

/**
 * Simulates sending the change set over HTTP
 * @param changeSet
 */
function overTheWire(changeSet: ChangeSet): unknown {
  return JSON.parse(JSON.stringify(changeSet));
}

describe('sync to @sequelize/core (postgres)', () => {
  let backend: ReturnType<typeof createServer>;
  let local: Awaited<ReturnType<typeof createClient>>;

  beforeEach(async () => {
    backend = createServer();
    await backend.server.sync({ force: true });
    local = await createClient();
  });

  afterEach(async () => {
    await backend.server.close();
    await local.client.close();
  });

  it('replays offline creates, updates and destroys on the server', async () => {
    const { Todo } = local;

    const groceries = await Todo.create({
      title: 'Groceries',
      tags: ['home'],
      meta: { items: ['milk', 'eggs'], priority: 1 },
      due: '2026-11-04',
      position: 1,
    });
    const laundry = await Todo.create({ title: 'Laundry', position: 2 });
    const temporary = await Todo.create({ title: 'Temporary' });

    await groceries.update({ done: true, meta: { items: ['milk'], priority: 2 } });
    await laundry.destroy();
    await temporary.update({ title: 'Still temporary' });
    await temporary.destroy();
    await Todo.update({ position: 10 }, { where: { done: true } });

    const received: unknown[] = [];
    const result = await local.client.pushChanges(async changeSet => {
      const body = overTheWire(changeSet);
      received.push(body);

      return applyChanges(backend.server, body, { models: [backend.Todo] });
    });

    expect(result!.applied).to.be.greaterThan(0);
    expect(await local.client.countPendingChanges()).to.equal(0);

    const rows = await backend.Todo.findAll({ raw: true });
    expect(rows).to.have.length(1);
    expect(rows[0]).to.deep.include({
      id: groceries.get('id'),
      title: 'Groceries',
      done: true,
      tags: ['home'],
      meta: { items: ['milk'], priority: 2 },
      due: '2026-11-04',
      position: 10,
    });

    // nothing left to push
    expect(await local.client.pushChanges(async () => expect.fail('should not send'))).to.equal(
      null,
    );

    // applying the same change set again (e.g. the response was lost) is a no-op
    await applyChanges(backend.server, received[0], { models: [backend.Todo] });
    expect(await backend.Todo.count()).to.equal(1);
    expect((await backend.Todo.findByPk(groceries.get('id') as string))!.get('position')).to.equal(
      10,
    );
  });

  it('coalesced change sets give the same result', async () => {
    const { Todo } = local;
    const todo = await Todo.create({ title: 'A' });
    await todo.update({ title: 'B' });
    await todo.update({ done: true });
    const gone = await Todo.create({ title: 'Gone' });
    await gone.destroy();

    const changeSet = await local.client.exportChanges({ coalesce: true });
    expect(changeSet.changes.map(change => change.op)).to.deep.equal(['create']);

    await applyChanges(backend.server, overTheWire(changeSet), { models: { Todo: backend.Todo } });
    const row = await backend.Todo.findByPk(todo.get('id') as string);
    expect(row!.get('title')).to.equal('B');
    expect(row!.get('done')).to.equal(true);
  });

  it('runs server hooks & validation, and rolls back everything when one change fails', async () => {
    const createdBy: string[] = [];
    backend.Todo.beforeCreate(todo => {
      todo.set('createdBy', 'sync');
      createdBy.push(todo.get('title') as string);
    });

    await local.Todo.create({ title: 'Fine' });
    await local.Todo.create({ title: 'This title is far too long for the server' });

    await expectRejection(
      local.client.pushChanges(async changeSet =>
        applyChanges(backend.server, overTheWire(changeSet), { models: [backend.Todo] }),
      ),
      /len|Validation/i,
    );

    // nothing applied, nothing acknowledged
    expect(await backend.Todo.count()).to.equal(0);
    expect(await local.client.countPendingChanges()).to.equal(2);

    // the client fixes the data and retries
    await local.Todo.update(
      { title: 'Shorter' },
      { where: { title: 'This title is far too long for the server' } },
    );
    await local.client.pushChanges(async changeSet =>
      applyChanges(backend.server, overTheWire(changeSet), { models: [backend.Todo] }),
    );
    const titles = (await backend.Todo.findAll({ order: [['title', 'ASC']] })).map(todo => [
      todo.get('title'),
      todo.get('createdBy'),
    ]);
    expect(titles).to.deep.equal([
      ['Fine', 'sync'],
      ['Shorter', 'sync'],
    ]);
    expect(createdBy).to.include('Shorter');
  });

  it('rejects models that are not allowed, and supports transform', async () => {
    await local.Secret.create({ value: 'x' });
    const secretChanges = overTheWire(await local.client.exportChanges());
    await expectRejection(
      applyChanges(backend.server, secretChanges, { models: [backend.Todo] }),
      /not allowed/,
    );
    expect(await backend.Secret.count()).to.equal(0);
    await local.client.discardChanges();

    const keep = await local.Todo.create({ title: 'keep' });
    await local.Todo.create({ title: 'skip me' });
    const result = await applyChanges(
      backend.server,
      overTheWire(await local.client.exportChanges()),
      {
        models: [backend.Todo],
        transform(change, { existing }) {
          expect(existing).to.equal(null);
          if (change.data?.title === 'skip me') {
            return null;
          }

          return { ...change, data: { ...change.data, title: 'kept' } };
        },
      },
    );

    expect(result.results.map(item => item.status)).to.deep.equal(['created', 'skipped']);
    expect((await backend.Todo.findByPk(keep.get('id') as string))!.get('title')).to.equal('kept');
    expect(await backend.Todo.count()).to.equal(1);
  });

  it('rejects malformed change sets and unknown attributes', async () => {
    await expectRejection(
      applyChanges(backend.server, { hello: 'world' }, { models: [backend.Todo] }),
      /format/,
    );

    await local.Todo.create({ title: 'x' });
    const changeSet = overTheWire(await local.client.exportChanges()) as ChangeSet;
    changeSet.changes[0].data = { ...changeSet.changes[0].data, isAdmin: true };
    await expectRejection(
      applyChanges(backend.server, changeSet, { models: [backend.Todo] }),
      /unknown attribute/,
    );
  });
});

import { PGlite } from '@electric-sql/pglite';
import { DataTypes as CoreDataTypes, Sequelize as CoreSequelize, Op } from '@sequelize/core';
import type { SequelizeMode } from '@sequelize/lite';
import { DataTypes, Sequelize, SyncError } from '@sequelize/lite';
import type { SyncModels } from '@sequelize/lite/server';
import { applyChanges, exportSnapshot } from '@sequelize/lite/server';
import { PostgresDialect } from '@sequelize/postgres';
import { expect } from 'chai';
import { expectRejection } from '../unit/support';

const { env } = process;

const ALICE = '0a1c3e00-0000-4000-8000-000000000001';
const BOB = '0b0b0000-0000-4000-8000-000000000002';

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

  const User = server.define(
    'User',
    {
      id: { type: CoreDataTypes.UUID, primaryKey: true },
      name: { type: CoreDataTypes.STRING, allowNull: false },
      email: CoreDataTypes.STRING,
      password: CoreDataTypes.STRING,
    },
    { tableName: 'mode_users' },
  );

  const Todo = server.define(
    'Todo',
    {
      id: { type: CoreDataTypes.UUID, primaryKey: true, defaultValue: CoreDataTypes.UUIDV4 },
      title: { type: CoreDataTypes.STRING, allowNull: false, validate: { len: [1, 20] } },
      done: { type: CoreDataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      ownerId: { type: CoreDataTypes.UUID, allowNull: false },
      public: { type: CoreDataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      internalNotes: CoreDataTypes.TEXT,
    },
    { tableName: 'mode_todos' },
  );

  const Session = server.define(
    'Session',
    {
      id: { type: CoreDataTypes.UUID, primaryKey: true, defaultValue: CoreDataTypes.UUIDV4 },
      token: CoreDataTypes.STRING,
    },
    { tableName: 'mode_sessions' },
  );

  /**
   * What the logged-in user may read & write
   *
   * @param userId
   */
  const syncModels = (userId: string): SyncModels => ({
    User: {
      model: User,
      exclude: ['password', 'createdAt', 'updatedAt'],
      where: { id: userId },
    },
    Todo: {
      model: Todo,
      exclude: ['internalNotes'],
      where: { [Op.or]: [{ ownerId: userId }, { public: true }] },
      writeWhere: { ownerId: userId },
    },
  });

  return { server, User, Todo, Session, syncModels };
}

type Backend = ReturnType<typeof createServer>;

async function createClient(backend: Backend, userId: string, mode: SequelizeMode) {
  const client = new Sequelize({
    pglite: new PGlite(),
    mode,
    remote: {
      async push(changeSet) {
        const body = JSON.parse(JSON.stringify(changeSet));

        return applyChanges(backend.server, body, { models: backend.syncModels(userId) });
      },
      async pull() {
        const snapshot = await exportSnapshot(backend.server, {
          models: backend.syncModels(userId),
        });

        return JSON.parse(JSON.stringify(snapshot));
      },
    },
  });

  const User = client.define(
    'User',
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      name: { type: DataTypes.STRING, allowNull: false },
      email: DataTypes.STRING,
    },
    { timestamps: false },
  );
  const Todo = client.define('Todo', {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    title: { type: DataTypes.STRING, allowNull: false },
    done: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    ownerId: { type: DataTypes.UUID, allowNull: false },
    public: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  });
  await client.sync();

  return { client, User, Todo };
}

async function titles(Todo: { findAll(options: any): Promise<any[]> }) {
  return (await Todo.findAll({ order: [['title', 'ASC']] })).map(todo => todo.get('title'));
}

describe('modes against @sequelize/core (postgres)', () => {
  let backend: Backend;
  const clients: Sequelize[] = [];

  async function connect(userId: string, mode: SequelizeMode) {
    const client = await createClient(backend, userId, mode);
    clients.push(client.client);

    return client;
  }

  beforeEach(async () => {
    backend = createServer();
    await backend.server.sync({ force: true });
    await backend.User.bulkCreate([
      { id: ALICE, name: 'Alice', email: 'alice@example.com', password: 'alice-hash' },
      { id: BOB, name: 'Bob', email: 'bob@example.com', password: 'bob-hash' },
    ]);
    await backend.Todo.bulkCreate([
      { title: 'Bob private', ownerId: BOB, internalNotes: 'bob-notes' },
      { title: 'Bob public', ownerId: BOB, public: true, internalNotes: 'bob-public-notes' },
    ]);
    await backend.Session.create({ token: 'session-token' });
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map(async client => client.close()));
    await backend.server.close();
  });

  describe('remote', () => {
    it('writes through to the backend, and a new client restores the backend state', async () => {
      const first = await connect(ALICE, 'remote');
      expect(await titles(first.Todo)).to.deep.equal(['Bob public']);

      const groceries = await first.Todo.create({ title: 'Groceries', ownerId: ALICE });
      await first.Todo.create({ title: 'Laundry', ownerId: ALICE });
      await groceries.update({ done: true });
      await first.Todo.destroy({ where: { title: 'Laundry' } });
      await first.User.update({ name: 'Alice B.' }, { where: { id: ALICE } });

      // the backend has every write, without waiting for a push
      const serverTodo = await backend.Todo.findByPk(groceries.get('id') as string);
      expect(serverTodo!.get('done')).to.equal(true);
      expect(await backend.Todo.count({ where: { ownerId: ALICE } })).to.equal(1);
      expect((await backend.User.findByPk(ALICE))!.get('name')).to.equal('Alice B.');

      // the backend rejects the write → rolled back locally
      await expectRejection(
        first.Todo.create({ title: 'This title is way too long', ownerId: ALICE }),
        /len|Validation/i,
      );
      expect(await first.Todo.count()).to.equal(2);

      const second = await connect(ALICE, 'remote');
      expect(await titles(second.Todo)).to.deep.equal(['Bob public', 'Groceries']);
      expect((await second.Todo.findOne({ where: { title: 'Groceries' } }))!.get('done')).to.equal(
        true,
      );
      expect((await second.User.findByPk(ALICE))!.get('name')).to.equal('Alice B.');
    });
  });

  describe('synced', () => {
    it('pushes offline changes, and a new device restores them from the backend', async () => {
      const laptop = await connect(ALICE, 'synced');
      expect(await titles(laptop.Todo)).to.deep.equal([]);
      await laptop.client.pullSnapshot();
      expect(await titles(laptop.Todo)).to.deep.equal(['Bob public']);

      const groceries = await laptop.Todo.create({ title: 'Groceries', ownerId: ALICE });
      await laptop.Todo.create({ title: 'Laundry', ownerId: ALICE });
      await groceries.update({ done: true });
      expect(await backend.Todo.count({ where: { ownerId: ALICE } })).to.equal(0);

      await laptop.client.pushChanges();
      expect(await backend.Todo.count({ where: { ownerId: ALICE } })).to.equal(2);

      const phone = await connect(ALICE, 'synced');
      await phone.client.pullSnapshot();
      expect(await titles(phone.Todo)).to.deep.equal(['Bob public', 'Groceries', 'Laundry']);
      expect((await phone.Todo.findByPk(groceries.get('id') as string))!.get('done')).to.equal(
        true,
      );

      // an offline edit on the phone survives a pull, and is pushed afterwards
      await phone.Todo.update({ title: 'Laundry (phone)' }, { where: { title: 'Laundry' } });
      await laptop.Todo.update({ title: 'Groceries (lap)' }, { where: { title: 'Groceries' } });
      await laptop.client.pushChanges();
      await phone.client.pullSnapshot();
      expect(await titles(phone.Todo)).to.deep.equal([
        'Bob public',
        'Groceries (lap)',
        'Laundry (phone)',
      ]);
      await phone.client.pushChanges();
      expect(
        (await backend.Todo.findAll({ where: { ownerId: ALICE }, order: [['title', 'ASC']] })).map(
          todo => todo.get('title'),
        ),
      ).to.deep.equal(['Groceries (lap)', 'Laundry (phone)']);
    });
  });

  describe('sensitive data', () => {
    it('never sends excluded columns, unlisted tables, or other users’ private rows', async () => {
      await backend.Todo.create({ title: 'Alice todo', ownerId: ALICE, internalNotes: 'a-notes' });
      const snapshot = await exportSnapshot(backend.server, { models: backend.syncModels(ALICE) });
      const json = JSON.stringify(snapshot);

      expect(Object.keys(snapshot.models).sort()).to.deep.equal(['Todo', 'User']);
      for (const secret of [
        'password',
        'alice-hash',
        'bob-hash',
        'internalNotes',
        'notes',
        'Bob private',
        'bob@example.com',
        'Session',
        'session-token',
      ]) {
        expect(json).not.to.include(secret);
      }

      expect(snapshot.models.User).to.deep.equal([
        { id: ALICE, name: 'Alice', email: 'alice@example.com' },
      ]);
      expect(
        snapshot.models.Todo.map(row => row.title as string).sort((x, y) => x.localeCompare(y)),
      ).to.deep.equal(['Alice todo', 'Bob public']);
    });

    it('can hide columns per row with transform', async () => {
      const snapshot = await exportSnapshot(backend.server, {
        models: {
          User: {
            model: backend.User,
            attributes: ['name', 'email'],
            transform(row, { instance }) {
              return instance.get('id') === ALICE ? row : { ...row, email: null, password: 'leak' };
            },
          },
        },
      });

      expect(JSON.stringify(snapshot)).not.to.include('bob@example.com');
      expect(JSON.stringify(snapshot)).not.to.include('leak');
      expect(snapshot.models.User).to.have.deep.members([
        { id: ALICE, name: 'Alice', email: 'alice@example.com' },
        { id: BOB, name: 'Bob', email: null },
      ]);
    });

    it('requires an explicit column list, and rejects unknown columns', async () => {
      await expectRejection(
        exportSnapshot(backend.server, { models: [backend.Todo] }),
        /requires "attributes" or "exclude"/,
      );
      await expectRejection(
        exportSnapshot(backend.server, {
          models: { User: { model: backend.User, exclude: ['pasword'] } },
        }),
        /unknown attribute "pasword"/,
      );
      await expectRejection(
        exportSnapshot(backend.server, {
          models: { User: { model: backend.User, exclude: ['id'] } },
        }),
        /cannot exclude primary key/,
      );
    });

    it('rejects writes to excluded columns, unlisted tables, and other users’ rows', async () => {
      const alice = await connect(ALICE, 'synced');
      await alice.client.pullSnapshot();
      const bobPublic = await backend.Todo.findOne({ where: { title: 'Bob public' } });
      const bobPrivateId = (await backend.Todo.findOne({ where: { title: 'Bob private' } }))!.get(
        'id',
      ) as string;

      const attempts: Array<{ name: string; changes: unknown[]; error: RegExp }> = [
        {
          name: 'update a public row of another user',
          changes: [
            {
              model: 'Todo',
              op: 'update',
              pk: { id: bobPublic!.get('id') },
              data: { title: 'Hacked' },
            },
          ],
          error: /not allowed to write/,
        },
        {
          name: 'update a private row of another user',
          changes: [
            { model: 'Todo', op: 'update', pk: { id: bobPrivateId }, data: { title: 'Hacked' } },
          ],
          error: /not allowed to write/,
        },
        {
          name: 'destroy a row of another user',
          changes: [{ model: 'Todo', op: 'destroy', pk: { id: bobPrivateId }, data: null }],
          error: /not allowed to write/,
        },
        {
          name: 'create a row owned by another user',
          changes: [
            {
              model: 'Todo',
              op: 'create',
              pk: { id: '0c0c0000-0000-4000-8000-000000000003' },
              data: { title: 'Planted', ownerId: BOB, done: false, public: false },
            },
          ],
          error: /not allowed to write/,
        },
        {
          name: 'create over an existing row of another user',
          changes: [
            {
              model: 'Todo',
              op: 'create',
              pk: { id: bobPrivateId },
              data: { title: 'Stolen', ownerId: ALICE },
            },
          ],
          error: /not allowed to write/,
        },
        {
          name: 'change the owner of their own row',
          changes: [
            {
              model: 'Todo',
              op: 'create',
              pk: { id: '0c0c0000-0000-4000-8000-000000000004' },
              data: { title: 'Mine', ownerId: ALICE },
            },
            {
              model: 'Todo',
              op: 'update',
              pk: { id: '0c0c0000-0000-4000-8000-000000000004' },
              data: { ownerId: BOB },
            },
          ],
          error: /not allowed to write/,
        },
        {
          name: 'write an excluded column',
          changes: [{ model: 'User', op: 'update', pk: { id: ALICE }, data: { password: 'x' } }],
          error: /not allowed to write/,
        },
        {
          name: 'write another user',
          changes: [{ model: 'User', op: 'update', pk: { id: BOB }, data: { name: 'x' } }],
          error: /not allowed to write/,
        },
        {
          name: 'write an unlisted table',
          changes: [
            {
              model: 'Session',
              op: 'create',
              pk: { id: '0c0c0000-0000-4000-8000-000000000005' },
              data: { token: 'x' },
            },
          ],
          error: /not allowed to be synced/,
        },
      ];

      for (const attempt of attempts) {
        const changeSet = {
          format: 'sequelize-lite/changes',
          version: 1,
          clientId: 'attacker',
          fromSeq: 1,
          toSeq: attempt.changes.length,
          exportedAt: new Date().toISOString(),
          changes: attempt.changes.map((change, index) => ({
            seq: index + 1,
            at: new Date().toISOString(),
            ...(change as object),
          })),
        };
        // eslint-disable-next-line no-await-in-loop -- attempts run one by one
        const error = await expectRejection(
          applyChanges(backend.server, changeSet, { models: backend.syncModels(ALICE) }),
          attempt.error,
        );
        expect(error, attempt.name).to.be.instanceOf(SyncError);
      }

      // nothing was changed
      expect(await titles(backend.Todo)).to.deep.equal(['Bob private', 'Bob public']);
      expect(await backend.Session.count()).to.equal(1);
      expect((await backend.User.findByPk(ALICE))!.get('password')).to.equal('alice-hash');
      expect((await backend.User.findByPk(BOB))!.get('name')).to.equal('Bob');

      // the same through the client: the write is rolled back on the server, and stays pending locally
      await alice.Todo.update({ title: 'Hacked' }, { where: { title: 'Bob public' } });
      await expectRejection(alice.client.pushChanges(), /not allowed to write/);
      expect(await alice.client.countPendingChanges()).to.equal(1);
      expect((await backend.Todo.findByPk(bobPublic!.get('id') as string))!.get('title')).to.equal(
        'Bob public',
      );
    });
  });
});

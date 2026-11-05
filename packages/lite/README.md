# @sequelize/lite

A lightweight, browser-side subset of Sequelize backed by [PGlite](https://pglite.dev) (Postgres compiled to WASM), for offline support.
Writes are recorded in a local change log. You export the log as a JSON blob and replay it on a regular `@sequelize/core` (Postgres) backend,
and load the backend's state back with a snapshot.

It runs in one of three [modes](#modes): `local` (front end only, never syncs), `remote` (backend only) or `synced` (local ↔ backend, the default).

- **Client** (`@sequelize/lite`): model definition, `sync`, create / read / update / destroy, hooks, validation, transactions and `Op` where clauses.
  It does not import `@sequelize/core`. It is about 24 KB gzipped, not counting PGlite.
- **Server** (`@sequelize/lite/server`): `applyChanges()` replays a change set through your real `@sequelize/core` models, in one transaction.
  `exportSnapshot()` exports the rows a user may see. Both only touch the tables, columns and rows you allow, see [Keeping data private](#keeping-data-private).

Not supported: associations / `include`, scopes, paranoid models, other dialects, and multiple sessions editing the same data. See [Limitations](#limitations).

**Contents**

- [Installation](#installation)
- [Quick start](#quick-start)
- [Connecting to PGlite](#connecting-to-pglite)
- [Defining models](#defining-models)
- [Creating the tables](#creating-the-tables)
- [Querying](#querying)
- [Updating and deleting](#updating-and-deleting)
- [Validation](#validation)
- [Hooks](#hooks)
- [Transactions](#transactions)
- [Modes](#modes)
- [Syncing to the backend](#syncing-to-the-backend)
- [Server: `applyChanges`](#server-applychanges)
- [Server: `exportSnapshot`](#server-exportsnapshot)
- [Keeping data private](#keeping-data-private)
- [Example app](#example-app)
- [Limitations](#limitations)
- [API reference](#api-reference)

## Installation

The package isn't published to npm. Build a tarball from this repository and install it in your app:

```sh
# in this repository
yarn install
node build-packages.mjs core && node build-packages.mjs lite
cd packages/lite && yarn pack --out sequelize-lite.tgz

# in your app
npm install @electric-sql/pglite /path/to/sequelize-lite.tgz
# on the backend, also:
npm install @sequelize/core@7.0.0-alpha.48 @sequelize/postgres@7.0.0-alpha.48
```

The client only needs `@electric-sql/pglite`. The server entry point (`@sequelize/lite/server`) uses your existing `@sequelize/core` instance.

## Quick start

```ts
// client
import { PGlite } from '@electric-sql/pglite';
import { DataTypes, Op, Sequelize } from '@sequelize/lite';

const sequelize = new Sequelize({ pglite: new PGlite('idb://my-app') });

const Todo = sequelize.define('Todo', {
  // synced models should use client-generated UUIDs, so ids created offline never clash with the server's
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  title: { type: DataTypes.STRING, allowNull: false, validate: { len: [1, 200] } },
  done: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
});

await sequelize.sync();

const todo = await Todo.create({ title: 'Groceries' });
await todo.update({ done: true });
const open = await Todo.findAll({ where: { done: false, title: { [Op.iLike]: '%gro%' } } });

// later, when online: send everything written since the last successful push
await sequelize.pushChanges(async changeSet => {
  const response = await fetch('/api/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(changeSet),
  });
  if (!response.ok) {
    throw new Error(`Sync failed: ${response.status}`); // changes stay pending and are sent again next time
  }

  return response.json();
});
```

```ts
// server (Express)
import { applyChanges } from '@sequelize/lite/server';

app.post('/api/sync', express.json({ limit: '5mb' }), async (req, res) => {
  try {
    res.json(await applyChanges(sequelize, req.body, { models: [Todo] }));
  } catch (error) {
    res.status(400).json({ error: error.message }); // nothing was applied
  }
});
```

## Connecting to PGlite

```ts
new Sequelize({ pglite: new PGlite('idb://my-app') }); // persisted in IndexedDB
new Sequelize({ pglite: new PGlite('opfs-ahp://my-app') }); // persisted in OPFS (inside a worker only)
new Sequelize({ pglite: new PGlite() }); // in memory, lost on reload (useful in tests)
new Sequelize({ pglite: () => PGlite.create('idb://my-app') }); // created lazily on the first query
```

`pglite` accepts anything with PGlite's `query` / `exec` / `transaction` methods, so a
[`PGliteWorker`](https://pglite.dev/docs/multi-tab-worker) should work too, but only plain `PGlite` has been tested.

Other options:

| Option           | Default              | Description                                                                         |
| ---------------- | -------------------- | ----------------------------------------------------------------------------------- |
| `logging`        | `false`              | `(sql, parameters) => void`, called for every query                                 |
| `define`         | `{}`                 | Default model options (e.g. `{ underscored: true }`)                                |
| `changeLogTable` | `_sequelize_changes` | Table where pending changes are stored                                              |
| `metaTable`      | `_sequelize_meta`    | Table where metadata is stored (currently the client id sent with every change set) |

Call `await sequelize.close()` to close the PGlite instance.

## Defining models

With `sequelize.define`:

```ts
const Note = sequelize.define(
  'Note',
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    body: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    color: DataTypes.ENUM('yellow', 'blue'),
    tags: DataTypes.ARRAY(DataTypes.TEXT),
    meta: DataTypes.JSONB,
    pinnedAt: DataTypes.DATE,
  },
  {
    tableName: 'notes',
    indexes: [{ fields: ['pinnedAt'] }],
  },
);
```

Or with a class and `Model.init`, for TypeScript types:

```ts
import { Model } from '@sequelize/lite';

interface NoteAttributes {
  id: string;
  body: string;
  pinnedAt: Date | null;
}

class Note extends Model<NoteAttributes, Partial<NoteAttributes>> {
  declare id: string;
  declare body: string;
  declare pinnedAt: Date | null;

  get isPinned() {
    return this.pinnedAt !== null;
  }
}

Note.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    body: { type: DataTypes.TEXT, allowNull: false },
    pinnedAt: DataTypes.DATE,
  },
  { sequelize },
);
```

**Attribute options:** `type`, `allowNull`, `primaryKey`, `autoIncrement`, `defaultValue` (a value, a function, `DataTypes.NOW` or
`DataTypes.UUIDV4`), `unique` (`true` or a constraint name), `field` (column name), `validate`, `get`, `set`, `references`, `onDelete`, `onUpdate`.

**Model options:** `modelName`, `tableName`, `freezeTableName`, `underscored`, `timestamps` (default `true`: adds `createdAt` / `updatedAt`),
`createdAt` / `updatedAt` (rename, or `false` to disable), `hooks`, `validate`, `indexes`, and `trackChanges` (see [Syncing](#syncing-to-the-backend)).

Table names are pluralized like in Sequelize (`Todo` → `Todos`) unless you set `tableName` or `freezeTableName`.
Without a primary key attribute, an auto-incrementing `id` is added. Don't rely on that for synced models: two clients would both create `id: 1`.

**Data types:** `STRING CHAR TEXT CITEXT SMALLINT INTEGER BIGINT FLOAT REAL DOUBLE DECIMAL BOOLEAN DATE DATEONLY TIME UUID JSON JSONB BLOB ENUM ARRAY VIRTUAL`.
`STRING(100)`, `DECIMAL(10, 2)`, `ENUM('a', 'b')` and `ARRAY(DataTypes.INTEGER)` take arguments as in Sequelize. `BLOB` values are returned as `Uint8Array`. PGlite returns `BIGINT` values as JS numbers, so values above `Number.MAX_SAFE_INTEGER` lose precision.

### Sharing models with the server

The server needs a matching `@sequelize/core` model for every synced client model, with the same model name and attribute names.
Both packages take the same attribute options, so you can write one function and call it with either package's `DataTypes`.
The server model can have extra columns (an `ownerId`, a `syncedAt`, ...). Those can only be set on the server, because changes to attributes the server model doesn't have are rejected.

## Creating the tables

```ts
await sequelize.sync(); // CREATE TABLE IF NOT EXISTS for every model
await sequelize.sync({ alter: true }); // also adds columns that are missing from existing tables
await sequelize.sync({ force: true }); // drops and recreates the tables (data and pending changes for them are lost)
await Todo.sync(); // a single model
await sequelize.drop(); // drops every model's table
```

`alter` only adds columns. To rename or drop a column, or change its type, run the SQL yourself, e.g. with `sequelize.query('ALTER TABLE ...')`.
Version your client schema, for example by storing a schema version in `localStorage` and running your own migrations before `sync()`.

## Querying

```ts
await Todo.findAll({
  where: { done: false, priority: { [Op.gte]: 2 } },
  attributes: ['id', 'title'],
  order: [['createdAt', 'DESC']],
  limit: 20,
  offset: 40,
});

await Todo.findByPk(id);
await Todo.findOne({ where: { title: 'Groceries' } });
await Todo.count({ where: { done: true } });
const { rows, count } = await Todo.findAndCountAll({ where: { done: false }, limit: 10 });
const [todo, created] = await Todo.findOrCreate({
  where: { title: 'Inbox' },
  defaults: { done: false },
});

// raw: plain objects instead of model instances
await Todo.findAll({ raw: true });
```

**Operators** (`Op.*`): `eq ne gt gte lt lte is not in notIn between notBetween like notLike iLike notILike startsWith endsWith substring
regexp iRegexp overlap contains contained and or`.
They are the same symbols as `@sequelize/core`'s `Op` (`Symbol.for('gt')`, ...), so a where object built for one works with the other.

```ts
await Todo.findAll({
  where: {
    [Op.or]: [{ done: true }, { title: { [Op.startsWith]: 'Urgent' } }],
    tags: { [Op.contains]: ['work'] },
    dueAt: { [Op.between]: [from, to] },
    deletedAt: null, // IS NULL
  },
});
```

Raw SQL is available with `sequelize.query(sql, parameters)`, which returns PGlite's result (`{ rows, affectedRows, fields }`).
Writes made with raw SQL are not recorded in the change log.

## Updating and deleting

```ts
// instances
todo.title = 'New title';
todo.changed(); // ['title']
await todo.save();
await todo.update({ done: true });
await todo.reload();
await todo.destroy();

// many rows at once
await Todo.update({ done: true }, { where: { done: false } });
await Todo.destroy({ where: { done: true } });
await Todo.bulkCreate([{ title: 'a' }, { title: 'b' }]);
```

Static `update` / `destroy` record one change per affected row. Each row is sent to the server on its own, so the server's
instance hooks run for each one.

## Validation

Validation runs before every `create`, `save` and `update`, then the server validates the change again when it is applied.

```ts
const User = sequelize.define(
  'User',
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    email: { type: DataTypes.STRING, allowNull: false, unique: true, validate: { isEmail: true } },
    age: { type: DataTypes.INTEGER, validate: { min: 0, max: 150 } },
    username: {
      type: DataTypes.STRING,
      validate: {
        len: { args: [3, 20], msg: 'Username must be 3 to 20 characters' },
        notAdmin(value: string) {
          if (value === 'admin') {
            throw new Error('Reserved username');
          }
        },
      },
    },
    startsAt: DataTypes.DATE,
    endsAt: DataTypes.DATE,
  },
  {
    validate: {
      // model validators see the whole instance
      endsAfterStart(this: any) {
        if (this.startsAt && this.endsAt && this.endsAt < this.startsAt) {
          throw new Error('endsAt must be after startsAt');
        }
      },
    },
  },
);

try {
  await User.create({ email: 'not-an-email' });
} catch (error) {
  if (error instanceof ValidationError) {
    for (const item of error.errors) {
      console.log(item.path, item.validatorKey, item.message); // 'email', 'isEmail', 'Validation isEmail on email failed'
    }
  }
}
```

Built-in validators: `allowNull` and data type checks, plus the common validator.js ones: `is matches not notRegex isEmail isUrl isIP isIPv4
isIPv6 isAlpha isAlphanumeric isNumeric isInt isFloat isDecimal isHexColor isLowercase isUppercase isUUID isDate isAfter isBefore isArray contains
notContains equals notEmpty len isIn notIn min max`. Validators can be async.
You can also call `await instance.validate()` yourself. Use `{ validate: false }` on `create` / `save` / `update` to skip validation.

Unique and foreign key violations are reported by PGlite, as `UniqueConstraintError` / `ForeignKeyConstraintError`.

## Hooks

```ts
const Todo = sequelize.define('Todo', attributes, {
  hooks: {
    beforeSave(todo) {
      todo.title = todo.title.trim();
    },
  },
});

Todo.addHook('afterCreate', 'notify', todo => showToast(`Added ${todo.title}`));
Todo.beforeDestroy(async todo => {
  if (todo.locked) {
    throw new Error('Locked todos cannot be deleted'); // aborts the destroy
  }
});
Todo.removeHook('afterCreate', 'notify');
```

Available hooks: `beforeValidate afterValidate validationFailed beforeCreate afterCreate beforeUpdate afterUpdate beforeSave afterSave
beforeDestroy afterDestroy beforeBulkCreate afterBulkCreate beforeBulkUpdate afterBulkUpdate beforeBulkDestroy afterBulkDestroy beforeFind
afterFind beforeCount beforeSync afterSync`.

Like in Sequelize, the bulk methods (`bulkCreate`, static `update` and `destroy`) only run the `*Bulk*` hooks. Pass `individualHooks: true`
to also run the instance hooks for each row. `{ hooks: false }` skips all hooks for a call.

Client hooks only run on the client. When a change is applied on the server, the **server** model's hooks run.

## Transactions

```ts
// managed: committed when the callback resolves, rolled back if it throws
await sequelize.transaction(async transaction => {
  const list = await List.create({ name: 'Trip' }, { transaction });
  await Todo.bulkCreate([{ listId: list.id, title: 'Passport' }], { transaction });
});

// unmanaged
const transaction = await sequelize.transaction();
transaction.afterCommit(() => console.log('saved'));
try {
  await Todo.create({ title: 'a' }, { transaction });
  await transaction.commit();
} catch (error) {
  await transaction.rollback();
  throw error;
}
```

Change log entries are written in the same transaction as the data, so a rolled-back write is never synced.
PGlite has a single connection, so queries made while a managed transaction callback is running use that transaction even without the
`transaction` option. Passing it explicitly is still clearer.

## Modes

```ts
const remote = {
  async push(changeSet) {
    const response = await fetch('/api/sync', {
      method: 'POST',
      body: JSON.stringify(changeSet),
      headers,
    });
    if (!response.ok) throw new Error(await response.text());
  },
  async pull() {
    const response = await fetch('/api/snapshot', { headers });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  },
};

new Sequelize({ pglite: new PGlite('idb://app'), mode: 'local' }); // front end only
new Sequelize({ pglite: new PGlite(), mode: 'remote', remote }); // backend only
new Sequelize({ pglite: new PGlite('idb://app'), mode: 'synced', remote }); // local <-> backend (default mode)
```

| Mode               | Source of truth | Writes                                                                                                     | Restoring state                                                                                             |
| ------------------ | --------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `local`            | PGlite          | Local only. Nothing is recorded, `exportChanges` / `pushChanges` / `pullSnapshot` throw.                   | Reopen the same persistent PGlite (`idb://...`).                                                            |
| `remote`           | Backend         | Each transaction is sent to `remote.push` before it commits locally. If the push fails, it is rolled back. | `sync()` loads the backend's state from `remote.pull`. Use an in-memory PGlite.                             |
| `synced` (default) | Both            | Local, recorded in the change log, sent later with `pushChanges()`.                                        | Reopen the same persistent PGlite (data and pending changes are kept), or `pullSnapshot()` on a new device. |

- `remote` mode needs both `remote.push` and `remote.pull`. It still uses PGlite as its query engine, so the same models, hooks and validation run on the
  client, then the server runs its own. It does not work offline: writes fail when the backend can't be reached. Call `pullSnapshot()` again to pick up
  changes made elsewhere.
- In `synced` mode, `remote` is optional and only provides the defaults for `pushChanges()` and `pullSnapshot()`.

## Syncing to the backend

### How it works

1. Every `create`, `update`, `save`, `destroy` and bulk write adds rows to the `_sequelize_changes` table, in the same transaction as the write.
2. `exportChanges()` reads the pending rows into a JSON-serializable **change set**. This doesn't remove anything.
3. You send the change set to your backend however you like (`fetch`, a WebSocket, a background sync queue...).
4. The backend replays it with `applyChanges()`, all or nothing.
5. Once the backend has confirmed, `acknowledgeChanges(changeSet)` deletes the rows that were sent.
   Changes made while the request was in flight are kept for the next push.

`pushChanges(send)` does steps 2 to 5 for you. It returns `null` if there was nothing to send, otherwise whatever `send` returned.
If `send` throws, nothing is acknowledged.

```ts
async function sync() {
  if (!navigator.onLine) {
    return;
  }

  try {
    await sequelize.pushChanges(async changeSet => {
      const response = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(changeSet),
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }

      return response.json();
    });
  } catch (error) {
    // offline, server down or a change was rejected: everything is still pending, try again later
    console.warn('sync failed', error);
  }

  updatePendingBadge(await sequelize.countPendingChanges());
}

window.addEventListener('online', sync);
setInterval(sync, 60_000);
```

**Retries are safe.** If the server applied a change set but the response was lost, the client sends it again. The server handles this:
a `create` for a row that already exists becomes an update, and a `destroy` of a missing row is ignored. Two overlapping pushes are safe for the same reason,
but it's simpler to not start a push while one is running.

**A rejected change blocks the queue.** If the server rejects one change (failed validation, a hook throwing, `transform` throwing), the whole change set is
rolled back and every change stays pending. Retrying sends it again and fails the same way. Validate on the client with the same rules as the server, and
decide what to do with changes the server will never accept: fix the row locally (the fix is merged into the pending change, see below), skip it on the server
with `transform`, or `discardChanges()` as a last resort.

### Doing it in steps

```ts
const changeSet = await sequelize.exportChanges();
if (changeSet.changes.length > 0) {
  await sendSomehow(changeSet);
  await sequelize.acknowledgeChanges(changeSet); // or acknowledgeChanges(changeSet.toSeq)
}
```

Other methods: `countPendingChanges()`, `getPendingChanges()` (the raw, un-merged log), `getClientId()` and `discardChanges()` (deletes all pending changes without sending them).

### Merging changes

By default, the changes to each row are merged before they are exported:

| Pending changes for a row  | Exported as                        |
| -------------------------- | ---------------------------------- |
| create, update, update     | one create with the final values   |
| update, update             | one update with all changed fields |
| update, destroy            | destroy                            |
| create, ..., destroy       | nothing                            |
| destroy, create (same key) | destroy, then create               |

This sends less data, and the server never sees in-between states. Without merging, a row created with an invalid title and fixed afterwards would fail on the server.
`exportChanges({ coalesce: false })` / `pushChanges(send, { coalesce: false })` exports every change as it was made.
Use `{ limit: 500 }` to send a large backlog in several requests.

### Local-only data

Data that should never be sent to the server (caches, UI state, drafts) can opt out of change tracking:

```ts
sequelize.define('Draft', attributes, { trackChanges: false }); // for a whole model
await Todo.update({ seen: true }, { where: { seen: false }, trackChanges: false }); // for a single call
```

Use the same `trackChanges: false` when you save data that came _from_ the server, so it isn't sent back.

### Loading the server's state

`pullSnapshot(fetchSnapshot?)` fetches a snapshot created by [`exportSnapshot`](#server-exportsnapshot) (default: `remote.pull`) and loads it with
`applySnapshot(snapshot)`, in one transaction:

```ts
await sequelize.pushChanges(); // send local changes first
const { restored, preserved } = await sequelize.pullSnapshot();
```

- Each model in the snapshot is replaced with the snapshot's rows. Rows that are not in the snapshot are deleted locally.
- Rows with **pending local changes are kept as they are** (including pending deletes), so offline edits are not lost. They are sent with the next push.
- Models that are not in the snapshot (local-only models, for example) are left untouched. Columns the client model doesn't define are ignored. A model
  the client doesn't define is an error.
- No hooks or validations run, and nothing is added to the change log. Timestamps are kept as they are on the server.
- Client columns that the snapshot doesn't include get their default value, so they must be nullable or have a default (or the client model should use
  `timestamps: false` if the server doesn't export them).

### Change set format

```json
{
  "format": "sequelize-lite/changes",
  "version": 1,
  "clientId": "1c3e6f0a-…",
  "fromSeq": 1,
  "toSeq": 3,
  "exportedAt": "2026-11-04T01:00:00.000Z",
  "changes": [
    {
      "seq": 2,
      "model": "Todo",
      "op": "create",
      "pk": { "id": "a1…" },
      "data": {
        "id": "a1…",
        "title": "Groceries",
        "done": true,
        "createdAt": "…",
        "updatedAt": "…"
      },
      "at": "2026-11-04T00:59:12.000Z"
    },
    {
      "seq": 3,
      "model": "Todo",
      "op": "update",
      "pk": { "id": "b2…" },
      "data": { "done": true, "updatedAt": "…" },
      "at": "…"
    },
    { "seq": 1, "model": "Todo", "op": "destroy", "pk": { "id": "c3…" }, "data": null, "at": "…" }
  ]
}
```

- `model` is the client model name. `pk` and `data` use attribute names (not column names).
- `create` has every attribute, `update` only the changed ones, `destroy` has `data: null`.
- `clientId` is a random UUID generated once per database and stored in `_sequelize_meta`.
- Values are made JSON-safe: dates become ISO strings, `bigint`s strings, and `BLOB`s `{ "$bytes": "<base64>" }`. `applyChanges` decodes them.

## Server: `applyChanges`

```ts
import { DataTypes, Sequelize } from '@sequelize/core';
import { PostgresDialect } from '@sequelize/postgres';
import { applyChanges } from '@sequelize/lite/server';

const sequelize = new Sequelize({ dialect: PostgresDialect, url: process.env.DATABASE_URL });

const Todo = sequelize.define('Todo', {
  id: { type: DataTypes.UUID, primaryKey: true },
  title: { type: DataTypes.STRING, allowNull: false, validate: { len: [1, 200] } },
  done: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  ownerId: { type: DataTypes.UUID, allowNull: false },
  internalNotes: DataTypes.TEXT, // server-only
});

// what the logged-in user may read and write, see "Keeping data private"
const syncModels = user => ({
  Todo: { model: Todo, exclude: ['internalNotes'], where: { ownerId: user.id } },
});

app.post('/api/sync', requireUser, express.json({ limit: '5mb' }), async (req, res) => {
  try {
    res.json(await applyChanges(sequelize, req.body, { models: syncModels(req.user) }));
  } catch (error) {
    res
      .status(error.name === 'SequelizeValidationError' ? 422 : 400)
      .json({ error: error.message });
  }
});
```

What `applyChanges` does:

- It checks the change set's shape and format version first. Anything else is rejected.
- Changes are applied in order, in a single transaction, through the server models (`create`, `instance.update`, `instance.destroy`), so server
  hooks and validation run. If one change fails, nothing is applied and the error is thrown.
- Only models listed in `models` can be written to. A change to another model, to an attribute the server model doesn't have or the config doesn't allow,
  or to a row outside of `writeWhere`, rejects the whole change set with a `SyncError`.

Options:

| Option        | Default  | Description                                                                                                                                                                                                                                               |
| ------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `models`      | required | The models clients can write to: `[Todo, 'Note']`, a map from client model name to server model (`{ Todo: ServerTodo }`) when the names differ, or a map to [sync configs](#keeping-data-private) (`{ Todo: { model: Todo, exclude, where } }`).          |
| `transform`   |          | `(change, { model, existing, transaction, changeSet }) => change \| null \| false`, can be async. Called before each change with the current server row (or `null`). Return a modified change, `null`/`false` to skip it, or throw to reject all of them. |
| `onMissing`   | `'skip'` | What to do with an `update` for a row that doesn't exist on the server (deleted elsewhere, or never synced): `'skip'`, `'create'` (create it from the partial data) or `'error'`.                                                                         |
| `transaction` |          | Run inside your own transaction instead of a new one, e.g. to also write an audit log.                                                                                                                                                                    |
| `hooks`       | `true`   | Run the server models' hooks.                                                                                                                                                                                                                             |
| `validate`    | `true`   | Run the server models' validations.                                                                                                                                                                                                                       |

`transform` gets the change as sent, so its values are still JSON-encoded (dates are ISO strings).

The result is JSON-serializable. You can send it back to the client:

```json
{
  "clientId": "1c3e…",
  "toSeq": 3,
  "applied": 2,
  "skipped": 1,
  "results": [
    { "seq": 2, "model": "Todo", "op": "create", "pk": { "id": "a1…" }, "status": "created" }
  ]
}
```

`status` is one of `created`, `updated`, `destroyed`, `skipped` (by `transform`) or `missing` (update or destroy of a row that doesn't exist).

### Resolving conflicts

There are no automatic conflict rules: the last change applied wins. If the same rows can also be changed elsewhere (another device, an admin UI),
decide in `transform`. For example, to keep the newer version of each row:

```ts
await applyChanges(sequelize, changeSet, {
  models: [Todo],
  transform(change, { existing }) {
    if (
      existing &&
      change.data?.updatedAt &&
      new Date(change.data.updatedAt as string) < existing.get('updatedAt')
    ) {
      return null; // the server's version is newer
    }

    return change;
  },
});
```

## Server: `exportSnapshot`

```ts
import { exportSnapshot } from '@sequelize/lite/server';

app.get('/api/snapshot', requireUser, async (req, res) => {
  res.json(await exportSnapshot(sequelize, { models: syncModels(req.user) }));
});
```

`exportSnapshot(sequelize, { models, transaction? })` reads every listed model in one transaction and returns a JSON-serializable snapshot:

```json
{
  "format": "sequelize-lite/snapshot",
  "version": 1,
  "exportedAt": "2026-11-05T18:00:00.000Z",
  "models": { "Todo": [{ "id": "a1…", "title": "Groceries", "done": false, "ownerId": "u1…" }] }
}
```

Values are encoded like in change sets. Snapshots contain all rows the user may see, so for large tables narrow them down with `where`.

## Keeping data private

Both `applyChanges` and `exportSnapshot` take the same `models` option. Build it per request, so it can depend on the logged-in user,
and use it for both endpoints:

```ts
import { Op } from '@sequelize/core';

const syncModels = user => ({
  Todo: {
    model: Todo,
    exclude: ['internalNotes'],
    where: { [Op.or]: [{ ownerId: user.id }, { public: true }] }, // rows the user can read
    writeWhere: { ownerId: user.id }, // rows the user can write
  },
  User: {
    model: User,
    attributes: ['name', 'avatarUrl', 'email'],
    transform: (row, { instance }) =>
      instance.get('id') === user.id ? row : { ...row, email: null },
  },
  // Session, AuditLog, ... are not listed, so they are never read or written
});
```

| Config       | Read (`exportSnapshot`)                                                                                                                                  | Write (`applyChanges`)                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `models`     | Only listed models are exported.                                                                                                                         | Changes to other models are rejected.                                                                      |
| `attributes` | Allow-list: only these columns (and the primary key) are selected.                                                                                       | Changes to other attributes are rejected.                                                                  |
| `exclude`    | All columns except these are selected.                                                                                                                   | Changes to these attributes are rejected.                                                                  |
| `where`      | Only matching rows are selected (in SQL, other rows are never loaded).                                                                                   | Used as `writeWhere` if that isn't set.                                                                    |
| `writeWhere` |                                                                                                                                                          | The row must match before an update / destroy, and after a create / update, or the change set is rejected. |
| `transform`  | `(row, { model, instance, transaction })`: change or hide values per row (return `null` to leave the row out). It can't add columns that aren't allowed. | Not used. Use the `transform` option of `applyChanges` instead.                                            |

- `exportSnapshot` requires `attributes` or `exclude` for every model, so a column added later (like `password`) is not exported by accident.
  Use `exclude: []` to export every column.
- Unknown attribute names in `attributes` / `exclude` (a typo like `pasword`) throw, and the primary key can't be excluded.
- `writeWhere` is checked after the write too, so a client can't create a row for another user or move its own row to another user.
- A row a user can read is not automatically writable: with the config above, other users' public todos can be read but not changed.

## Example app

[`example/`](./example) is a small offline todo app: the client stores todos in PGlite in IndexedDB, and a Node server applies the changes to Postgres.

```sh
# from the repository root, with Postgres running
yarn install && node build-packages.mjs core && node build-packages.mjs postgres && node build-packages.mjs lite
cd packages/lite
PGUSER=postgres PGPASSWORD=postgres PGDATABASE=postgres yarn example
# open http://localhost:4321
```

Add todos, switch the browser offline in dev tools and keep editing, then go back online and click **Sync to server**.
The server column shows what reached Postgres, with a `syncedAt` value set by a server hook.

## Limitations

- **Snapshots, not incremental pulls.** `pullSnapshot()` downloads every row the user may see, not just what changed since the last pull.
- **`remote` mode doesn't work offline**, and each write is a request to the backend.
- **No automatic conflict handling.** The last change applied wins, unless you decide otherwise in `transform`.
- **Rejected changes block the queue** until the row is fixed, the change is skipped on the server, or the changes are discarded.
- **Schema changes:** `sync({ alter: true })` only adds columns.
- **Single session:** one tab or worker should own the database. Two tabs opening the same `idb://` database at once isn't supported.
- **Not implemented:** associations / `include`, scopes, paranoid models, `increment` / `decrement`, `upsert`, aggregate functions, and other dialects.

## API reference

**`Sequelize`**: `mode`, `define`, `isDefined`, `model`, `models`, `sync`, `drop`, `transaction`, `query`, `close`, `getPGlite`, `exportChanges`, `pushChanges`,
`acknowledgeChanges`, `countPendingChanges`, `getPendingChanges`, `getClientId`, `discardChanges`, `pullSnapshot`, `applySnapshot`.

**`Model` (static)**: `init`, `build`, `create`, `bulkCreate`, `findAll`, `findOne`, `findByPk`, `findOrCreate`, `findAndCountAll`, `count`, `update`,
`destroy`, `sync`, `drop`, `addHook`, `removeHook`, `hasHook`, and a shortcut for each hook (`Model.beforeCreate(fn)`, ...).

**`Model` (instance)**: `get`, `set`, `save`, `update`, `destroy`, `reload`, `validate`, `changed`, `previous`, `toJSON`, `isNewRecord`, `dataValues`.

**Errors**: `BaseError`, `ValidationError` (with `errors: ValidationErrorItem[]`), `DatabaseError`, `UniqueConstraintError`, `ForeignKeyConstraintError`, `EmptyResultError`, `SyncError`.

**Change helpers**: `coalesceChanges`, `encodeValue`, `decodeValue`, `assertSnapshot`, `CHANGE_SET_FORMAT`, `CHANGE_SET_VERSION`, `SNAPSHOT_FORMAT`, `SNAPSHOT_VERSION`.

**`@sequelize/lite/server`**: `applyChanges(sequelize, changeSet, options)`, `exportSnapshot(sequelize, options)`, `assertChangeSet(value)`.

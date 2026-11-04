# @sequelize/lite

A lightweight, browser-side subset of Sequelize backed by [PGlite](https://pglite.dev) (Postgres in WASM), for offline support.
Writes are recorded in a local change log, which can be exported as a JSON blob and replayed on a regular `@sequelize/core` (Postgres) backend.

It does **not** import `@sequelize/core` and only supports PGlite. Supported: model definition, `sync`, create / read / update / destroy,
hooks, validation, transactions and `Op` where clauses. Not supported: associations / includes, scopes, raw SQL builders, other dialects,
multiple concurrent sessions.

## Client

```ts
import { PGlite } from '@electric-sql/pglite';
import { DataTypes, Op, Sequelize } from '@sequelize/lite';

const sequelize = new Sequelize({ pglite: new PGlite('idb://my-app') });

const Todo = sequelize.define(
  'Todo',
  {
    // use client-generated UUIDs for synced models, so ids don't clash with the server's
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    title: { type: DataTypes.STRING, allowNull: false, validate: { len: [1, 200] } },
    done: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    tags: DataTypes.ARRAY(DataTypes.TEXT),
    meta: DataTypes.JSONB,
  },
  {
    hooks: {
      beforeSave(todo) {
        todo.title = todo.title.trim();
      },
    },
  },
);

await sequelize.sync(); // or sync({ alter: true }) to add new columns

const todo = await Todo.create({ title: 'Groceries' });
await todo.update({ done: true });
await Todo.findAll({
  where: { done: false, title: { [Op.iLike]: '%gro%' } },
  order: [['createdAt', 'DESC']],
});
await Todo.destroy({ where: { done: true } });
```

`pglite` can also be a `PGliteWorker`, or a function returning a (promise of a) PGlite instance.

### Supported API

- `sequelize.define`, `Model.init`, `sequelize.sync({ force, alter })`, `sequelize.drop()`, `sequelize.transaction()` (managed & unmanaged), `sequelize.query()`
- Static: `build`, `create`, `bulkCreate`, `findAll`, `findOne`, `findByPk`, `findOrCreate`, `findAndCountAll`, `count`, `update`, `destroy`
- Instance: `get`, `set`, `save`, `update`, `destroy`, `reload`, `validate`, `changed`, `previous`, `toJSON`
- Find options: `where`, `attributes`, `order`, `limit`, `offset`, `raw`
- Operators: `eq ne gt gte lt lte is not in notIn between notBetween like notLike iLike notILike startsWith endsWith substring regexp iRegexp overlap contains contained and or` (plus their negations)
- Hooks: `beforeValidate afterValidate validationFailed beforeCreate afterCreate beforeUpdate afterUpdate beforeSave afterSave beforeDestroy afterDestroy beforeBulkCreate afterBulkCreate beforeBulkUpdate afterBulkUpdate beforeBulkDestroy afterBulkDestroy beforeFind afterFind beforeCount beforeSync afterSync`,
  through the `hooks` model option, `Model.addHook`, or `Model.beforeCreate(...)` etc. `individualHooks` is supported on bulk operations.
- Validation: `allowNull`, data type checks, the common validator.js validators (`isEmail`, `isUrl`, `isUUID`, `len`, `min`, `max`, `isIn`, `notEmpty`, `is`, ...),
  custom attribute validators and model validators. Failures throw a `ValidationError` like Sequelize's.
- Data types: `STRING CHAR TEXT CITEXT SMALLINT INTEGER BIGINT FLOAT REAL DOUBLE DECIMAL BOOLEAN DATE DATEONLY TIME UUID JSON JSONB BLOB ENUM ARRAY VIRTUAL`

## Sync

Every write made through the models is recorded in the `_sequelize_changes` table, in the same transaction as the write itself.
Pass `trackChanges: false` as a model option (or per call) for local-only data.

```ts
// send pending changes to the backend; they are only removed once `send` resolves
await sequelize.pushChanges(async changeSet => {
  const response = await fetch('/api/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(changeSet),
  });
  if (!response.ok) {
    throw new Error(`Sync failed: ${response.status}`);
  }

  return response.json();
});
```

Or do it in steps with `exportChanges()` and `acknowledgeChanges(changeSet)`. By default, changes to the same row are merged
(a create followed by updates becomes a single create, a create followed by a destroy disappears).
Use `exportChanges({ coalesce: false })` to get every individual change.

A change set looks like this:

```json
{
  "format": "sequelize-lite/changes",
  "version": 1,
  "clientId": "1c3e…",
  "fromSeq": 1,
  "toSeq": 3,
  "exportedAt": "2026-11-04T01:00:00.000Z",
  "changes": [
    {
      "seq": 2,
      "model": "Todo",
      "op": "create",
      "pk": { "id": "a1…" },
      "data": { "id": "a1…", "title": "Groceries", "done": true },
      "at": "…"
    },
    { "seq": 3, "model": "Todo", "op": "destroy", "pk": { "id": "b2…" }, "data": null, "at": "…" }
  ]
}
```

## Server

```ts
import { Sequelize } from '@sequelize/core';
import { applyChanges } from '@sequelize/lite/server';

app.post('/api/sync', async (req, res) => {
  const result = await applyChanges(sequelize, req.body, {
    // only these models can be written to by clients
    models: [Todo],
    // optional: authorize / rewrite / skip changes (return null to skip)
    transform(change, { existing }) {
      if (existing && existing.get('ownerId') !== req.user.id) {
        return null;
      }

      return { ...change, data: { ...change.data, ownerId: req.user.id } };
    },
  });

  res.json(result);
});
```

`applyChanges` replays the changes, in order, in a single transaction, through the server models: server-side hooks and validations run,
and if any change fails nothing is applied (and the client keeps its changes). Applying the same change set twice is safe:
creates of rows that already exist become updates, and destroys of missing rows are ignored.
Updates of rows that don't exist are skipped by default (`onMissing: 'skip' | 'create' | 'error'`).
Changes to models that are not in `models`, or to attributes the server model doesn't have, are rejected.

---
name: sequelize-lite-offline-first-sync
description: How to build an app with @sequelize/lite that works fully offline in the browser (PGlite in IndexedDB), saves to a @sequelize/core Postgres backend when online, and keeps working when the connection drops and comes back. Use when adding offline support, an offline-first data layer, or local <-> backend sync to a project that uses (or wants) Sequelize on the server.
---

# Offline-first apps with @sequelize/lite

The app reads and writes a local Postgres (PGlite, persisted in IndexedDB) through a Sequelize-like API. Every write is
recorded in a local change log. When the app is online, it **pushes** the log to the backend, which replays it through the
real `@sequelize/core` models (hooks + validation run), and **pulls** a snapshot of the rows the user may see.
The full reference is the package README (`node_modules/@sequelize/lite/README.md`); this file is the recipe.

## 1. Pick the mode

| The app...                                                       | Mode               |
| ---------------------------------------------------------------- | ------------------ |
| must keep working offline and save online when it can            | `synced` (default) |
| is never online / data must never leave the device               | `local`            |
| is always online and the backend must accept each write directly | `remote`           |

For "works offline, saved online, goes back online", use **`synced`**, and use it **from the first launch**, even
before the user has an account. `local` mode records nothing, so data written in `local` mode can never be pushed later.

## 2. Client setup

```ts
import { PGlite } from '@electric-sql/pglite';
import { DataTypes, Sequelize } from '@sequelize/lite';

class SyncHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const db = new Sequelize({
  pglite: new PGlite('idb://my-app'), // persisted: survives reloads and offline restarts
  mode: 'synced',
  remote: {
    async push(changeSet) {
      const response = await fetch('/api/sync/push', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify(changeSet),
      });
      if (!response.ok) throw new SyncHttpError(response.status, await response.text());
      return response.json();
    },
    async pull() {
      const response = await fetch('/api/sync/snapshot', { headers: authHeaders() });
      if (!response.ok) throw new SyncHttpError(response.status, await response.text());
      return response.json();
    },
  },
});

export const Todo = db.define('Todo', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 }, // always client-generated UUIDs
  title: { type: DataTypes.STRING, allowNull: false, validate: { len: [1, 200] } },
  done: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  ownerId: { type: DataTypes.UUID, allowNull: true }, // unknown until the user logs in, set by the server
});

// UI state, caches, drafts: never synced
export const Draft = db.define(
  'Draft',
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    text: DataTypes.TEXT,
  },
  { trackChanges: false },
);

await db.sync(); // creates missing tables; existing data and pending changes are kept
```

Rules for client models:

- **Primary keys are client-generated UUIDs** (`DataTypes.UUIDV4`). Auto-increment ids collide between devices and the server.
- **Every attribute a client model has must be writable on the server** (allowed by the server config below, timestamps
  included). Otherwise every push is rejected.
- Mirror the server's validation on the client, so invalid data is caught while the user is still on the form.
  A change the server rejects blocks the whole queue (see 5).
- Only the subset of Sequelize is available: CRUD, `Op` where clauses, order/limit/offset, hooks, validation, transactions.
  No associations / `include`, scopes, paranoid, `upsert`, `increment`. Model relations by storing foreign key columns
  and querying each model separately.

## 3. Server endpoints

Define **one per-request config** and use it for both endpoints. Nothing outside it is ever read or written.

```ts
import { Op } from '@sequelize/core';
import { applyChanges, exportSnapshot } from '@sequelize/lite/server';

const syncModels = user => ({
  Todo: {
    model: Todo,
    exclude: ['internalNotes'], // or attributes: [...]; required for snapshots
    where: { [Op.or]: [{ ownerId: user.id }, { public: true }] }, // rows the user may read
    writeWhere: { ownerId: user.id }, // rows the user may write (checked before and after each write)
  },
  User: {
    model: User,
    attributes: ['name', 'avatarUrl'], // never `password`, tokens, ...
    where: { id: user.id },
  },
  // tables that are not listed (Session, AuditLog, ...) are never sent or written
});

app.post('/api/sync/push', requireUser, express.json({ limit: '5mb' }), async (req, res) => {
  try {
    const result = await applyChanges(sequelize, req.body, {
      models: syncModels(req.user),
      // rows created before login have no owner: the server decides who owns them
      transform: change =>
        change.op === 'create'
          ? { ...change, data: { ...change.data, ownerId: req.user.id } }
          : change,
    });
    res.json(result);
  } catch (error) {
    // 422 = this change set will never be accepted as-is; 5xx = try again later
    res
      .status(
        error.name === 'SequelizeValidationError' || error.name === 'SequelizeLiteSyncError'
          ? 422
          : 500,
      )
      .json({ error: error.message });
  }
});

app.get('/api/sync/snapshot', requireUser, async (req, res) => {
  res.json(await exportSnapshot(sequelize, { models: syncModels(req.user) }));
});
```

Server rules:

- Always build `syncModels` from the **authenticated** user, never from anything in the request body.
- Use `attributes` (allow-list) for tables with sensitive columns, so a column added later is not exported by accident.
- `writeWhere` is also checked after the write, so clients cannot create rows for other users or reassign their own rows.
  Readable is not writable: public rows of other users can be read but not changed.
- Server hooks and validations run on every replayed change. Server-only columns (e.g. `syncedAt`) can be set in hooks.
- Replays are idempotent: re-sending the same change set (lost response) is safe.

## 4. The online/offline loop

```ts
let syncing: Promise<void> | null = null;
// 4xx (except 401/408/429) won't succeed by retrying; network errors and 5xx will
const isPermanent = (error: unknown) =>
  error instanceof SyncHttpError &&
  error.status >= 400 &&
  error.status < 500 &&
  ![401, 408, 429].includes(error.status);

export function syncNow() {
  syncing ??= (async () => {
    try {
      if (!navigator.onLine || !isLoggedIn()) return;
      await db.pushChanges(); // 1. save local changes online (acknowledged only on success)
      await db.pullSnapshot(); // 2. bring the device up to date (rows with pending local changes are kept)
      setStatus({ state: 'synced', at: new Date() });
    } catch (error) {
      setStatus({ state: isPermanent(error) ? 'needs-attention' : 'offline', error });
    } finally {
      setStatus({ pending: await db.countPendingChanges() });
      syncing = null;
    }
  })();

  return syncing;
}

window.addEventListener('online', syncNow); // back online
document.addEventListener(
  'visibilitychange',
  () => document.visibilityState === 'visible' && syncNow(),
);
setInterval(syncNow, 60_000);
onLogin(syncNow); // first save online: everything written offline/anonymously is pushed now
```

- **Always push before pulling.** A pull keeps rows with pending changes, but pushing first means the snapshot already
  contains them.
- Never run two syncs at once (the `syncing` guard). Writes made during a push stay pending for the next one.
- Writes never wait for the network: the UI writes to `db` and re-renders from `db`. Show the pending count (`countPendingChanges()`)
  as "not saved online yet".
- On a new device or after logout/login as someone else: wipe local data first (`await db.discardChanges()` then
  `await db.sync({ force: true })`; `sync({ force })` alone keeps the change log), or use a new `idb://` name per user.
  Then `pullSnapshot()`.

## 5. Errors

| Error from push                                  | Meaning                                         | Do                                                                                      |
| ------------------------------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| network error / 5xx                              | offline or server down                          | nothing, changes stay pending, retried by the loop                                      |
| 401                                              | session expired                                 | re-authenticate, then `syncNow()`                                                       |
| 422 `ValidationError`                            | the server rejects a value                      | show it; fix the row locally (the fix is merged into the pending change) and sync again |
| 422 `SyncError` (not allowed, unknown attribute) | client and server config disagree, or forbidden | a bug: fix the model/config. As a last resort `db.discardChanges()` + `pullSnapshot()`  |

The whole change set is all-or-nothing: until the bad change is fixed, nothing else is saved online.
For conflicts (same row edited on two devices), the last push wins; decide otherwise in `applyChanges`' `transform`
(e.g. compare `updatedAt` with the existing row).

## 6. Tests to write

- Reopen the same PGlite data dir (`new PGlite(dir)` in Node) and check data **and** `countPendingChanges()` survive.
- Offline writes, then `pushChanges()` against a real Postgres `applyChanges` endpoint: rows arrive, pending count is 0.
- A fresh client + `pullSnapshot()` restores the same rows.
- A pending local edit survives `pullSnapshot()` and is pushed afterwards.
- With two users: user B's private rows, excluded columns and unlisted tables never appear in user A's snapshot JSON,
  and A's change sets touching B's rows are rejected.
- A push that fails (throw in `push`) leaves everything pending.

## Pitfalls

- Raw `db.query()` writes are not recorded; use model methods for anything that must be saved online.
- PGlite returns `BIGINT` as JS numbers (precision loss above 2^53); prefer UUID / INTEGER / DECIMAL.
- `sync({ alter: true })` only adds columns. Changing the client schema of already-installed apps needs a manual migration.
- One tab should own the database: two tabs on the same `idb://` database at once aren't supported (use a leader tab or `PGliteWorker`).
- Snapshots contain every row the user may read, not only changes; narrow with `where` for big tables.
- `remote` mode doesn't work offline; don't use it for this kind of app.

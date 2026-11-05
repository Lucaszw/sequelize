import type { ChangeRecord, ChangeSet, Snapshot } from './changes.js';
import {
  assertSnapshot,
  CHANGE_SET_FORMAT,
  CHANGE_SET_VERSION,
  coalesceChanges,
  decodeValues,
} from './changes.js';
import { SyncError, wrapDatabaseError } from './errors.js';
import type { ModelAttributes, ModelOptions } from './model-definition.js';
import type { Model, ModelStatic } from './model.js';
import { Model as BaseModel } from './model.js';
import { quoteIdentifier } from './sql.js';
import type { PGliteLike, PGliteQueryable, PGliteQueryResult } from './transaction.js';
import { Transaction } from './transaction.js';

/**
 * - `local`: data only lives in PGlite. Nothing is recorded or synced.
 * - `remote`: the backend is the source of truth. PGlite (usually in-memory) is loaded from `remote.pull` on `sync()`,
 *   and every transaction is sent to `remote.push` before it commits locally, so rejected writes are rolled back.
 * - `synced` (default): data lives in PGlite and works offline. Writes are recorded and sent with `pushChanges()`,
 *   server state is loaded with `pullSnapshot()`.
 */
export type SequelizeMode = 'local' | 'remote' | 'synced';

export interface RemoteOptions {
  /** Sends a change set to the backend, e.g. a `fetch` to an endpoint calling `applyChanges` */
  push?(changeSet: ChangeSet): unknown;
  /** Fetches a snapshot from the backend, e.g. a `fetch` to an endpoint calling `exportSnapshot` */
  pull?(): unknown;
}

export interface SnapshotResult {
  /** Rows written from the snapshot */
  restored: number;
  /** Rows kept as-is because they have pending local changes */
  preserved: number;
}

export interface SequelizeOptions {
  /** A PGlite instance (or PGliteWorker), or a function that creates one */
  pglite: PGliteLike | (() => PGliteLike | Promise<PGliteLike>);
  /** See {@link SequelizeMode}. Default `synced` */
  mode?: SequelizeMode;
  /** How to reach the backend. Required in `remote` mode, optional defaults for `pushChanges` / `pullSnapshot` */
  remote?: RemoteOptions;
  /** Called with every SQL query. Default: no logging */
  logging?: false | ((sql: string, parameters: readonly unknown[]) => void);
  /** Default options for all models */
  define?: Omit<ModelOptions, 'modelName' | 'tableName' | 'hooks' | 'validate' | 'indexes'>;
  /** Name of the table where changes are recorded. Default `_sequelize_changes` */
  changeLogTable?: string;
  /** Name of the table where metadata (like the client id) is stored. Default `_sequelize_meta` */
  metaTable?: string;
}

export interface QueryOptions {
  transaction?: Transaction | null | undefined;
}

export interface SyncOptions extends QueryOptions {
  /** Drop tables before creating them */
  force?: boolean;
  /** Add missing columns to existing tables */
  alter?: boolean;
  hooks?: boolean;
}

export interface ExportChangesOptions {
  /**
   * Merge changes made to the same row into a single change. See {@link coalesceChanges}.
   * This avoids replaying intermediate states (which the server may consider invalid). Default true
   */
  coalesce?: boolean;
  /** Maximum amount of change log entries to include */
  limit?: number;
}

export interface PushChangesOptions extends ExportChangesOptions {}

interface ChangeLogRow {
  seq: number;
  model: string;
  op: ChangeRecord['op'];
  pk: Record<string, unknown>;
  data: Record<string, unknown> | null;
  created_at: Date;
}

export class Sequelize {
  readonly options: Readonly<SequelizeOptions>;
  readonly models: Record<string, ModelStatic<any>> = Object.create(null);
  readonly #pgliteOption: SequelizeOptions['pglite'];
  #pglite: Promise<PGliteLike> | undefined;
  #activeTransaction: Transaction | undefined;
  #clientId: string | undefined;

  constructor(options: SequelizeOptions) {
    if (!options?.pglite) {
      throw new Error('The "pglite" option is required');
    }

    const mode = options.mode ?? 'synced';
    if (!['local', 'remote', 'synced'].includes(mode)) {
      throw new Error(`Unknown mode "${String(mode)}"`);
    }

    if (mode === 'remote' && (!options.remote?.push || !options.remote.pull)) {
      throw new Error('The "remote" mode requires the "remote.push" and "remote.pull" options');
    }

    this.options = options;
    this.#pgliteOption = options.pglite;
  }

  get mode(): SequelizeMode {
    return this.options.mode ?? 'synced';
  }

  #assertSyncable(method: string) {
    if (this.mode === 'local') {
      throw new SyncError(`${method} is not available in "local" mode`);
    }
  }

  async #pushInTransaction(transaction: Transaction) {
    if (this.mode !== 'remote') {
      return;
    }

    const changeSet = await this.exportChanges({ transaction });
    if (changeSet.toSeq === 0) {
      return;
    }

    await this.options.remote!.push!(changeSet);
    await this.acknowledgeChanges(changeSet, { transaction });
  }

  get changeLogTable(): string {
    return this.options.changeLogTable ?? '_sequelize_changes';
  }

  get metaTable(): string {
    return this.options.metaTable ?? '_sequelize_meta';
  }

  async getPGlite(): Promise<PGliteLike> {
    this.#pglite ??= Promise.resolve(
      typeof this.#pgliteOption === 'function' ? this.#pgliteOption() : this.#pgliteOption,
    );

    return this.#pglite;
  }

  define<M extends Model = Model>(
    modelName: string,
    attributes: ModelAttributes<M['_attributes']>,
    options: ModelOptions = {},
  ): ModelStatic<M> {
    const model = class extends BaseModel {};
    Object.defineProperty(model, 'name', { value: modelName });

    return model.init(attributes, { ...options, modelName, sequelize: this }) as any;
  }

  model<M extends Model = Model>(modelName: string): ModelStatic<M> {
    const model = this.models[modelName];
    if (!model) {
      throw new Error(`${modelName} has not been defined`);
    }

    return model;
  }

  isDefined(modelName: string): boolean {
    return modelName in this.models;
  }

  /**
   * Runs a raw SQL query with $1, $2… bind parameters
   *
   * @param sql
   * @param parameters
   * @param options
   */
  async query<T = any>(
    sql: string,
    parameters: readonly unknown[] = [],
    options: QueryOptions = {},
  ): Promise<PGliteQueryResult<T>> {
    const connection = await this.#connection(options);

    if (this.options.logging) {
      this.options.logging(sql, parameters);
    }

    try {
      return await connection.query<T>(sql, [...parameters]);
    } catch (error) {
      throw wrapDatabaseError(error, sql, parameters);
    }
  }

  async #connection(options: QueryOptions): Promise<PGliteQueryable> {
    const transaction = options.transaction ?? this.#activeTransaction;
    if (transaction) {
      if (transaction.finished) {
        throw new Error(
          `This transaction has already finished (${transaction.finished}) and cannot be used anymore`,
        );
      }

      return transaction.connection;
    }

    return this.getPGlite();
  }

  /**
   * Starts a transaction.
   *
   * PGlite has a single connection, so while a transaction is running, queries that do not specify a transaction
   * automatically run inside it (like @sequelize/core with CLS enabled). Calling `transaction()` while a transaction
   * is running reuses that transaction.
   */
  async transaction(): Promise<Transaction>;
  async transaction<T>(callback: (transaction: Transaction) => Promise<T>): Promise<T>;
  async transaction<T>(
    callback?: (transaction: Transaction) => Promise<T>,
  ): Promise<T | Transaction> {
    if (!callback) {
      return this.#startUnmanagedTransaction();
    }

    if (this.#activeTransaction) {
      return callback(this.#activeTransaction);
    }

    const pglite = await this.getPGlite();
    let transaction: Transaction | undefined;
    let result: T;

    try {
      result = await pglite.transaction(async connection => {
        transaction = new Transaction(connection);
        this.#activeTransaction = transaction;
        try {
          const callbackResult = await callback(transaction);
          await this.#pushInTransaction(transaction);

          return callbackResult;
        } finally {
          this.#activeTransaction = undefined;
        }
      });
    } catch (error) {
      await transaction?._finish('rollback');
      throw error;
    }

    await transaction!._finish('commit');

    return result;
  }

  async #startUnmanagedTransaction(): Promise<Transaction> {
    if (this.#activeTransaction) {
      throw new Error('PGlite only supports one transaction at a time, and one is already running');
    }

    const pglite = await this.getPGlite();
    const rollbackSignal = new Error('Transaction rolled back');

    return new Promise<Transaction>((resolveTransaction, rejectTransaction) => {
      let settle!: (outcome: 'commit' | 'rollback') => void;
      const settled = new Promise<'commit' | 'rollback'>(resolve => {
        settle = resolve;
      });

      let transaction: Transaction | undefined;
      const done = pglite
        .transaction(async connection => {
          transaction = new Transaction(connection);
          this.#activeTransaction = transaction;
          transaction._setUnmanaged(async outcome => {
            settle(outcome);
            await done;
          });
          resolveTransaction(transaction);

          const outcome = await settled;
          try {
            if (outcome === 'rollback') {
              // rejecting makes PGlite roll back
              throw rollbackSignal;
            }

            await this.#pushInTransaction(transaction);
          } finally {
            this.#activeTransaction = undefined;
          }
        })
        .then(
          async () => transaction!._finish('commit'),
          async error => {
            this.#activeTransaction = undefined;
            if (!transaction) {
              rejectTransaction(error);

              return;
            }

            await transaction._finish('rollback');
            if (error !== rollbackSignal) {
              throw error;
            }
          },
        );
    });
  }

  /**
   * @param options
   * @param callback
   * @internal Runs the callback in the given transaction, the running transaction, or a new one
   */
  async _withTransaction<T>(
    options: QueryOptions,
    callback: (transaction: Transaction) => Promise<T>,
  ): Promise<T> {
    const transaction = options.transaction ?? this.#activeTransaction;
    if (transaction) {
      return callback(transaction);
    }

    return this.transaction(callback);
  }

  /**
   * Creates the tables of all defined models, plus the change log tables.
   * In `remote` mode, also loads the backend's state with {@link pullSnapshot}.
   *
   * @param options
   */
  async sync(options: SyncOptions = {}): Promise<this> {
    await this.#syncInternalTables(options);

    for (const model of Object.values(this.models)) {
      // eslint-disable-next-line no-await-in-loop -- tables are created in definition order, for foreign keys
      await model.sync(options);
    }

    if (this.mode === 'remote') {
      await this.pullSnapshot(undefined, options);
    }

    return this;
  }

  async #syncInternalTables(options: QueryOptions) {
    await this.query(
      `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(this.changeLogTable)} (
  "seq" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "model" TEXT NOT NULL,
  "op" TEXT NOT NULL,
  "pk" JSONB NOT NULL,
  "data" JSONB,
  "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
)`,
      [],
      options,
    );
    await this.query(
      `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(this.metaTable)} ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL)`,
      [],
      options,
    );
  }

  /**
   * Drops the tables of all defined models (in reverse definition order)
   *
   * @param options
   */
  async drop(options: QueryOptions = {}): Promise<void> {
    for (const model of Object.values(this.models).reverse()) {
      // eslint-disable-next-line no-await-in-loop -- reverse order, for foreign keys
      await model.drop(options);
    }
  }

  async close(): Promise<void> {
    const pglite = await this.#pglite;
    if (pglite && !pglite.closed) {
      await pglite.close?.();
    }
  }

  /**
   * @param entries
   * @param transaction
   * @internal
   */
  async _recordChanges(
    entries: ReadonlyArray<Omit<ChangeRecord, 'seq' | 'at'>>,
    transaction: Transaction,
  ): Promise<void> {
    if (entries.length === 0 || this.mode === 'local') {
      return;
    }

    const parameters: unknown[] = [];
    const rows = entries.map(entry => {
      parameters.push(
        entry.model,
        entry.op,
        JSON.stringify(entry.pk),
        entry.data === null ? null : JSON.stringify(entry.data),
      );
      const offset = parameters.length - 4;

      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`;
    });

    await this.query(
      `INSERT INTO ${quoteIdentifier(this.changeLogTable)} ("model", "op", "pk", "data") VALUES ${rows.join(', ')}`,
      parameters,
      { transaction },
    );
  }

  /**
   * A random id that identifies this database, generated on first use
   *
   * @param options
   */
  async getClientId(options: QueryOptions = {}): Promise<string> {
    if (this.#clientId) {
      return this.#clientId;
    }

    const table = quoteIdentifier(this.metaTable);
    const { rows } = await this.query<{ value: string }>(
      `INSERT INTO ${table} ("key", "value") VALUES ('clientId', $1)
ON CONFLICT ("key") DO UPDATE SET "key" = EXCLUDED."key"
RETURNING "value"`,
      [crypto.randomUUID()],
      options,
    );

    this.#clientId = rows[0].value;

    return this.#clientId;
  }

  /**
   * Changes recorded since the last acknowledged change set, oldest first
   *
   * @param options
   */
  async getPendingChanges(
    options: { limit?: number } & QueryOptions = {},
  ): Promise<ChangeRecord[]> {
    const parameters: unknown[] = [];
    let sql = `SELECT "seq", "model", "op", "pk", "data", "created_at" FROM ${quoteIdentifier(this.changeLogTable)} ORDER BY "seq" ASC`;
    if (options.limit !== undefined) {
      parameters.push(options.limit);
      sql += ' LIMIT $1';
    }

    const { rows } = await this.query<ChangeLogRow>(sql, parameters, options);

    return rows.map(row => ({
      seq: Number(row.seq),
      model: row.model,
      op: row.op,
      pk: row.pk,
      data: row.data,
      at: new Date(row.created_at).toISOString(),
    }));
  }

  async countPendingChanges(options: QueryOptions = {}): Promise<number> {
    const { rows } = await this.query<{ count: number }>(
      `SELECT count(*)::int AS "count" FROM ${quoteIdentifier(this.changeLogTable)}`,
      [],
      options,
    );

    return rows[0].count;
  }

  /**
   * Exports pending changes as a JSON-serializable change set,
   * to be applied on the backend using `applyChanges` from `@sequelize/lite/server`.
   *
   * Changes stay pending until {@link acknowledgeChanges} is called.
   *
   * @param options
   */
  async exportChanges(options: ExportChangesOptions & QueryOptions = {}): Promise<ChangeSet> {
    this.#assertSyncable('exportChanges');
    const changes = await this.getPendingChanges(options);
    const clientId = await this.getClientId(options);

    return {
      format: CHANGE_SET_FORMAT,
      version: CHANGE_SET_VERSION,
      clientId,
      fromSeq: changes[0]?.seq ?? 0,
      toSeq: changes.at(-1)?.seq ?? 0,
      exportedAt: new Date().toISOString(),
      changes: options.coalesce === false ? changes : coalesceChanges(changes),
    };
  }

  /**
   * Removes changes up to (and including) the change set's `toSeq` from the change log
   *
   * @param changeSetOrSeq
   * @param options
   */
  async acknowledgeChanges(
    changeSetOrSeq: ChangeSet | number,
    options: QueryOptions = {},
  ): Promise<number> {
    const toSeq = typeof changeSetOrSeq === 'number' ? changeSetOrSeq : changeSetOrSeq.toSeq;
    const result = await this.query(
      `DELETE FROM ${quoteIdentifier(this.changeLogTable)} WHERE "seq" <= $1`,
      [toSeq],
      options,
    );

    return result.affectedRows ?? 0;
  }

  /**
   * Exports pending changes, passes them to `send` (e.g. a `fetch` to your backend),
   * and acknowledges them once `send` resolves. If `send` throws, changes stay pending.
   *
   * Returns `null` if there was nothing to send, or the value returned by `send`.
   *
   * @param send Defaults to the `remote.push` option
   * @param options
   */
  async pushChanges<T = unknown>(
    send?: (changeSet: ChangeSet) => Promise<T> | T,
    options: PushChangesOptions = {},
  ): Promise<T | null> {
    this.#assertSyncable('pushChanges');
    const sender = send ?? (this.options.remote?.push as ((changeSet: ChangeSet) => T) | undefined);
    if (!sender) {
      throw new SyncError('pushChanges requires a send function or the "remote.push" option');
    }

    const changeSet = await this.exportChanges(options);
    if (changeSet.toSeq === 0) {
      return null;
    }

    const result = await sender(changeSet);
    await this.acknowledgeChanges(changeSet);

    return result;
  }

  /**
   * Fetches a snapshot of the backend (created with `exportSnapshot` from `@sequelize/lite/server`) and loads it with
   * {@link applySnapshot}.
   *
   * @param fetchSnapshot Defaults to the `remote.pull` option
   * @param options
   */
  async pullSnapshot(
    fetchSnapshot?: () => unknown,
    options: QueryOptions = {},
  ): Promise<SnapshotResult> {
    this.#assertSyncable('pullSnapshot');
    const pull = fetchSnapshot ?? this.options.remote?.pull;
    if (!pull) {
      throw new SyncError('pullSnapshot requires a fetch function or the "remote.pull" option');
    }

    return this.applySnapshot(await pull(), options);
  }

  /**
   * Replaces the local rows of every model in the snapshot with the snapshot's rows, in one transaction.
   * Rows with pending local changes are kept, so offline edits are not lost. Models that are not in the snapshot
   * (like local-only models) are left untouched. Attributes the client does not define are ignored.
   *
   * No hooks or validations run, and nothing is recorded in the change log.
   *
   * @param snapshot
   * @param options
   */
  async applySnapshot(
    snapshot: Snapshot | unknown,
    options: QueryOptions = {},
  ): Promise<SnapshotResult> {
    this.#assertSyncable('applySnapshot');
    assertSnapshot(snapshot);

    for (const name of Object.keys(snapshot.models)) {
      if (!this.isDefined(name)) {
        throw new SyncError(
          `Snapshot contains model "${name}", which is not defined on the client`,
        );
      }
    }

    return this._withTransaction(options, async transaction => {
      const pending = await this.getPendingChanges({ transaction });
      const result: SnapshotResult = { restored: 0, preserved: 0 };

      for (const [name, rows] of Object.entries(snapshot.models)) {
        const preserve = pending
          .filter(change => change.model === name)
          .map(change => decodeValues(change.pk));
        result.preserved += new Set(preserve.map(pk => JSON.stringify(pk))).size;
        // eslint-disable-next-line no-await-in-loop -- models are restored in order, in one transaction
        result.restored += await this.models[name]._replaceRows(
          rows.map(row => decodeValues(row)),
          preserve,
          transaction,
        );
      }

      return result;
    });
  }

  /**
   * Deletes all pending changes without exporting them
   *
   * @param options
   */
  async discardChanges(options: QueryOptions = {}): Promise<void> {
    await this.query(`DELETE FROM ${quoteIdentifier(this.changeLogTable)}`, [], options);
  }
}

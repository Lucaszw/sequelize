export interface PGliteQueryResult<T = any> {
  rows: T[];
  affectedRows?: number;
}

/** The subset of the PGlite API used by @sequelize/lite. Satisfied by `PGlite` and `PGliteWorker`. */
export interface PGliteQueryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<PGliteQueryResult<T>>;
  exec(sql: string): Promise<unknown>;
}

export interface PGliteTransactionLike extends PGliteQueryable {
  rollback(): Promise<void>;
}

export interface PGliteLike extends PGliteQueryable {
  transaction<T>(callback: (tx: PGliteTransactionLike) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
  readonly closed?: boolean;
}

export type TransactionCallback = (transaction: Transaction) => unknown;

export class Transaction {
  readonly connection: PGliteTransactionLike;
  readonly #afterCommit: TransactionCallback[] = [];
  readonly #afterRollback: TransactionCallback[] = [];
  #finished: 'commit' | 'rollback' | undefined;
  #settle: ((outcome: 'commit' | 'rollback') => Promise<void>) | undefined;

  /**
   * @param connection
   * @internal
   */
  constructor(connection: PGliteTransactionLike) {
    this.connection = connection;
  }

  get finished(): 'commit' | 'rollback' | undefined {
    return this.#finished;
  }

  afterCommit(callback: TransactionCallback): this {
    this.#afterCommit.push(callback);

    return this;
  }

  afterRollback(callback: TransactionCallback): this {
    this.#afterRollback.push(callback);

    return this;
  }

  /** Commits an unmanaged transaction */
  async commit(): Promise<void> {
    await this.#settleUnmanaged('commit');
  }

  /** Rolls back an unmanaged transaction */
  async rollback(): Promise<void> {
    await this.#settleUnmanaged('rollback');
  }

  async #settleUnmanaged(outcome: 'commit' | 'rollback') {
    if (!this.#settle) {
      throw new Error(
        'commit() and rollback() can only be called on unmanaged transactions. Managed transactions are committed when their callback resolves.',
      );
    }

    if (this.#finished) {
      throw new Error(
        `Transaction cannot be ${outcome === 'commit' ? 'committed' : 'rolled back'} because it already finished with state: ${this.#finished}`,
      );
    }

    await this.#settle(outcome);
  }

  /**
   * @param settle
   * @internal
   */
  _setUnmanaged(settle: (outcome: 'commit' | 'rollback') => Promise<void>) {
    this.#settle = settle;
  }

  /**
   * @param outcome
   * @internal
   */
  async _finish(outcome: 'commit' | 'rollback') {
    this.#finished = outcome;
    for (const callback of outcome === 'commit' ? this.#afterCommit : this.#afterRollback) {
      // eslint-disable-next-line no-await-in-loop -- callbacks run sequentially
      await callback(this);
    }
  }
}

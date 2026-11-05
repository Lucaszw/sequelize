export class BaseError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SequelizeBaseError';
  }
}

export type ValidationErrorItemType =
  'notNull violation' | 'unique violation' | 'Validation error' | 'custom validation error';

export class ValidationErrorItem {
  readonly message: string;
  readonly type: ValidationErrorItemType;
  readonly path: string | null;
  readonly value: unknown;
  readonly validatorKey: string | null;
  readonly validatorArgs: unknown[];
  readonly instance: unknown;

  constructor(
    message: string,
    type: ValidationErrorItemType,
    path: string | null,
    value: unknown,
    instance: unknown,
    validatorKey: string | null = null,
    validatorArgs: unknown[] = [],
  ) {
    this.message = message;
    this.type = type;
    this.path = path;
    this.value = value;
    this.instance = instance;
    this.validatorKey = validatorKey;
    this.validatorArgs = validatorArgs;
  }
}

export class ValidationError extends BaseError {
  readonly errors: ValidationErrorItem[];

  constructor(
    message: string | undefined,
    errors: ValidationErrorItem[] = [],
    options?: ErrorOptions,
  ) {
    super(
      message ??
        (errors.length > 0
          ? `Validation error: ${errors.map(error => error.message).join(',\n')}`
          : 'Validation error'),
      options,
    );
    this.name = 'SequelizeValidationError';
    this.errors = errors;
  }

  /**
   * Returns the validation error items for the given attribute
   *
   * @param path
   */
  get(path: string): ValidationErrorItem[] {
    return this.errors.filter(error => error.path === path);
  }
}

export class DatabaseError extends BaseError {
  readonly sql: string;
  readonly parameters: readonly unknown[];
  readonly code: string | undefined;

  constructor(cause: unknown, sql: string, parameters: readonly unknown[]) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'SequelizeDatabaseError';
    this.sql = sql;
    this.parameters = parameters;
    this.code = (cause as { code?: string } | null)?.code;
  }
}

export class UniqueConstraintError extends DatabaseError {
  constructor(cause: unknown, sql: string, parameters: readonly unknown[]) {
    super(cause, sql, parameters);
    this.name = 'SequelizeUniqueConstraintError';
  }
}

export class ForeignKeyConstraintError extends DatabaseError {
  constructor(cause: unknown, sql: string, parameters: readonly unknown[]) {
    super(cause, sql, parameters);
    this.name = 'SequelizeForeignKeyConstraintError';
  }
}

export class EmptyResultError extends BaseError {
  constructor(message?: string) {
    super(message);
    this.name = 'SequelizeEmptyResultError';
  }
}

export class SyncError extends BaseError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SequelizeLiteSyncError';
  }
}

export function wrapDatabaseError(error: unknown, sql: string, parameters: readonly unknown[]) {
  const code = (error as { code?: string } | null)?.code;
  if (code === '23505') {
    return new UniqueConstraintError(error, sql, parameters);
  }

  if (code === '23503') {
    return new ForeignKeyConstraintError(error, sql, parameters);
  }

  return new DatabaseError(error, sql, parameters);
}

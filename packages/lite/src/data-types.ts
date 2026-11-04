import isUUID from 'validator/lib/isUUID';

const NativeJSON = globalThis.JSON;

export interface DataType {
  readonly key: string;
  /** VIRTUAL attributes are not stored in the database */
  readonly virtual?: boolean;
  toSql(): string;
  /** Returns an error message if the value is not valid for this type */
  validate(value: unknown): string | undefined;
  /** Normalizes values passed to `instance.set()` */
  sanitize(value: unknown): unknown;
  /** Converts a JS value to a value accepted by PGlite as a bind parameter */
  toBindParameter(value: unknown): unknown;
  /** Converts a value returned by PGlite */
  parse(value: unknown): unknown;
}

export type DataTypeFactory<Args extends unknown[]> = DataType & ((...args: Args) => DataType);

export type DataTypeInput = DataType | DataTypeFactory<any[]> | string;

interface TypeDefinition {
  key: string;
  sql: string;
  virtual?: boolean;
  validate?(value: unknown): string | undefined;
  sanitize?(value: unknown): unknown;
  toBindParameter?(value: unknown): unknown;
  parse?(value: unknown): unknown;
}

const identity = (value: unknown) => value;

function createType(definition: TypeDefinition): DataType {
  return {
    key: definition.key,
    virtual: definition.virtual ?? false,
    toSql: () => definition.sql,
    validate: definition.validate ?? (() => undefined),
    sanitize: definition.sanitize ?? identity,
    toBindParameter: definition.toBindParameter ?? identity,
    parse: definition.parse ?? identity,
  };
}

function factory<Args extends unknown[]>(
  build: (...args: Args) => DataType,
): DataTypeFactory<Args> {
  // @ts-expect-error -- calling with no arguments gives the default variant of the type
  const defaultType = build();

  const callable = (...args: Args) => build(...args);

  return Object.assign(callable, defaultType);
}

function invalid(value: unknown, typeName: string): string {
  return `${formatValue(value)} is not a valid ${typeName}`;
}

function formatValue(value: unknown): string {
  try {
    return typeof value === 'string'
      ? `'${value}'`
      : (NativeJSON.stringify(value) ?? String(value));
  } catch {
    return String(value);
  }
}

function isValidNumber(value: unknown): boolean {
  if (typeof value === 'number') {
    return !Number.isNaN(value);
  }

  if (typeof value === 'bigint') {
    return true;
  }

  return typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value));
}

function isValidInteger(value: unknown): boolean {
  if (typeof value === 'bigint') {
    return true;
  }

  if (typeof value === 'number') {
    return Number.isInteger(value);
  }

  return typeof value === 'string' && /^-?\d+$/.test(value);
}

function isValidDate(value: unknown): boolean {
  if (value instanceof Date) {
    return !Number.isNaN(value.getTime());
  }

  if (typeof value === 'string' || typeof value === 'number') {
    return !Number.isNaN(new Date(value).getTime());
  }

  return false;
}

function stringType(key: string, sqlName: string, length: number | undefined) {
  return createType({
    key,
    sql: length === undefined ? sqlName : `${sqlName}(${length})`,
    validate: value => (typeof value === 'string' ? undefined : invalid(value, 'string')),
  });
}

function integerType(key: string, sql: string) {
  return createType({
    key,
    sql,
    validate: value => (isValidInteger(value) ? undefined : invalid(value, key.toLowerCase())),
    toBindParameter: value => (typeof value === 'bigint' ? value.toString() : value),
  });
}

function numberType(key: string, sql: string) {
  return createType({
    key,
    sql,
    validate: value => (isValidNumber(value) ? undefined : invalid(value, key.toLowerCase())),
    toBindParameter: value => (typeof value === 'bigint' ? value.toString() : value),
  });
}

function jsonType(key: string, sql: string) {
  return createType({
    key,
    sql,
    // stringify, otherwise PGlite would serialize JS arrays as Postgres arrays
    toBindParameter: value => NativeJSON.stringify(value),
  });
}

function toDateOnly(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  return value;
}

export const STRING = factory((length: number = 255) => stringType('STRING', 'VARCHAR', length));
export const CHAR = factory((length: number = 255) => stringType('CHAR', 'CHAR', length));
export const TEXT = factory(() => stringType('TEXT', 'TEXT', undefined));
export const CITEXT = factory(() => stringType('CITEXT', 'CITEXT', undefined));
export const SMALLINT = factory(() => integerType('SMALLINT', 'SMALLINT'));
export const INTEGER = factory(() => integerType('INTEGER', 'INTEGER'));
export const BIGINT = factory(() => integerType('BIGINT', 'BIGINT'));
export const FLOAT = factory(() => numberType('FLOAT', 'REAL'));
export const REAL = factory(() => numberType('REAL', 'REAL'));
export const DOUBLE = factory(() => numberType('DOUBLE', 'DOUBLE PRECISION'));
export const DECIMAL = factory((precision?: number, scale?: number) =>
  numberType(
    'DECIMAL',
    precision === undefined
      ? 'NUMERIC'
      : `NUMERIC(${precision}${scale === undefined ? '' : `, ${scale}`})`,
  ),
);

export const BOOLEAN = factory(() =>
  createType({
    key: 'BOOLEAN',
    sql: 'BOOLEAN',
    validate: value => (typeof value === 'boolean' ? undefined : invalid(value, 'boolean')),
    sanitize(value) {
      if (value === 'true' || value === 1 || value === '1') {
        return true;
      }

      if (value === 'false' || value === 0 || value === '0') {
        return false;
      }

      return value;
    },
  }),
);

export const DATE = factory((precision?: number) =>
  createType({
    key: 'DATE',
    sql:
      precision === undefined
        ? 'TIMESTAMP WITH TIME ZONE'
        : `TIMESTAMP(${precision}) WITH TIME ZONE`,
    validate: value => (isValidDate(value) ? undefined : invalid(value, 'date')),
    sanitize(value) {
      if ((typeof value === 'string' || typeof value === 'number') && isValidDate(value)) {
        return new Date(value);
      }

      return value;
    },
  }),
);

export const DATEONLY = factory(() =>
  createType({
    key: 'DATEONLY',
    sql: 'DATE',
    validate(value) {
      return isValidDate(value) && typeof value !== 'number' ? undefined : invalid(value, 'date');
    },
    sanitize: toDateOnly,
    parse: toDateOnly,
  }),
);

export const TIME = factory(() =>
  createType({
    key: 'TIME',
    sql: 'TIME',
    validate: value => (typeof value === 'string' ? undefined : invalid(value, 'time')),
  }),
);

export const UUID = factory(() =>
  createType({
    key: 'UUID',
    sql: 'UUID',
    validate(value) {
      return typeof value === 'string' && isUUID(value) ? undefined : invalid(value, 'uuid');
    },
  }),
);

export const JSON = factory(() => jsonType('JSON', 'JSON'));
export const JSONB = factory(() => jsonType('JSONB', 'JSONB'));

export const BLOB = factory(() =>
  createType({
    key: 'BLOB',
    sql: 'BYTEA',
    validate: value => (value instanceof Uint8Array ? undefined : invalid(value, 'blob')),
  }),
);

export const ENUM = factory(
  (...values: Array<string | readonly string[] | { values: readonly string[] }>) => {
    const allowed: string[] = values.flatMap(value => {
      if (typeof value === 'string') {
        return [value];
      }

      if (Array.isArray(value)) {
        return value as string[];
      }

      return [...(value as { values: readonly string[] }).values];
    });

    // stored as TEXT + check constraint (added by sync) to avoid managing Postgres enum types
    return Object.assign(
      createType({
        key: 'ENUM',
        sql: 'TEXT',
        validate(value) {
          if (typeof value === 'string' && allowed.includes(value)) {
            return undefined;
          }

          return `${formatValue(value)} is not a valid choice for enum [ ${allowed.map(v => `'${v}'`).join(', ')} ]`;
        },
      }),
      { values: allowed },
    );
  },
);

export const ARRAY = factory((itemType: DataTypeInput = TEXT) => {
  const item = normalizeDataType(itemType);

  return createType({
    key: 'ARRAY',
    sql: `${item.toSql()}[]`,
    validate(value) {
      if (!Array.isArray(value)) {
        return invalid(value, 'array');
      }

      for (const entry of value) {
        if (entry == null) {
          continue;
        }

        const error = item.validate(entry);
        if (error) {
          return error;
        }
      }

      return undefined;
    },
    toBindParameter(value) {
      return Array.isArray(value) ? value.map(entry => item.toBindParameter(entry)) : value;
    },
    parse: value => (Array.isArray(value) ? value.map(entry => item.parse(entry)) : value),
  });
});

export const VIRTUAL = factory(() =>
  createType({
    key: 'VIRTUAL',
    sql: '',
    virtual: true,
  }),
);

const DEFAULT_VALUE_MARKER = Symbol('sequelize-lite.default-value');

export interface DefaultValueMarker {
  readonly [DEFAULT_VALUE_MARKER]: 'NOW' | 'UUIDV4';
  readonly key: 'NOW' | 'UUIDV4';
}

/** Use as `defaultValue` to default to the current date */
export const NOW: DefaultValueMarker = { [DEFAULT_VALUE_MARKER]: 'NOW', key: 'NOW' };
/** Use as `defaultValue` to generate a random UUID v4 in the client */
export const UUIDV4: DefaultValueMarker = { [DEFAULT_VALUE_MARKER]: 'UUIDV4', key: 'UUIDV4' };

export function isDefaultValueMarker(value: unknown): value is DefaultValueMarker {
  return typeof value === 'object' && value !== null && DEFAULT_VALUE_MARKER in value;
}

export function normalizeDataType(input: DataTypeInput): DataType {
  if (typeof input === 'string') {
    return createType({ key: input, sql: input });
  }

  if (typeof input === 'function') {
    return input();
  }

  return input;
}

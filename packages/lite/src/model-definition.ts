import type { DataType, DataTypeInput, DefaultValueMarker } from './data-types.js';
import { DATE, INTEGER, normalizeDataType } from './data-types.js';
import type { HookCallback, ModelHookName } from './hooks.js';
import type { AttributeValidateOptions, ModelValidateOptions } from './validation.js';

export type ReferentialAction = 'CASCADE' | 'RESTRICT' | 'SET NULL' | 'SET DEFAULT' | 'NO ACTION';

export interface AttributeOptions {
  type: DataTypeInput;
  allowNull?: boolean;
  primaryKey?: boolean;
  autoIncrement?: boolean;
  /** A static value, a function, or `DataTypes.NOW` / `DataTypes.UUIDV4` */
  defaultValue?: unknown | DefaultValueMarker | (() => unknown);
  /** `true`, or the name of a (possibly composite) unique constraint */
  unique?: boolean | string;
  /** The column name. Defaults to the attribute name (snake_cased if the model is underscored) */
  field?: string;
  validate?: AttributeValidateOptions;
  get?(this: any): unknown;
  set?(this: any, value: any): void;
  references?: { table: string; key?: string };
  onDelete?: ReferentialAction;
  onUpdate?: ReferentialAction;
}

export type ModelAttributes<TAttributes = any> = {
  [K in keyof TAttributes]?: AttributeOptions | DataTypeInput;
};

export interface IndexOptions {
  name?: string;
  fields: string[];
  unique?: boolean;
}

export type ModelHooksOption = Partial<Record<ModelHookName, HookCallback | HookCallback[]>>;

export interface ModelOptions {
  modelName?: string;
  tableName?: string;
  /** Use the model name as the table name instead of pluralizing it */
  freezeTableName?: boolean;
  /** Use snake_case column names */
  underscored?: boolean;
  /** Adds createdAt & updatedAt attributes. Default true */
  timestamps?: boolean;
  createdAt?: string | boolean;
  updatedAt?: string | boolean;
  hooks?: ModelHooksOption;
  validate?: ModelValidateOptions;
  indexes?: IndexOptions[];
  /**
   * Whether writes to this model are recorded in the change log & included in exported change sets.
   * Set to false for local-only tables (caches, UI state...). Default true.
   */
  trackChanges?: boolean;
}

export interface NormalizedAttribute {
  readonly name: string;
  readonly field: string;
  readonly type: DataType;
  readonly allowNull: boolean;
  readonly primaryKey: boolean;
  readonly autoIncrement: boolean;
  readonly defaultValue: unknown;
  readonly hasDefaultValue: boolean;
  readonly unique: boolean | string;
  readonly validate: AttributeValidateOptions | undefined;
  readonly get: ((this: any) => unknown) | undefined;
  readonly set: ((this: any, value: any) => void) | undefined;
  readonly references: { table: string; key?: string } | undefined;
  readonly onDelete: ReferentialAction | undefined;
  readonly onUpdate: ReferentialAction | undefined;
}

export function underscore(name: string): string {
  return name
    .replaceAll(/([a-z\d])([A-Z])/g, '$1_$2')
    .replaceAll(/([A-Z]+)([A-Z][a-z\d]+)/g, '$1_$2')
    .toLowerCase();
}

export function pluralize(name: string): string {
  if (/[^aeiou]y$/i.test(name)) {
    return `${name.slice(0, -1)}ies`;
  }

  if (/(?:s|x|z|ch|sh)$/i.test(name)) {
    return `${name}es`;
  }

  return `${name}s`;
}

function isAttributeOptions(value: AttributeOptions | DataTypeInput): value is AttributeOptions {
  return typeof value === 'object' && value !== null && 'type' in value && !('toSql' in value);
}

export class ModelDefinition {
  readonly modelName: string;
  readonly table: string;
  readonly attributes = new Map<string, NormalizedAttribute>();
  readonly columns = new Map<string, NormalizedAttribute>();
  readonly primaryKeys: readonly string[];
  readonly createdAtAttribute: string | undefined;
  readonly updatedAtAttribute: string | undefined;
  readonly options: Readonly<ModelOptions>;
  readonly trackChanges: boolean;

  constructor(modelName: string, rawAttributes: ModelAttributes, options: ModelOptions) {
    this.modelName = modelName;
    this.options = options;
    this.trackChanges = options.trackChanges ?? true;

    const underscored = options.underscored ?? false;
    this.table =
      options.tableName ??
      (options.freezeTableName
        ? modelName
        : pluralize(underscored ? underscore(modelName) : modelName));

    const entries = Object.entries(rawAttributes).filter(
      (entry): entry is [string, AttributeOptions | DataTypeInput] => entry[1] !== undefined,
    );

    const hasPrimaryKey = entries.some(
      ([, attribute]) => isAttributeOptions(attribute) && attribute.primaryKey,
    );
    if (!hasPrimaryKey) {
      entries.unshift([
        'id',
        { type: INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      ]);
    }

    const timestamps = options.timestamps ?? true;
    const timestampName = (option: string | boolean | undefined, defaultName: string) => {
      if (!timestamps || option === false) {
        return undefined;
      }

      return typeof option === 'string' ? option : defaultName;
    };

    this.createdAtAttribute = timestampName(options.createdAt, 'createdAt');
    this.updatedAtAttribute = timestampName(options.updatedAt, 'updatedAt');

    for (const timestamp of [this.createdAtAttribute, this.updatedAtAttribute]) {
      if (timestamp && !entries.some(([name]) => name === timestamp)) {
        entries.push([timestamp, { type: DATE, allowNull: false }]);
      }
    }

    for (const [name, rawAttribute] of entries) {
      const attribute: AttributeOptions = isAttributeOptions(rawAttribute)
        ? rawAttribute
        : { type: rawAttribute };

      const type = normalizeDataType(attribute.type);

      const primaryKey = attribute.primaryKey ?? false;
      const normalized: NormalizedAttribute = {
        name,
        field: attribute.field ?? (underscored ? underscore(name) : name),
        type,
        allowNull: primaryKey ? false : (attribute.allowNull ?? true),
        primaryKey,
        autoIncrement: attribute.autoIncrement ?? false,
        defaultValue: attribute.defaultValue,
        hasDefaultValue: 'defaultValue' in attribute && attribute.defaultValue !== undefined,
        unique: attribute.unique ?? false,
        validate: attribute.validate,
        get: attribute.get,
        set: attribute.set,
        references: attribute.references,
        onDelete: attribute.onDelete,
        onUpdate: attribute.onUpdate,
      };

      this.attributes.set(name, normalized);
      if (!type.virtual) {
        this.columns.set(normalized.field, normalized);
      }
    }

    this.primaryKeys = [...this.attributes.values()]
      .filter(attribute => attribute.primaryKey)
      .map(attribute => attribute.name);
  }

  /** Attributes stored in the database (i.e. not VIRTUAL) */
  get physicalAttributes(): NormalizedAttribute[] {
    return [...this.columns.values()];
  }

  getAttribute(name: string): NormalizedAttribute {
    const attribute = this.attributes.get(name);
    if (!attribute) {
      throw new Error(`Model ${this.modelName} does not have an attribute named "${name}"`);
    }

    return attribute;
  }
}

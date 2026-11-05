import { encodeValue } from './changes.js';

import { isDefaultValueMarker } from './data-types.js';
import { EmptyResultError, ValidationError } from './errors.js';
import type { HookCallback, ModelHookName } from './hooks.js';
import { HookHandler, MODEL_HOOK_NAMES } from './hooks.js';
import type { ModelAttributes, ModelOptions, NormalizedAttribute } from './model-definition.js';
import { ModelDefinition } from './model-definition.js';
import { Op } from './operators.js';
import type { QueryOptions, Sequelize, SyncOptions } from './sequelize.js';
import type { Order, WhereOptions } from './sql.js';
import {
  Parameters,
  WhereBuilder,
  bindValue,
  buildOrder,
  quoteIdentifier,
  quoteLiteral,
} from './sql.js';
import type { Transaction } from './transaction.js';
import { validateAttributes } from './validation.js';

export type Attributes<M extends Model> = M['_attributes'];
export type CreationAttributes<M extends Model> = M['_creationAttributes'];

export type ModelStatic<M extends Model = Model> = typeof Model & {
  new (values?: any, options?: BuildOptions): M;
};

export interface BuildOptions {
  /** Default true */
  isNewRecord?: boolean;
  /** Set values without running setters/sanitizers */
  raw?: boolean;
}

export interface HookOptions {
  /** Whether to run hooks. Default true */
  hooks?: boolean;
}

export interface ChangeTrackingOptions {
  /** Whether to record this write in the change log. Default: the model's `trackChanges` option */
  trackChanges?: boolean;
}

export interface ValidateOptions extends HookOptions {
  /** Only validate these attributes */
  fields?: readonly string[];
  /** Don't validate these attributes */
  skip?: readonly string[];
}

export interface SaveOptions<TAttributes = any>
  extends QueryOptions, HookOptions, ChangeTrackingOptions {
  /** Only save these attributes */
  fields?: ReadonlyArray<keyof TAttributes & string>;
  /** Default true */
  validate?: boolean;
  /** Don't update the updatedAt timestamp */
  silent?: boolean;
}

export interface CreateOptions<TAttributes = any> extends SaveOptions<TAttributes> {}

export interface BulkCreateOptions<TAttributes = any> extends CreateOptions<TAttributes> {
  /** Run create/save hooks for each instance, in addition to the bulk hooks. Default false */
  individualHooks?: boolean;
}

export interface FindOptions<TAttributes = any> extends QueryOptions, HookOptions {
  where?: WhereOptions<TAttributes>;
  attributes?:
    | ReadonlyArray<keyof TAttributes & string>
    | { exclude: ReadonlyArray<keyof TAttributes & string> };
  order?: Order;
  limit?: number;
  offset?: number;
  /** Return plain objects instead of model instances */
  raw?: boolean;
}

export interface FindOrCreateOptions<TAttributes = any, TCreationAttributes = TAttributes>
  extends FindOptions<TAttributes>, CreateOptions<TAttributes> {
  where: WhereOptions<TAttributes>;
  defaults?: Partial<TCreationAttributes>;
}

export interface CountOptions<TAttributes = any> extends QueryOptions, HookOptions {
  where?: WhereOptions<TAttributes>;
}

export interface UpdateOptions<TAttributes = any> extends SaveOptions<TAttributes> {
  where: WhereOptions<TAttributes>;
  /** Load the rows and run instance hooks (beforeUpdate, afterSave…) for each of them. Default false */
  individualHooks?: boolean;
  /** The values being updated. Can be modified by beforeBulkUpdate hooks */
  attributes?: Partial<TAttributes>;
}

export interface DestroyOptions<TAttributes = any>
  extends QueryOptions, HookOptions, ChangeTrackingOptions {
  where: WhereOptions<TAttributes>;
  /** Load the rows and run beforeDestroy/afterDestroy hooks for each of them. Default false */
  individualHooks?: boolean;
}

export interface InstanceDestroyOptions extends QueryOptions, HookOptions, ChangeTrackingOptions {}

export interface GetOptions {
  /** Ignore custom getters */
  raw?: boolean;
  plain?: boolean;
}

export interface SetOptions {
  /** Ignore custom setters and type sanitization */
  raw?: boolean;
}

type HookAdder = <M extends Model>(
  this: ModelStatic<M>,
  listenerNameOrCallback: string | HookCallback,
  callback?: HookCallback,
) => ModelStatic<M>;

const definitions = new WeakMap<object, ModelDefinition>();
const sequelizes = new WeakMap<object, Sequelize>();
const hookHandlers = new WeakMap<object, HookHandler>();

function resolveDefaultValue(defaultValue: unknown): unknown {
  if (isDefaultValueMarker(defaultValue)) {
    return defaultValue.key === 'NOW' ? new Date() : crypto.randomUUID();
  }

  if (typeof defaultValue === 'function') {
    return defaultValue();
  }

  if (typeof defaultValue === 'object' && defaultValue !== null) {
    return structuredClone(defaultValue);
  }

  return defaultValue;
}

function areEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }

  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }

  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }

  return false;
}

export class Model<
  TAttributes extends object = any,
  TCreationAttributes extends object = TAttributes,
> {
  /** Type-only properties, used to infer attribute types */
  declare _attributes: TAttributes;
  declare _creationAttributes: TCreationAttributes;

  dataValues: Record<string, any>;
  _previousDataValues: Record<string, any>;
  isNewRecord: boolean;
  readonly #changed = new Set<string>();

  declare static beforeValidate: HookAdder;
  declare static afterValidate: HookAdder;
  declare static validationFailed: HookAdder;
  declare static beforeCreate: HookAdder;
  declare static afterCreate: HookAdder;
  declare static beforeUpdate: HookAdder;
  declare static afterUpdate: HookAdder;
  declare static beforeSave: HookAdder;
  declare static afterSave: HookAdder;
  declare static beforeDestroy: HookAdder;
  declare static afterDestroy: HookAdder;
  declare static beforeBulkCreate: HookAdder;
  declare static afterBulkCreate: HookAdder;
  declare static beforeBulkUpdate: HookAdder;
  declare static afterBulkUpdate: HookAdder;
  declare static beforeBulkDestroy: HookAdder;
  declare static afterBulkDestroy: HookAdder;
  declare static beforeFind: HookAdder;
  declare static afterFind: HookAdder;
  declare static beforeCount: HookAdder;
  declare static beforeSync: HookAdder;
  declare static afterSync: HookAdder;

  constructor(
    values: Partial<TCreationAttributes> | Record<string, unknown> = {},
    options: BuildOptions = {},
  ) {
    const definition = (this.constructor as ModelStatic).modelDefinition;

    this.dataValues = {};
    this._previousDataValues = {};
    this.isNewRecord = options.isNewRecord ?? true;

    const initialValues: Record<string, unknown> = { ...values };
    if (this.isNewRecord) {
      for (const attribute of definition.attributes.values()) {
        if (attribute.hasDefaultValue && initialValues[attribute.name] === undefined) {
          initialValues[attribute.name] = resolveDefaultValue(attribute.defaultValue);
        }
      }
    }

    if (options.raw) {
      for (const [key, value] of Object.entries(initialValues)) {
        if (definition.attributes.has(key)) {
          this.dataValues[key] = value;
          if (this.isNewRecord) {
            this.#changed.add(key);
          }
        }
      }
    } else {
      this.set(initialValues);
    }

    if (!this.isNewRecord) {
      this.#changed.clear();
      this._previousDataValues = { ...this.dataValues };
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Definition

  static init<M extends Model>(
    this: ModelStatic<M>,
    attributes: ModelAttributes<Attributes<M>>,
    options: ModelOptions & { sequelize: Sequelize },
  ): ModelStatic<M> {
    const { sequelize } = options;
    if (!sequelize) {
      throw new Error(`Model.init() requires the "sequelize" option (model ${this.name})`);
    }

    const modelName = options.modelName ?? this.name;
    if (sequelize.isDefined(modelName)) {
      throw new Error(`A model named "${modelName}" has already been defined`);
    }

    const { sequelize: ignoreSequelize, ...modelOptions } = options;
    const definition = new ModelDefinition(modelName, attributes, {
      ...sequelize.options.define,
      ...modelOptions,
    });

    definitions.set(this, definition);
    sequelizes.set(this, sequelize);

    const hooks = new HookHandler();
    hookHandlers.set(this, hooks);
    for (const [hookName, callbacks] of Object.entries(options.hooks ?? {})) {
      for (const callback of Array.isArray(callbacks) ? callbacks : [callbacks]) {
        hooks.addListener(hookName, callback);
      }
    }

    for (const attribute of definition.attributes.values()) {
      if (Object.hasOwn(this.prototype, attribute.name) || attribute.name in Model.prototype) {
        continue;
      }

      Object.defineProperty(this.prototype, attribute.name, {
        configurable: true,
        enumerable: false,
        get(this: Model) {
          return this.get(attribute.name);
        },
        set(this: Model, value: unknown) {
          this.set(attribute.name, value);
        },
      });
    }

    sequelize.models[modelName] = this;

    return this;
  }

  static get modelDefinition(): ModelDefinition {
    const definition = definitions.get(this);
    if (!definition) {
      throw new Error(
        `Model ${this.name} has not been initialized. Call ${this.name}.init() or use sequelize.define()`,
      );
    }

    return definition;
  }

  static get sequelize(): Sequelize {
    // trigger the "not initialized" error
    void this.modelDefinition;

    return sequelizes.get(this)!;
  }

  static get hooks(): HookHandler {
    void this.modelDefinition;

    return hookHandlers.get(this)!;
  }

  static get modelName(): string {
    return this.modelDefinition.modelName;
  }

  static get tableName(): string {
    return this.modelDefinition.table;
  }

  static get primaryKeyAttributes(): readonly string[] {
    return this.modelDefinition.primaryKeys;
  }

  static get primaryKeyAttribute(): string {
    return this.modelDefinition.primaryKeys[0];
  }

  static getAttributes(): ReadonlyMap<string, NormalizedAttribute> {
    return this.modelDefinition.attributes;
  }

  static addHook<M extends Model>(
    this: ModelStatic<M>,
    hookName: ModelHookName,
    listenerNameOrCallback: string | HookCallback,
    callback?: HookCallback,
  ): ModelStatic<M> {
    if (typeof listenerNameOrCallback === 'string') {
      this.hooks.addListener(hookName, callback!, listenerNameOrCallback);
    } else {
      this.hooks.addListener(hookName, listenerNameOrCallback);
    }

    return this;
  }

  static removeHook<M extends Model>(
    this: ModelStatic<M>,
    hookName: ModelHookName,
    listenerNameOrCallback: string | HookCallback,
  ): ModelStatic<M> {
    this.hooks.removeListener(hookName, listenerNameOrCallback);

    return this;
  }

  static hasHook(hookName: ModelHookName): boolean {
    return this.hooks.hasListeners(hookName);
  }

  /**
   * @param options
   * @param hookName
   * @param args
   * @internal
   */
  static async _runHooks(options: HookOptions, hookName: ModelHookName, ...args: unknown[]) {
    if (options.hooks === false) {
      return;
    }

    await this.hooks.runAsync(hookName, ...args);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Schema

  static async sync(options: SyncOptions = {}): Promise<void> {
    const definition = this.modelDefinition;
    const { sequelize } = this;
    const table = quoteIdentifier(definition.table);

    await this._runHooks(options, 'beforeSync', options);

    if (options.force) {
      await sequelize.query(`DROP TABLE IF EXISTS ${table} CASCADE`, [], options);
    }

    const columns = definition.physicalAttributes.map(attribute =>
      columnDefinition(attribute, true),
    );
    const constraints: string[] = [];

    if (definition.primaryKeys.length > 0) {
      constraints.push(
        `PRIMARY KEY (${definition.primaryKeys
          .map(name => quoteIdentifier(definition.getAttribute(name).field))
          .join(', ')})`,
      );
    }

    const uniqueGroups = new Map<string, string[]>();
    for (const attribute of definition.physicalAttributes) {
      if (typeof attribute.unique === 'string') {
        const group = uniqueGroups.get(attribute.unique) ?? [];
        group.push(quoteIdentifier(attribute.field));
        uniqueGroups.set(attribute.unique, group);
      }
    }

    for (const [name, fields] of uniqueGroups) {
      constraints.push(`CONSTRAINT ${quoteIdentifier(name)} UNIQUE (${fields.join(', ')})`);
    }

    await sequelize.query(
      `CREATE TABLE IF NOT EXISTS ${table} (\n  ${[...columns, ...constraints].join(',\n  ')}\n)`,
      [],
      options,
    );

    if (options.alter) {
      for (const attribute of definition.physicalAttributes) {
        // eslint-disable-next-line no-await-in-loop -- sequential DDL
        await sequelize.query(
          `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${columnDefinition(attribute, false)}`,
          [],
          options,
        );
      }
    }

    for (const index of definition.options.indexes ?? []) {
      const fields = index.fields.map(name => definition.getAttribute(name).field);
      const name = index.name ?? `${definition.table}_${fields.join('_')}`;
      // eslint-disable-next-line no-await-in-loop -- sequential DDL
      await sequelize.query(
        `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${quoteIdentifier(name)} ON ${table} (${fields
          .map(quoteIdentifier)
          .join(', ')})`,
        [],
        options,
      );
    }

    await this._runHooks(options, 'afterSync', options);
  }

  static async drop(options: QueryOptions = {}): Promise<void> {
    await this.sequelize.query(
      `DROP TABLE IF EXISTS ${quoteIdentifier(this.modelDefinition.table)} CASCADE`,
      [],
      options,
    );
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Reading

  static build<M extends Model>(
    this: ModelStatic<M>,
    values?: CreationAttributes<M>,
    options?: BuildOptions,
  ): M {
    return new (this as new (values?: unknown, options?: BuildOptions) => M)(values, options);
  }

  /**
   * @param row
   * @internal
   */
  static _fromRow<M extends Model>(this: ModelStatic<M>, row: Record<string, unknown>): M {
    return new (this as new (values?: unknown, options?: BuildOptions) => M)(
      this._rowToValues(row),
      {
        isNewRecord: false,
        raw: true,
      },
    );
  }

  /**
   * @param row
   * @internal
   */
  static _rowToValues(row: Record<string, unknown>): Record<string, unknown> {
    const { columns } = this.modelDefinition;
    const values: Record<string, unknown> = {};
    for (const [column, value] of Object.entries(row)) {
      const attribute = columns.get(column);
      if (attribute) {
        values[attribute.name] = value == null ? value : attribute.type.parse(value);
      }
    }

    return values;
  }

  static async findAll<M extends Model>(
    this: ModelStatic<M>,
    options: FindOptions<Attributes<M>> = {},
  ): Promise<M[]> {
    return (await this._find(options, false)) as M[];
  }

  static async findOne<M extends Model>(
    this: ModelStatic<M>,
    options: FindOptions<Attributes<M>> = {},
  ): Promise<M | null> {
    return (await this._find({ ...options, limit: 1 }, true)) as M | null;
  }

  static async findByPk<M extends Model>(
    this: ModelStatic<M>,
    primaryKey: unknown,
    options: Omit<FindOptions<Attributes<M>>, 'where'> = {},
  ): Promise<M | null> {
    if (primaryKey == null) {
      return null;
    }

    const { primaryKeys } = this.modelDefinition;
    if (primaryKeys.length !== 1) {
      throw new Error(
        `findByPk does not support models with composite primary keys (${this.name})`,
      );
    }

    return this.findOne({ ...options, where: { [primaryKeys[0]]: primaryKey } as WhereOptions });
  }

  static async findOrCreate<M extends Model>(
    this: ModelStatic<M>,
    options: FindOrCreateOptions<Attributes<M>, CreationAttributes<M>>,
  ): Promise<[instance: M, created: boolean]> {
    return this.sequelize._withTransaction(options, async transaction => {
      const found = await this.findOne({ ...options, transaction });
      if (found) {
        return [found, false];
      }

      const values: Record<string, unknown> = {};
      for (const key of Object.keys(options.where)) {
        const value = (options.where as Record<string, unknown>)[key];
        if (typeof value !== 'object' || value === null || value instanceof Date) {
          values[key] = value;
        }
      }

      const created = await this.create(
        { ...values, ...options.defaults },
        {
          ...options,
          transaction,
        },
      );

      return [created, true];
    });
  }

  static async findAndCountAll<M extends Model>(
    this: ModelStatic<M>,
    options: FindOptions<Attributes<M>> = {},
  ): Promise<{ count: number; rows: M[] }> {
    const [count, rows] = await Promise.all([this.count({ ...options }), this.findAll(options)]);

    return { count, rows };
  }

  /**
   * @param options
   * @param plain
   * @internal
   */
  static async _find(options: FindOptions, plain: boolean): Promise<Model | Model[] | null> {
    const definition = this.modelDefinition;
    options = { ...options };

    await this._runHooks(options, 'beforeFind', options);

    const parameters = new Parameters();
    const where = new WhereBuilder(definition, parameters).build(options.where);
    const order = buildOrder(definition, options.order);

    let selected: NormalizedAttribute[];
    if (options.attributes === undefined) {
      selected = definition.physicalAttributes;
    } else if (Array.isArray(options.attributes)) {
      selected = options.attributes.map(name => definition.getAttribute(name));
    } else {
      const excluded = new Set<string>((options.attributes as { exclude: string[] }).exclude);
      selected = definition.physicalAttributes.filter(attribute => !excluded.has(attribute.name));
    }

    let sql = `SELECT ${selected
      .filter(attribute => !attribute.type.virtual)
      .map(attribute => quoteIdentifier(attribute.field))
      .join(', ')} FROM ${quoteIdentifier(definition.table)}`;
    if (where) {
      sql += ` WHERE ${where}`;
    }

    if (order) {
      sql += ` ORDER BY ${order}`;
    }

    if (options.limit !== undefined) {
      sql += ` LIMIT ${parameters.add(options.limit)}`;
    }

    if (options.offset !== undefined) {
      sql += ` OFFSET ${parameters.add(options.offset)}`;
    }

    const { rows } = await this.sequelize.query(sql, parameters.values, options);
    const results = options.raw
      ? rows.map(row => this._rowToValues(row))
      : rows.map(row => (this as ModelStatic)._fromRow(row));

    const result = plain ? (results[0] ?? null) : results;
    await this._runHooks(options, 'afterFind', result, options);

    return result as Model | Model[] | null;
  }

  static async count<M extends Model>(
    this: ModelStatic<M>,
    options: CountOptions<Attributes<M>> = {},
  ): Promise<number> {
    options = { ...options };
    await this._runHooks(options, 'beforeCount', options);

    const parameters = new Parameters();
    const where = new WhereBuilder(this.modelDefinition, parameters).build(options.where);
    const { rows } = await this.sequelize.query<{ count: number }>(
      `SELECT count(*)::int AS "count" FROM ${quoteIdentifier(this.modelDefinition.table)}${where ? ` WHERE ${where}` : ''}`,
      parameters.values,
      options,
    );

    return rows[0].count;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Writing

  static async create<M extends Model>(
    this: ModelStatic<M>,
    values: CreationAttributes<M> = {},
    options: CreateOptions<Attributes<M>> = {},
  ): Promise<M> {
    return this.build(values).save(options);
  }

  static async bulkCreate<M extends Model>(
    this: ModelStatic<M>,
    records: ReadonlyArray<CreationAttributes<M>>,
    options: BulkCreateOptions<Attributes<M>> = {},
  ): Promise<M[]> {
    const definition = this.modelDefinition;
    options = { ...options };

    const instances = records.map(record => this.build(record));
    if (instances.length === 0) {
      return instances;
    }

    await this._runHooks(options, 'beforeBulkCreate', instances, options);

    const individualHooks = options.individualHooks === true && options.hooks !== false;

    // like @sequelize/core, bulkCreate does not validate by default
    if (options.validate === true) {
      for (const instance of instances) {
        // eslint-disable-next-line no-await-in-loop -- sequential validation
        await instance.validate({
          hooks: individualHooks,
          ...(options.fields ? { fields: options.fields } : {}),
        });
      }
    }

    if (individualHooks) {
      for (const instance of instances) {
        // eslint-disable-next-line no-await-in-loop -- hooks run sequentially
        await this.hooks.runAsync('beforeCreate', instance, options);
        // eslint-disable-next-line no-await-in-loop -- hooks run sequentially
        await this.hooks.runAsync('beforeSave', instance, options);
      }
    }

    const now = new Date();
    for (const instance of instances) {
      instance._applyTimestamps(now, options);
    }

    const insertable = definition.physicalAttributes.filter(attribute => {
      if (
        options.fields &&
        !options.fields.includes(attribute.name) &&
        !isTimestamp(definition, attribute.name)
      ) {
        return false;
      }

      return instances.some(instance => instance.dataValues[attribute.name] !== undefined);
    });

    await this.sequelize._withTransaction(options, async transaction => {
      const parameters = new Parameters();
      const rows = instances.map(
        instance =>
          `(${insertable
            .map(attribute => {
              const value = instance.dataValues[attribute.name];

              return value === undefined ? 'DEFAULT' : parameters.add(bindValue(attribute, value));
            })
            .join(', ')})`,
      );

      const sql =
        insertable.length === 0
          ? `INSERT INTO ${quoteIdentifier(definition.table)} DEFAULT VALUES RETURNING *`
          : `INSERT INTO ${quoteIdentifier(definition.table)} (${insertable
              .map(attribute => quoteIdentifier(attribute.field))
              .join(', ')}) VALUES ${rows.join(', ')} RETURNING *`;

      if (insertable.length === 0 && instances.length > 1) {
        // DEFAULT VALUES only supports one row
        for (const instance of instances) {
          // eslint-disable-next-line no-await-in-loop -- sequential writes
          const { rows: inserted } = await this.sequelize.query(sql, [], { transaction });
          instance._afterWrite(inserted[0]);
        }
      } else {
        const { rows: inserted } = await this.sequelize.query(sql, parameters.values, {
          transaction,
        });
        for (const [index, instance] of instances.entries()) {
          instance._afterWrite(inserted[index]);
        }
      }

      if (shouldTrackChanges(definition, options)) {
        await this.sequelize._recordChanges(
          instances.map(instance => ({
            model: definition.modelName,
            op: 'create' as const,
            pk: instance._primaryKeyValues(),
            data: instance._encodedValues(
              definition.physicalAttributes.map(attribute => attribute.name),
            ),
          })),
          transaction,
        );
      }
    });

    if (individualHooks) {
      for (const instance of instances) {
        // eslint-disable-next-line no-await-in-loop -- hooks run sequentially
        await this.hooks.runAsync('afterCreate', instance, options);
        // eslint-disable-next-line no-await-in-loop -- hooks run sequentially
        await this.hooks.runAsync('afterSave', instance, options);
      }
    }

    await this._runHooks(options, 'afterBulkCreate', instances, options);

    return instances;
  }

  /**
   * Updates all rows matching `options.where`.
   * Returns the number of affected rows, and the affected rows.
   *
   * @param values
   * @param options
   */
  static async update<M extends Model>(
    this: ModelStatic<M>,
    values: Partial<Attributes<M>>,
    options: UpdateOptions<Attributes<M>>,
  ): Promise<[affectedCount: number, affectedRows: M[]]> {
    if (!options?.where) {
      throw new Error('Missing where attribute in the options parameter of Model.update.');
    }

    const definition = this.modelDefinition;
    options = { ...options, attributes: { ...values } };

    await this._runHooks(options, 'beforeBulkUpdate', options);
    const attributes = options.attributes as Record<string, unknown>;

    let affected: M[];
    if (options.individualHooks && options.hooks !== false) {
      affected = await this.sequelize._withTransaction(options, async transaction => {
        const instances = await this.findAll({ where: options.where, transaction, hooks: false });
        for (const instance of instances) {
          // eslint-disable-next-line no-await-in-loop -- sequential writes
          await instance.update(attributes, { ...options, transaction });
        }

        return instances;
      });
    } else {
      // validate & sanitize the values through a temporary instance
      const instance = this.build(undefined, { isNewRecord: false });
      instance.set(attributes);
      const keys = Object.keys(attributes).filter(key => definition.attributes.has(key));
      if (options.validate !== false && keys.length > 0) {
        await instance.validate({ fields: keys, hooks: false });
      }

      if (definition.updatedAtAttribute && !options.silent) {
        instance.dataValues[definition.updatedAtAttribute] = new Date();
        keys.push(definition.updatedAtAttribute);
      }

      const updated = keys
        .map(key => definition.getAttribute(key))
        .filter(attribute => !attribute.type.virtual);

      if (updated.length === 0) {
        return [0, []];
      }

      affected = await this.sequelize._withTransaction(options, async transaction => {
        const parameters = new Parameters();
        const assignments = updated
          .map(
            attribute =>
              `${quoteIdentifier(attribute.field)} = ${parameters.add(bindValue(attribute, instance.dataValues[attribute.name]))}`,
          )
          .join(', ');
        const where = new WhereBuilder(definition, parameters).build(options.where);

        const { rows } = await this.sequelize.query(
          `UPDATE ${quoteIdentifier(definition.table)} SET ${assignments}${where ? ` WHERE ${where}` : ''} RETURNING *`,
          parameters.values,
          { transaction },
        );

        const instances = rows.map(row => this._fromRow(row));
        if (shouldTrackChanges(definition, options)) {
          await this.sequelize._recordChanges(
            instances.map(row => ({
              model: definition.modelName,
              op: 'update' as const,
              pk: row._primaryKeyValues(),
              data: row._encodedValues(updated.map(attribute => attribute.name)),
            })),
            transaction,
          );
        }

        return instances;
      });
    }

    await this._runHooks(options, 'afterBulkUpdate', options);

    return [affected.length, affected];
  }

  /**
   * Deletes all rows matching `options.where`. Returns the number of deleted rows.
   *
   * @param options
   */
  static async destroy<M extends Model>(
    this: ModelStatic<M>,
    options: DestroyOptions<Attributes<M>>,
  ): Promise<number> {
    if (!options?.where) {
      throw new Error('Missing where attribute in the options parameter of Model.destroy.');
    }

    const definition = this.modelDefinition;
    options = { ...options };

    await this._runHooks(options, 'beforeBulkDestroy', options);

    let count: number;
    if (options.individualHooks && options.hooks !== false) {
      count = await this.sequelize._withTransaction(options, async transaction => {
        const instances = await this.findAll({ where: options.where, transaction, hooks: false });
        for (const instance of instances) {
          // eslint-disable-next-line no-await-in-loop -- sequential writes
          await instance.destroy({ ...options, transaction });
        }

        return instances.length;
      });
    } else {
      count = await this.sequelize._withTransaction(options, async transaction => {
        const parameters = new Parameters();
        const where = new WhereBuilder(definition, parameters).build(options.where);
        const returning = definition.primaryKeys
          .map(name => quoteIdentifier(definition.getAttribute(name).field))
          .join(', ');

        const { rows } = await this.sequelize.query(
          `DELETE FROM ${quoteIdentifier(definition.table)}${where ? ` WHERE ${where}` : ''} RETURNING ${returning}`,
          parameters.values,
          { transaction },
        );

        if (shouldTrackChanges(definition, options)) {
          await this.sequelize._recordChanges(
            rows.map(row => ({
              model: definition.modelName,
              op: 'destroy' as const,
              pk: this._fromRow(row)._primaryKeyValues(),
              data: null,
            })),
            transaction,
          );
        }

        return rows.length;
      });
    }

    await this._runHooks(options, 'afterBulkDestroy', options);

    return count;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Instance

  get modelDefinition(): ModelDefinition {
    return (this.constructor as ModelStatic).modelDefinition;
  }

  get sequelize(): Sequelize {
    return (this.constructor as ModelStatic).sequelize;
  }

  get<K extends keyof TAttributes>(key: K, options?: GetOptions): TAttributes[K];
  get(options?: GetOptions): TAttributes;
  get(keyOrOptions?: string | GetOptions, maybeOptions?: GetOptions): unknown {
    const definition = this.modelDefinition;

    if (typeof keyOrOptions === 'string') {
      const attribute = definition.attributes.get(keyOrOptions);
      if (attribute?.get && !maybeOptions?.raw) {
        return attribute.get.call(this);
      }

      return this.dataValues[keyOrOptions];
    }

    const options = keyOrOptions ?? {};
    if (options.raw) {
      return { ...this.dataValues };
    }

    const values: Record<string, unknown> = {};
    for (const attribute of definition.attributes.values()) {
      if (attribute.name in this.dataValues || attribute.get) {
        values[attribute.name] = this.get(attribute.name as keyof TAttributes);
      }
    }

    return values;
  }

  set<K extends keyof TAttributes>(key: K, value: TAttributes[K], options?: SetOptions): this;
  set(values: Partial<TAttributes> | Record<string, unknown>, options?: SetOptions): this;
  set(keyOrValues: string | object, valueOrOptions?: unknown, maybeOptions?: SetOptions): this {
    if (typeof keyOrValues === 'object' && keyOrValues !== null) {
      const options = valueOrOptions as SetOptions | undefined;
      for (const [key, value] of Object.entries(keyOrValues)) {
        this.set(key as keyof TAttributes, value, options);
      }

      return this;
    }

    const key = keyOrValues;
    const attribute = this.modelDefinition.attributes.get(key);
    if (!attribute) {
      // like @sequelize/core, unknown attributes are ignored
      return this;
    }

    if (attribute.set && !maybeOptions?.raw) {
      attribute.set.call(this, valueOrOptions);

      return this;
    }

    const value =
      maybeOptions?.raw || valueOrOptions == null
        ? valueOrOptions
        : attribute.type.sanitize(valueOrOptions);

    return this.setDataValue(key as keyof TAttributes, value as TAttributes[keyof TAttributes]);
  }

  getDataValue<K extends keyof TAttributes>(key: K): TAttributes[K] {
    return this.dataValues[key as string];
  }

  setDataValue<K extends keyof TAttributes>(key: K, value: TAttributes[K]): this {
    if (
      !areEqual(this.dataValues[key as string], value) ||
      (this.isNewRecord && value !== undefined)
    ) {
      this.#changed.add(key as string);
    }

    this.dataValues[key as string] = value;

    return this;
  }

  /** Returns the changed attributes, or false if there are none */
  changed(): string[] | false;
  changed(key: keyof TAttributes & string): boolean;
  changed(key: keyof TAttributes & string, changed: boolean): this;
  changed(key?: string, changed?: boolean): unknown {
    if (key === undefined) {
      return this.#changed.size > 0 ? [...this.#changed] : false;
    }

    if (changed === undefined) {
      return this.#changed.has(key);
    }

    if (changed) {
      this.#changed.add(key);
    } else {
      this.#changed.delete(key);
    }

    return this;
  }

  previous<K extends keyof TAttributes>(key: K): TAttributes[K] | undefined {
    return this._previousDataValues[key as string];
  }

  toJSON(): TAttributes {
    return structuredCloneSafe(this.get({ plain: true })) as TAttributes;
  }

  async validate(options: ValidateOptions = {}): Promise<void> {
    const ModelClass = this.constructor as ModelStatic;
    const definition = this.modelDefinition;

    await ModelClass._runHooks(options, 'beforeValidate', this, options);

    const skip = new Set(options.skip ?? []);
    const fields = options.fields ? new Set(options.fields) : undefined;
    const attributes = [...definition.attributes.values()].filter(
      attribute => !skip.has(attribute.name) && (!fields || fields.has(attribute.name)),
    );

    const nullable = new Set<string>();
    for (const attribute of definition.attributes.values()) {
      if (attribute.autoIncrement || isTimestamp(definition, attribute.name)) {
        nullable.add(attribute.name);
      }
    }

    const errors = await validateAttributes({
      modelName: definition.modelName,
      instance: this,
      attributes,
      values: this.dataValues,
      nullableAttributes: nullable,
      modelValidators: definition.options.validate,
    });

    if (errors.length > 0) {
      const error = new ValidationError(undefined, errors);
      await ModelClass._runHooks(options, 'validationFailed', this, options, error);
      throw error;
    }

    await ModelClass._runHooks(options, 'afterValidate', this, options);
  }

  async save(options: SaveOptions<TAttributes> = {}): Promise<this> {
    const ModelClass = this.constructor as ModelStatic;
    const definition = this.modelDefinition;
    const { sequelize } = this;
    const isNewRecord = this.isNewRecord;
    options = { ...options };

    if (!isNewRecord && !this.changed()) {
      return this;
    }

    const fieldsFor = () =>
      (options.fields as string[] | undefined) ??
      (isNewRecord ? [...definition.attributes.keys()] : this.changed() || []);

    if (options.validate !== false) {
      await this.validate({ ...options, fields: fieldsFor() });
    }

    const writeHook = isNewRecord ? 'beforeCreate' : 'beforeUpdate';
    if (
      options.hooks !== false &&
      (ModelClass.hasHook(writeHook) || ModelClass.hasHook('beforeSave'))
    ) {
      const before = { ...this.dataValues };
      await ModelClass.hooks.runAsync(writeHook, this, options);
      await ModelClass.hooks.runAsync('beforeSave', this, options);

      const changedByHooks = Object.keys(this.dataValues).filter(
        key => !areEqual(before[key], this.dataValues[key]),
      );
      if (options.validate !== false && changedByHooks.length > 0) {
        await this.validate({ fields: changedByHooks, hooks: false });
      }
    }

    this._applyTimestamps(new Date(), options);

    const fields = new Set(fieldsFor());
    for (const timestamp of [definition.createdAtAttribute, definition.updatedAtAttribute]) {
      if (timestamp && this.#changed.has(timestamp)) {
        fields.add(timestamp);
      }
    }

    const written = definition.physicalAttributes.filter(
      attribute =>
        fields.has(attribute.name) &&
        (isNewRecord
          ? this.dataValues[attribute.name] !== undefined
          : this.#changed.has(attribute.name)),
    );

    if (isNewRecord || written.length > 0) {
      await sequelize._withTransaction(options, async transaction => {
        const parameters = new Parameters();
        const table = quoteIdentifier(definition.table);
        let sql: string;

        if (isNewRecord) {
          sql =
            written.length === 0
              ? `INSERT INTO ${table} DEFAULT VALUES RETURNING *`
              : `INSERT INTO ${table} (${written.map(attribute => quoteIdentifier(attribute.field)).join(', ')}) VALUES (${written
                  .map(attribute =>
                    parameters.add(bindValue(attribute, this.dataValues[attribute.name])),
                  )
                  .join(', ')}) RETURNING *`;
        } else {
          const assignments = written
            .map(
              attribute =>
                `${quoteIdentifier(attribute.field)} = ${parameters.add(bindValue(attribute, this.dataValues[attribute.name]))}`,
            )
            .join(', ');
          sql = `UPDATE ${table} SET ${assignments} WHERE ${this._primaryKeyWhere(parameters, true)} RETURNING *`;
        }

        const { rows } = await sequelize.query(sql, parameters.values, { transaction });
        if (rows.length === 0) {
          throw new EmptyResultError(
            `${definition.modelName} could not be saved because it does not exist anymore`,
          );
        }

        const changedAttributes = written.map(attribute => attribute.name);
        this._afterWrite(rows[0]);

        if (shouldTrackChanges(definition, options)) {
          await sequelize._recordChanges(
            [
              {
                model: definition.modelName,
                op: isNewRecord ? 'create' : 'update',
                pk: this._primaryKeyValues(),
                data: this._encodedValues(
                  isNewRecord
                    ? definition.physicalAttributes.map(attribute => attribute.name)
                    : changedAttributes,
                ),
              },
            ],
            transaction,
          );
        }
      });
    }

    for (const field of fields) {
      this.#changed.delete(field);
    }

    await ModelClass._runHooks(options, isNewRecord ? 'afterCreate' : 'afterUpdate', this, options);
    await ModelClass._runHooks(options, 'afterSave', this, options);

    return this;
  }

  async update(
    values: Partial<TAttributes>,
    options: SaveOptions<TAttributes> = {},
  ): Promise<this> {
    this.set(values);

    return this.save(options);
  }

  async destroy(options: InstanceDestroyOptions = {}): Promise<void> {
    const ModelClass = this.constructor as ModelStatic;
    const definition = this.modelDefinition;
    options = { ...options };

    await ModelClass._runHooks(options, 'beforeDestroy', this, options);

    await this.sequelize._withTransaction(options, async transaction => {
      const parameters = new Parameters();
      await this.sequelize.query(
        `DELETE FROM ${quoteIdentifier(definition.table)} WHERE ${this._primaryKeyWhere(parameters, true)}`,
        parameters.values,
        { transaction },
      );

      if (shouldTrackChanges(definition, options)) {
        await this.sequelize._recordChanges(
          [
            {
              model: definition.modelName,
              op: 'destroy',
              pk: this._primaryKeyValues(),
              data: null,
            },
          ],
          transaction,
        );
      }
    });

    await ModelClass._runHooks(options, 'afterDestroy', this, options);
  }

  async reload(options: QueryOptions = {}): Promise<this> {
    const definition = this.modelDefinition;
    const parameters = new Parameters();
    const { rows } = await this.sequelize.query(
      `SELECT * FROM ${quoteIdentifier(definition.table)} WHERE ${this._primaryKeyWhere(parameters, true)}`,
      parameters.values,
      options,
    );

    if (rows.length === 0) {
      throw new EmptyResultError(
        'Instance could not be reloaded because it does not exist anymore (find call returned null)',
      );
    }

    this._afterWrite(rows[0]);
    this.#changed.clear();

    return this;
  }

  /**
   * Replaces the rows of this table with the given (decoded) rows, without running hooks, validations,
   * timestamps or change tracking. Rows whose primary key is in `preserve` are left untouched.
   *
   * @param rows
   * @param preserve
   * @param transaction
   * @internal
   */
  static async _replaceRows(
    rows: ReadonlyArray<Record<string, unknown>>,
    preserve: ReadonlyArray<Record<string, unknown>>,
    transaction: Transaction,
  ): Promise<number> {
    const definition = this.modelDefinition;
    const table = quoteIdentifier(definition.table);
    const pkKey = (row: Record<string, unknown>) =>
      JSON.stringify(definition.primaryKeys.map(name => encodeValue(row[name])));

    const deleteParameters = new Parameters();
    const where =
      preserve.length > 0
        ? new WhereBuilder(definition, deleteParameters).build({
            [Op.not]: { [Op.or]: preserve },
          })
        : '';
    await this.sequelize.query(
      `DELETE FROM ${table}${where ? ` WHERE ${where}` : ''}`,
      deleteParameters.values,
      { transaction },
    );

    const preserved = new Set(preserve.map(pkKey));
    const restored = rows.filter(row => !preserved.has(pkKey(row)));
    const columns = definition.physicalAttributes.filter(attribute =>
      restored.some(row => row[attribute.name] !== undefined),
    );
    if (columns.length === 0) {
      return 0;
    }

    const batchSize = 500;
    for (let start = 0; start < restored.length; start += batchSize) {
      const parameters = new Parameters();
      const values = restored.slice(start, start + batchSize).map(
        row =>
          `(${columns
            .map(attribute => {
              const value = row[attribute.name];

              return value === undefined ? 'DEFAULT' : parameters.add(bindValue(attribute, value));
            })
            .join(', ')})`,
      );

      // eslint-disable-next-line no-await-in-loop -- batches run sequentially in the same transaction
      await this.sequelize.query(
        `INSERT INTO ${table} (${columns.map(attribute => quoteIdentifier(attribute.field)).join(', ')}) VALUES ${values.join(', ')}`,
        parameters.values,
        { transaction },
      );
    }

    return restored.length;
  }

  /**
   * @param now
   * @param options
   * @param options.silent
   * @internal
   */
  _applyTimestamps(now: Date, options: { silent?: boolean }) {
    const definition = this.modelDefinition;
    if (definition.updatedAtAttribute && !(options.silent && !this.isNewRecord)) {
      this.setDataValue(definition.updatedAtAttribute as keyof TAttributes, now as never);
    }

    if (
      this.isNewRecord &&
      definition.createdAtAttribute &&
      this.dataValues[definition.createdAtAttribute] == null
    ) {
      this.setDataValue(definition.createdAtAttribute as keyof TAttributes, now as never);
    }
  }

  /**
   * @param row
   * @internal
   */
  _afterWrite(row: Record<string, unknown>) {
    const ModelClass = this.constructor as ModelStatic;
    Object.assign(this.dataValues, ModelClass._rowToValues(row));
    this.isNewRecord = false;
    this._previousDataValues = { ...this.dataValues };
  }

  /** @internal */
  _primaryKeyValues(): Record<string, unknown> {
    return Object.fromEntries(
      this.modelDefinition.primaryKeys.map(name => [name, encodeValue(this.dataValues[name])]),
    );
  }

  /**
   * @param attributeNames
   * @internal
   */
  _encodedValues(attributeNames: readonly string[]): Record<string, unknown> {
    return Object.fromEntries(
      attributeNames
        .filter(name => this.dataValues[name] !== undefined)
        .map(name => [name, encodeValue(this.dataValues[name])]),
    );
  }

  /**
   * @param parameters
   * @param usePrevious
   * @internal
   */
  _primaryKeyWhere(parameters: Parameters, usePrevious: boolean): string {
    const definition = this.modelDefinition;

    return definition.primaryKeys
      .map(name => {
        const attribute = definition.getAttribute(name);
        const value =
          usePrevious && this._previousDataValues[name] !== undefined
            ? this._previousDataValues[name]
            : this.dataValues[name];
        if (value == null) {
          throw new Error(
            `Cannot identify ${definition.modelName} row: primary key "${name}" is not set`,
          );
        }

        return `${quoteIdentifier(attribute.field)} = ${parameters.add(bindValue(attribute, value))}`;
      })
      .join(' AND ');
  }
}

for (const hookName of MODEL_HOOK_NAMES) {
  Object.defineProperty(Model, hookName, {
    configurable: true,
    writable: true,
    value(
      this: ModelStatic,
      listenerNameOrCallback: string | HookCallback,
      callback?: HookCallback,
    ) {
      return this.addHook(hookName, listenerNameOrCallback, callback);
    },
  });
}

function isTimestamp(definition: ModelDefinition, attributeName: string): boolean {
  return (
    attributeName === definition.createdAtAttribute ||
    attributeName === definition.updatedAtAttribute
  );
}

function shouldTrackChanges(
  definition: ModelDefinition,
  options: { trackChanges?: boolean },
): boolean {
  return options.trackChanges ?? definition.trackChanges;
}

function structuredCloneSafe(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function defaultValueSql(attribute: NormalizedAttribute): string | undefined {
  const { defaultValue } = attribute;
  if (!attribute.hasDefaultValue || typeof defaultValue === 'function') {
    return undefined;
  }

  if (isDefaultValueMarker(defaultValue)) {
    return defaultValue.key === 'NOW' ? 'CURRENT_TIMESTAMP' : 'gen_random_uuid()';
  }

  if (typeof defaultValue === 'number' || typeof defaultValue === 'bigint') {
    return String(defaultValue);
  }

  if (typeof defaultValue === 'boolean') {
    return defaultValue ? 'TRUE' : 'FALSE';
  }

  if (typeof defaultValue === 'string') {
    return quoteLiteral(defaultValue);
  }

  if (defaultValue instanceof Date) {
    return quoteLiteral(defaultValue.toISOString());
  }

  return undefined;
}

function columnDefinition(attribute: NormalizedAttribute, creatingTable: boolean): string {
  const parts = [quoteIdentifier(attribute.field), attribute.type.toSql()];

  if (attribute.autoIncrement) {
    parts.push('GENERATED BY DEFAULT AS IDENTITY');
  }

  const defaultSql = defaultValueSql(attribute);
  if (defaultSql !== undefined) {
    parts.push(`DEFAULT ${defaultSql}`);
  }

  // when adding a column to an existing table, NOT NULL requires a default value
  if (!attribute.allowNull && (creatingTable || defaultSql !== undefined)) {
    parts.push('NOT NULL');
  }

  if (attribute.unique === true) {
    parts.push('UNIQUE');
  }

  const values = (attribute.type as { values?: readonly string[] }).values;
  if (attribute.type.key === 'ENUM' && values && values.length > 0) {
    parts.push(
      `CHECK (${quoteIdentifier(attribute.field)} IN (${values.map(quoteLiteral).join(', ')}))`,
    );
  }

  if (attribute.references) {
    parts.push(
      `REFERENCES ${quoteIdentifier(attribute.references.table)} (${quoteIdentifier(attribute.references.key ?? 'id')})`,
    );
    if (attribute.onDelete) {
      parts.push(`ON DELETE ${attribute.onDelete}`);
    }

    if (attribute.onUpdate) {
      parts.push(`ON UPDATE ${attribute.onUpdate}`);
    }
  }

  return parts.join(' ');
}

export { type DataTypeInput } from './data-types.js';
export { type AttributeOptions } from './model-definition.js';

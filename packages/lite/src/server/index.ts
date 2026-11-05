import type { Model, ModelStatic, Sequelize, Transaction, WhereOptions } from '@sequelize/core';
import type { ChangeRecord, ChangeSet, Snapshot } from '../changes.js';
import {
  CHANGE_SET_FORMAT,
  CHANGE_SET_VERSION,
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  decodeValues,
  encodeValues,
} from '../changes.js';
import { SyncError } from '../errors.js';
import { Op } from '../operators.js';

export type { ChangeOperation, ChangeRecord, ChangeSet, Snapshot } from '../changes.js';

export interface SnapshotRowContext {
  model: ModelStatic;
  instance: Model;
  transaction: Transaction;
}

/**
 * What clients may read and write for one model. Build it per request, so `where` can depend on the logged-in user.
 */
export interface SyncModelConfig {
  model: ModelStatic<any> | string;
  /**
   * Allow-list of attributes clients may read (in snapshots) and write (in change sets).
   * Primary keys are always included. Use either this or `exclude`.
   */
  attributes?: readonly string[];
  /** Attributes clients may never read or write (e.g. `password`). Use either this or `attributes` */
  exclude?: readonly string[];
  /** Rows clients may read, e.g. `{ [Op.or]: [{ ownerId: user.id }, { public: true }] }`. Also limits writes, unless `writeWhere` is set */
  where?: WhereOptions<any>;
  /** Rows clients may create, update or destroy, e.g. `{ ownerId: user.id }`. Defaults to `where` */
  writeWhere?: WhereOptions<any>;
  /** Called for each exported snapshot row. Return a modified row, or null/false to leave the row out */
  transform?(
    row: Record<string, unknown>,
    context: SnapshotRowContext,
  ): Record<string, unknown> | null | false | Promise<Record<string, unknown> | null | false>;
}

export type SyncModelEntry = ModelStatic<any> | string | SyncModelConfig;

/**
 * The models clients may sync, as a list or keyed by the client's model name.
 * Models that are not listed are never read or written.
 */
export type SyncModels = readonly SyncModelEntry[] | Readonly<Record<string, SyncModelEntry>>;

interface ResolvedModel {
  model: ModelStatic;
  /** null when the config does not restrict attributes */
  attributes: ReadonlySet<string> | null;
  where: WhereOptions<any> | undefined;
  writeWhere: WhereOptions<any> | undefined;
  transform: SyncModelConfig['transform'];
}

export interface ChangeContext {
  model: ModelStatic;
  /** The current row, or null if it does not exist */
  existing: Model | null;
  transaction: Transaction;
  changeSet: ChangeSet;
}

export interface ApplyChangesOptions {
  /**
   * The models that clients are allowed to write to, as model classes, model names, or {@link SyncModelConfig}.
   * Changes to other models, to attributes that are not allowed, or to rows outside of `writeWhere` are rejected.
   */
  models: SyncModels;
  /** Run inside this transaction instead of creating one */
  transaction?: Transaction;
  /**
   * Called before each change is applied. Use it to authorize, rewrite or resolve conflicts.
   * Return the (possibly modified) change to apply it, or null/false to skip it.
   */
  transform?(
    change: ChangeRecord,
    context: ChangeContext,
  ): ChangeRecord | null | false | Promise<ChangeRecord | null | false>;
  /**
   * What to do when an update targets a row that does not exist on the server.
   * - `skip` (default): ignore the change
   * - `create`: create the row from the partial data
   * - `error`: abort the whole change set
   */
  onMissing?: 'skip' | 'create' | 'error';
  /** Whether to run model hooks. Default true */
  hooks?: boolean;
  /** Whether to run validations. Default true */
  validate?: boolean;
}

export type ChangeStatus = 'created' | 'updated' | 'destroyed' | 'skipped' | 'missing';

export interface ChangeResult {
  seq: number;
  model: string;
  op: ChangeRecord['op'];
  pk: Record<string, unknown>;
  status: ChangeStatus;
}

export interface ApplyChangesResult {
  clientId: string;
  /** Pass to the client's `acknowledgeChanges` */
  toSeq: number;
  applied: number;
  skipped: number;
  results: ChangeResult[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Throws if the value is not a well-formed change set (e.g. untrusted JSON from a client)
 *
 * @param value
 */
export function assertChangeSet(value: unknown): asserts value is ChangeSet {
  if (!isPlainObject(value)) {
    throw new SyncError('Change set must be an object');
  }

  if (value.format !== CHANGE_SET_FORMAT) {
    throw new SyncError(`Unknown change set format: ${String(value.format)}`);
  }

  if (value.version !== CHANGE_SET_VERSION) {
    throw new SyncError(`Unsupported change set version: ${String(value.version)}`);
  }

  if (
    typeof value.clientId !== 'string' ||
    typeof value.toSeq !== 'number' ||
    !Array.isArray(value.changes)
  ) {
    throw new SyncError('Malformed change set');
  }

  for (const change of value.changes) {
    if (
      !isPlainObject(change) ||
      typeof change.seq !== 'number' ||
      typeof change.model !== 'string' ||
      !['create', 'update', 'destroy'].includes(change.op as string) ||
      !isPlainObject(change.pk) ||
      !(change.data === null || isPlainObject(change.data))
    ) {
      throw new SyncError(`Malformed change: ${JSON.stringify(change)}`);
    }
  }
}

function isModelConfig(entry: SyncModelEntry): entry is SyncModelConfig {
  return typeof entry === 'object' && entry !== null && 'model' in entry;
}

function resolveAttributes(name: string, model: ModelStatic, config: SyncModelConfig) {
  if (config.attributes && config.exclude) {
    throw new SyncError(`Sync config for ${name} cannot have both "attributes" and "exclude"`);
  }

  const definition = model.modelDefinition;
  const listed = config.attributes ?? config.exclude;
  if (!listed) {
    return null;
  }

  for (const attribute of listed) {
    if (!definition.attributes.has(attribute)) {
      throw new SyncError(`Sync config for ${name} references unknown attribute "${attribute}"`);
    }
  }

  const primaryKeys = [...definition.primaryKeysAttributeNames];
  if (config.exclude) {
    const excluded = primaryKeys.find(key => config.exclude!.includes(key));
    if (excluded) {
      throw new SyncError(`Sync config for ${name} cannot exclude primary key "${excluded}"`);
    }

    return new Set([...definition.attributes.keys()].filter(key => !config.exclude!.includes(key)));
  }

  return new Set([...primaryKeys, ...config.attributes!]);
}

function resolveModels(sequelize: Sequelize, option: SyncModels): Map<string, ResolvedModel> {
  const models = new Map<string, ResolvedModel>();
  const entries: Array<[string | undefined, SyncModelEntry]> = Array.isArray(option)
    ? option.map(entry => [undefined, entry])
    : Object.entries(option);

  for (const [alias, entry] of entries) {
    const config: SyncModelConfig = isModelConfig(entry) ? entry : { model: entry };
    const model =
      typeof config.model === 'string' ? sequelize.models.get(config.model) : config.model;
    if (!model) {
      throw new SyncError(
        `Model "${String(config.model)}" is not defined on this Sequelize instance`,
      );
    }

    const name = alias ?? model.modelDefinition.modelName;
    models.set(name, {
      model,
      attributes: resolveAttributes(name, model, config),
      where: config.where,
      writeWhere: config.writeWhere ?? config.where,
      transform: config.transform,
    });
  }

  return models;
}

function checkAttributes(
  resolved: ResolvedModel,
  values: Record<string, unknown>,
  change: ChangeRecord,
) {
  const attributes = resolved.model.modelDefinition.attributes;
  for (const key of Object.keys(values)) {
    if (!attributes.has(key)) {
      throw new SyncError(
        `Change #${change.seq} references unknown attribute ${change.model}.${key}`,
      );
    }

    if (resolved.attributes && !resolved.attributes.has(key)) {
      throw new SyncError(
        `Change #${change.seq} writes ${change.model}.${key}, which clients are not allowed to write`,
      );
    }
  }
}

async function assertWritable(
  resolved: ResolvedModel,
  pk: Record<string, unknown>,
  change: ChangeRecord,
  transaction: Transaction,
) {
  if (!resolved.writeWhere) {
    return;
  }

  const count = await resolved.model.count({
    where: { [Op.and]: [pk, resolved.writeWhere] },
    transaction,
  });
  if (count === 0) {
    throw new SyncError(
      `Change #${change.seq} writes ${change.model} ${JSON.stringify(change.pk)}, which this client is not allowed to write`,
    );
  }
}

/**
 * Applies a change set exported by `sequelize.exportChanges()` (from `@sequelize/lite`) to a @sequelize/core
 * database, in a single transaction. Changes go through the models, so hooks & validations run.
 *
 * Applying the same change set twice is safe: creates of existing rows become updates,
 * and destroys of missing rows are ignored.
 *
 * @param sequelize
 * @param changeSet
 * @param options
 */
export async function applyChanges(
  sequelize: Sequelize,
  changeSet: unknown,
  options: ApplyChangesOptions,
): Promise<ApplyChangesResult> {
  assertChangeSet(changeSet);
  const models = resolveModels(sequelize, options.models);
  const modelOptions = {
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
    ...(options.validate === undefined ? {} : { validate: options.validate }),
  };

  const run = async (transaction: Transaction): Promise<ApplyChangesResult> => {
    const results: ChangeResult[] = [];

    for (const rawChange of changeSet.changes) {
      const resolved = models.get(rawChange.model);
      if (!resolved) {
        throw new SyncError(`Model "${rawChange.model}" is not allowed to be synced`);
      }

      const { model } = resolved;

      const primaryKeys = [...model.modelDefinition.primaryKeysAttributeNames];
      const pkKeys = Object.keys(rawChange.pk);
      if (pkKeys.length !== primaryKeys.length || !primaryKeys.every(key => pkKeys.includes(key))) {
        throw new SyncError(
          `Change #${rawChange.seq} has primary key {${pkKeys.join(', ')}} but ${rawChange.model} has {${primaryKeys.join(', ')}}`,
        );
      }

      // eslint-disable-next-line no-await-in-loop -- changes are applied in order
      const existing = await model.findOne({ where: decodeValues(rawChange.pk), transaction });
      if (existing) {
        // eslint-disable-next-line no-await-in-loop -- changes are applied in order
        await assertWritable(resolved, decodeValues(rawChange.pk), rawChange, transaction);
      }

      let change: ChangeRecord | null | false = rawChange;
      if (options.transform) {
        // eslint-disable-next-line no-await-in-loop -- changes are applied in order
        change = await options.transform(rawChange, { model, existing, transaction, changeSet });
      }

      const result = (status: ChangeStatus): ChangeResult => ({
        seq: rawChange.seq,
        model: rawChange.model,
        op: rawChange.op,
        pk: rawChange.pk,
        status,
      });

      if (!change) {
        results.push(result('skipped'));
        continue;
      }

      const pk = decodeValues(change.pk);
      const data = change.data ? decodeValues(change.data) : {};
      checkAttributes(resolved, data, change);

      if (change.op === 'destroy') {
        if (existing) {
          // eslint-disable-next-line no-await-in-loop -- changes are applied in order
          await existing.destroy({ transaction, ...modelOptions });
          results.push(result('destroyed'));
        } else {
          results.push(result('missing'));
        }

        continue;
      }

      // primary keys cannot be changed through an update
      for (const key of primaryKeys) {
        delete data[key];
      }

      if (existing) {
        // eslint-disable-next-line no-await-in-loop -- changes are applied in order
        await existing.update(data, { transaction, ...modelOptions });
        // eslint-disable-next-line no-await-in-loop -- changes are applied in order
        await assertWritable(resolved, pk, change, transaction);
        results.push(result('updated'));
        continue;
      }

      if (change.op === 'update' && (options.onMissing ?? 'skip') !== 'create') {
        if (options.onMissing === 'error') {
          throw new SyncError(
            `Change #${change.seq} updates ${change.model} ${JSON.stringify(change.pk)}, which does not exist`,
          );
        }

        results.push(result('missing'));
        continue;
      }

      // eslint-disable-next-line no-await-in-loop -- changes are applied in order
      await model.create({ ...data, ...pk }, { transaction, ...modelOptions });
      // eslint-disable-next-line no-await-in-loop -- changes are applied in order
      await assertWritable(resolved, pk, change, transaction);
      results.push(result('created'));
    }

    const skipped = results.filter(
      item => item.status === 'skipped' || item.status === 'missing',
    ).length;

    return {
      clientId: changeSet.clientId,
      toSeq: changeSet.toSeq,
      applied: results.length - skipped,
      skipped,
      results,
    };
  };

  if (options.transaction) {
    return run(options.transaction);
  }

  return sequelize.transaction(async transaction => run(transaction));
}

export interface ExportSnapshotOptions {
  /**
   * The models clients may read. Each one needs `attributes` or `exclude`, so new columns are never exported by
   * accident. Use `where` to only export rows the logged-in user may see.
   */
  models: SyncModels;
  /** Run inside this transaction instead of creating one */
  transaction?: Transaction;
}

function pick(row: Record<string, unknown>, attributes: Iterable<string>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const attribute of attributes) {
    if (attribute in row) {
      output[attribute] = row[attribute];
    }
  }

  return output;
}

/**
 * Exports the rows clients may read as a JSON-serializable snapshot, to be loaded on the client with
 * `sequelize.pullSnapshot()` / `applySnapshot()` from `@sequelize/lite`.
 *
 * Only the listed models, their allowed (non-virtual) attributes, and rows matching `where` are read from the database.
 *
 * @param sequelize
 * @param options
 */
export async function exportSnapshot(
  sequelize: Sequelize,
  options: ExportSnapshotOptions,
): Promise<Snapshot> {
  const models = resolveModels(sequelize, options.models);
  for (const [name, resolved] of models) {
    if (!resolved.attributes) {
      throw new SyncError(
        `exportSnapshot requires "attributes" or "exclude" for ${name}, so columns are never exported by accident. Use "exclude: []" to export all of them`,
      );
    }
  }

  const run = async (transaction: Transaction): Promise<Snapshot> => {
    const snapshot: Snapshot = {
      format: SNAPSHOT_FORMAT,
      version: SNAPSHOT_VERSION,
      exportedAt: new Date().toISOString(),
      models: {},
    };

    for (const [name, resolved] of models) {
      const { model } = resolved;
      const physical = model.modelDefinition.physicalAttributes;
      const attributes = [...resolved.attributes!].filter(attribute => physical.has(attribute));
      // eslint-disable-next-line no-await-in-loop -- models are exported in order, in one transaction
      const instances = await model.findAll({
        attributes,
        ...(resolved.where ? { where: resolved.where } : {}),
        order: [...model.modelDefinition.primaryKeysAttributeNames].map(key => [key, 'ASC']),
        transaction,
      });

      const rows: Array<Record<string, unknown>> = [];
      for (const instance of instances) {
        let row: Record<string, unknown> | null | false = pick(
          instance.get({ plain: true }),
          attributes,
        );
        if (resolved.transform) {
          // eslint-disable-next-line no-await-in-loop -- rows are transformed in order
          row = await resolved.transform(row, { model, instance, transaction });
        }

        if (row) {
          // a transform cannot add attributes that are not allowed
          rows.push(encodeValues(pick(row, attributes)));
        }
      }

      snapshot.models[name] = rows;
    }

    return snapshot;
  };

  if (options.transaction) {
    return run(options.transaction);
  }

  return sequelize.transaction(async transaction => run(transaction));
}

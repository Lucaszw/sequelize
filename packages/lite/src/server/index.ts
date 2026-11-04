import type { Model, ModelStatic, Sequelize, Transaction } from '@sequelize/core';
import type { ChangeRecord, ChangeSet } from '../changes.js';
import { CHANGE_SET_FORMAT, CHANGE_SET_VERSION, decodeValues } from '../changes.js';
import { SyncError } from '../errors.js';

export type { ChangeOperation, ChangeRecord, ChangeSet } from '../changes.js';

export interface ChangeContext {
  model: ModelStatic;
  /** The current row, or null if it does not exist */
  existing: Model | null;
  transaction: Transaction;
  changeSet: ChangeSet;
}

export interface ApplyChangesOptions {
  /**
   * The models that clients are allowed to write to, as model classes or model names.
   * Changes to other models are rejected.
   */
  models: ReadonlyArray<ModelStatic<any> | string> | Readonly<Record<string, ModelStatic<any>>>;
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

function resolveModels(
  sequelize: Sequelize,
  option: ApplyChangesOptions['models'],
): Map<string, ModelStatic> {
  const models = new Map<string, ModelStatic>();
  const entries: Array<[string | undefined, ModelStatic<any> | string]> = Array.isArray(option)
    ? option.map(model => [undefined, model])
    : Object.entries(option);

  for (const [alias, modelOrName] of entries) {
    const model = typeof modelOrName === 'string' ? sequelize.models.get(modelOrName) : modelOrName;
    if (!model) {
      throw new SyncError(
        `Model "${String(modelOrName)}" is not defined on this Sequelize instance`,
      );
    }

    models.set(alias ?? model.modelDefinition.modelName, model);
  }

  return models;
}

function checkAttributes(
  model: ModelStatic,
  values: Record<string, unknown>,
  change: ChangeRecord,
) {
  const attributes = model.modelDefinition.attributes;
  for (const key of Object.keys(values)) {
    if (!attributes.has(key)) {
      throw new SyncError(
        `Change #${change.seq} references unknown attribute ${change.model}.${key}`,
      );
    }
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
      const model = models.get(rawChange.model);
      if (!model) {
        throw new SyncError(`Model "${rawChange.model}" is not allowed to be synced`);
      }

      const primaryKeys = [...model.modelDefinition.primaryKeysAttributeNames];
      const pkKeys = Object.keys(rawChange.pk);
      if (pkKeys.length !== primaryKeys.length || !primaryKeys.every(key => pkKeys.includes(key))) {
        throw new SyncError(
          `Change #${rawChange.seq} has primary key {${pkKeys.join(', ')}} but ${rawChange.model} has {${primaryKeys.join(', ')}}`,
        );
      }

      // eslint-disable-next-line no-await-in-loop -- changes are applied in order
      const existing = await model.findOne({ where: decodeValues(rawChange.pk), transaction });

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
      checkAttributes(model, data, change);

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

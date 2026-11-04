export const CHANGE_SET_FORMAT = 'sequelize-lite/changes';
export const CHANGE_SET_VERSION = 1;

export type ChangeOperation = 'create' | 'update' | 'destroy';

export interface ChangeRecord {
  /** Position in the client's change log */
  seq: number;
  /** Model name, as passed to `define` */
  model: string;
  op: ChangeOperation;
  /** Primary key, keyed by attribute name */
  pk: Record<string, unknown>;
  /**
   * Attribute values, keyed by attribute name (not column name).
   * All attributes for `create`, only the updated ones for `update`, null for `destroy`.
   */
  data: Record<string, unknown> | null;
  /** ISO date of the change */
  at: string;
}

/** A JSON-serializable blob of changes, to be applied on the backend with `applyChanges` */
export interface ChangeSet {
  format: typeof CHANGE_SET_FORMAT;
  version: typeof CHANGE_SET_VERSION;
  clientId: string;
  /** Lowest change log seq included */
  fromSeq: number;
  /** Highest change log seq included. Pass to `acknowledgeChanges` once applied */
  toSeq: number;
  exportedAt: string;
  changes: ChangeRecord[];
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }

  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.codePointAt(i)!;
  }

  return bytes;
}

/**
 * Converts a value so it survives JSON serialization
 *
 * @param value
 */
export function encodeValue(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (value instanceof Uint8Array) {
    return { $bytes: bytesToBase64(value) };
  }

  return value;
}

export function decodeValue(value: unknown): unknown {
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as { $bytes?: unknown }).$bytes === 'string'
  ) {
    return base64ToBytes((value as { $bytes: string }).$bytes);
  }

  return value;
}

export function encodeValues(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, encodeValue(value)]),
  );
}

export function decodeValues(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, decodeValue(value)]),
  );
}

export function changeKey(change: Pick<ChangeRecord, 'model' | 'pk'>): string {
  const pk = Object.keys(change.pk)
    .sort()
    .map(key => [key, change.pk[key]]);

  return `${change.model}:${JSON.stringify(pk)}`;
}

/**
 * Merges multiple changes made to the same row into a single change:
 * - create + update(s) → create (at the position of the create)
 * - update + update(s) → update (at the position of the last update)
 * - create + … + destroy → nothing
 * - update + … + destroy → destroy (at the position of the destroy)
 *
 * @param changes
 */
export function coalesceChanges(changes: readonly ChangeRecord[]): ChangeRecord[] {
  const output: Array<ChangeRecord | null> = [];
  const pending = new Map<string, number>();

  for (const change of changes) {
    const key = changeKey(change);
    const index = pending.get(key);
    const previous = index === undefined ? null : output[index];

    if (!previous || previous.op === 'destroy' || change.op === 'create') {
      output.push({ ...change, data: change.data && { ...change.data } });
      pending.set(key, output.length - 1);
      continue;
    }

    if (change.op === 'destroy') {
      output[index!] = null;
      if (previous.op === 'create') {
        pending.delete(key);
      } else {
        output.push({ ...change });
        pending.set(key, output.length - 1);
      }

      continue;
    }

    const merged: ChangeRecord = {
      ...previous,
      seq: change.seq,
      at: change.at,
      data: { ...previous.data, ...change.data },
    };

    if (previous.op === 'create') {
      output[index!] = merged;
    } else {
      output[index!] = null;
      output.push(merged);
      pending.set(key, output.length - 1);
    }
  }

  return output.filter((change): change is ChangeRecord => change !== null);
}

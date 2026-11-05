export const MODEL_HOOK_NAMES = [
  'beforeValidate',
  'afterValidate',
  'validationFailed',
  'beforeCreate',
  'afterCreate',
  'beforeUpdate',
  'afterUpdate',
  'beforeSave',
  'afterSave',
  'beforeDestroy',
  'afterDestroy',
  'beforeBulkCreate',
  'afterBulkCreate',
  'beforeBulkUpdate',
  'afterBulkUpdate',
  'beforeBulkDestroy',
  'afterBulkDestroy',
  'beforeFind',
  'afterFind',
  'beforeCount',
  'beforeSync',
  'afterSync',
] as const;

export type ModelHookName = (typeof MODEL_HOOK_NAMES)[number];

export type HookCallback = (...args: any[]) => unknown;

interface HookEntry {
  name: string | undefined;
  callback: HookCallback;
}

export class HookHandler {
  readonly #listeners = new Map<string, HookEntry[]>();

  addListener(hookName: string, callback: HookCallback, listenerName?: string): this {
    assertHookName(hookName);
    const entries = this.#listeners.get(hookName) ?? [];
    if (listenerName !== undefined) {
      const existing = entries.findIndex(entry => entry.name === listenerName);
      if (existing !== -1) {
        entries.splice(existing, 1);
      }
    }

    entries.push({ name: listenerName, callback });
    this.#listeners.set(hookName, entries);

    return this;
  }

  removeListener(hookName: string, callbackOrName: HookCallback | string): this {
    const entries = this.#listeners.get(hookName);
    if (!entries) {
      return this;
    }

    this.#listeners.set(
      hookName,
      entries.filter(entry => {
        return typeof callbackOrName === 'string'
          ? entry.name !== callbackOrName
          : entry.callback !== callbackOrName;
      }),
    );

    return this;
  }

  removeAllListeners(hookName?: string): this {
    if (hookName === undefined) {
      this.#listeners.clear();
    } else {
      this.#listeners.delete(hookName);
    }

    return this;
  }

  hasListeners(hookName: string): boolean {
    return (this.#listeners.get(hookName)?.length ?? 0) > 0;
  }

  async runAsync(hookName: string, ...args: unknown[]): Promise<void> {
    // copy so listeners can remove themselves while running
    for (const entry of this.#listeners.get(hookName) ?? []) {
      // eslint-disable-next-line no-await-in-loop -- hooks run sequentially, like in @sequelize/core
      await entry.callback(...args);
    }
  }
}

function assertHookName(hookName: string) {
  if (!(MODEL_HOOK_NAMES as readonly string[]).includes(hookName)) {
    throw new Error(
      `"${hookName}" is not a valid hook name. Valid hooks are: ${MODEL_HOOK_NAMES.join(', ')}`,
    );
  }
}

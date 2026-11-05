import { PGlite } from '@electric-sql/pglite';
import type { Model } from '@sequelize/lite';
import { DataTypes, Sequelize, ValidationError } from '@sequelize/lite';

interface TodoAttributes {
  id: string;
  title: string;
  done: boolean;
  tags: string[] | null;
}

type Todo = Model<TodoAttributes, Partial<TodoAttributes>> & TodoAttributes;

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

function log(message: unknown) {
  $('#log').textContent += `${typeof message === 'string' ? message : JSON.stringify(message)}\n`;
}

// 'idb://' persists the database in IndexedDB, so data survives reloads and works offline
const sequelize = new Sequelize({ pglite: new PGlite('idb://sequelize-lite-example') });

const TodoModel = sequelize.define<Todo>(
  'Todo',
  {
    // client-generated ids, so rows created offline never clash with rows created elsewhere
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    title: { type: DataTypes.STRING, allowNull: false, validate: { len: [1, 50] } },
    done: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    tags: DataTypes.ARRAY(DataTypes.TEXT),
  },
  {
    hooks: {
      beforeSave(todo: Todo) {
        todo.title = todo.title.trim();
      },
    },
  },
);

async function render() {
  const todos = await TodoModel.findAll({ order: [['createdAt', 'ASC']] });
  $('#todos').textContent = todos
    .map(todo => `${todo.done ? '[x]' : '[ ]'} ${todo.title}`)
    .join('\n');
  $('#pending').textContent = String(await sequelize.countPendingChanges());
}

async function sync() {
  try {
    const result = await sequelize.pushChanges(async changeSet => {
      log(`sending ${changeSet.changes.length} change(s)`);
      const response = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(changeSet),
      });
      if (!response.ok) {
        // throwing keeps the changes, they will be sent again on the next sync
        throw new Error(await response.text());
      }

      return response.json();
    });
    log(result ?? 'nothing to sync');
  } catch (error) {
    log(`sync failed, changes kept: ${(error as Error).message}`);
  }

  await render();
}

async function main() {
  await sequelize.sync();
  await render();

  $('#add').addEventListener('click', async () => {
    const input = $<HTMLInputElement>('#title');
    try {
      await TodoModel.create({ title: input.value, tags: ['example'] });
      input.value = '';
    } catch (error) {
      if (!(error instanceof ValidationError)) {
        throw error;
      }

      log(`invalid: ${error.errors.map(item => item.message).join(', ')}`);
    }

    await render();
  });

  $('#complete').addEventListener('click', async () => {
    await TodoModel.update({ done: true }, { where: { done: false } });
    await render();
  });

  $('#clear').addEventListener('click', async () => {
    await TodoModel.destroy({ where: { done: true } });
    await render();
  });

  $('#sync').addEventListener('click', sync);
  // push automatically when the browser comes back online
  window.addEventListener('online', sync);
}

void main();

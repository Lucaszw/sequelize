import { DataTypes, Sequelize } from '@sequelize/core';
import { applyChanges } from '@sequelize/lite/server';
import { PostgresDialect } from '@sequelize/postgres';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const { env } = process;
const sequelize = new Sequelize({
  dialect: PostgresDialect,
  host: env.PGHOST ?? '127.0.0.1',
  port: Number(env.PGPORT ?? 5432),
  user: env.PGUSER ?? 'postgres',
  password: env.PGPASSWORD ?? 'postgres',
  database: env.PGDATABASE ?? 'postgres',
  logging: false,
});

const Todo = sequelize.define(
  'Todo',
  {
    // same attributes as the client model
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    title: { type: DataTypes.STRING, allowNull: false, validate: { len: [1, 50] } },
    done: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    tags: DataTypes.ARRAY(DataTypes.TEXT),
    // server-only column, set by a server hook
    syncedAt: DataTypes.DATE,
  },
  {
    tableName: 'example_todos',
    hooks: {
      beforeSave(todo) {
        todo.set('syncedAt', new Date());
      },
    },
  },
);

const publicDir = path.join(__dirname, 'public');
const contentTypes: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
};

async function readBody(req: http.IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
  }

  return body;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/sync') {
      const result = await applyChanges(sequelize, JSON.parse(await readBody(req)), {
        models: [Todo],
      });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(result));

      return;
    }

    if (req.url === '/api/todos') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(await Todo.findAll({ raw: true, order: [['title', 'ASC']] })));

      return;
    }

    const file = path.basename(req.url === '/' ? 'index.html' : req.url!);
    res.setHeader('content-type', contentTypes[path.extname(file)] ?? 'application/octet-stream');
    res.end(await readFile(path.join(publicDir, file)));
  } catch (error) {
    res.statusCode = 400;
    res.end((error as Error).message);
  }
});

async function main() {
  await sequelize.sync();
  const port = Number(env.PORT ?? 4321);
  server.listen(port, () => {
    console.log(`Example running on http://localhost:${port}`);
  });
}

void main();

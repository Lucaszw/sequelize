#!/usr/bin/env node

// Bundles the example: the client for the browser, the server for Node.
import esbuild from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const dir = import.meta.dirname;
const out = path.join(dir, 'dist');
const publicDir = path.join(out, 'public');
const pgliteDist = path.dirname(createRequire(import.meta.url).resolve('@electric-sql/pglite'));

await mkdir(publicDir, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(dir, 'client.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: path.join(publicDir, 'client.js'),
});

await esbuild.build({
  entryPoints: [path.join(dir, 'server.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  outfile: path.join(out, 'server.js'),
});

await copyFile(path.join(dir, 'index.html'), path.join(publicDir, 'index.html'));
// PGlite loads these next to the bundle
await Promise.all(
  ['pglite.wasm', 'pglite.data', 'initdb.wasm'].map(async file =>
    copyFile(path.join(pgliteDist, file), path.join(publicDir, file)),
  ),
);

console.log(
  `Built to ${out}. Run: node ${path.relative(process.cwd(), path.join(out, 'server.js'))}`,
);

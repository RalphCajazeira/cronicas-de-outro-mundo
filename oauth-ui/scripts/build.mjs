import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

await mkdir(dist, { recursive: true });
await build({
  entryPoints: [path.join(root, 'src/main.ts')],
  outfile: path.join(dist, 'app.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  legalComments: 'none',
  sourcemap: false,
  minify: true,
});
const template = await readFile(path.join(root, 'index.template.html'), 'utf8');
await writeFile(path.join(dist, 'index.html'), template, 'utf8');
await cp(path.join(root, 'src/styles.css'), path.join(dist, 'styles.css'));

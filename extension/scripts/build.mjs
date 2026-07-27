import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (...segments) => path.join(extensionRoot, 'src', ...segments);
const dist = path.join(extensionRoot, 'dist');

const options = {
  bundle: true,
  target: 'es2022',
  sourcemap: false,
  legalComments: 'none',
  loader: { '.css': 'text' },
};

async function prepare() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  await cp(path.join(extensionRoot, 'manifest', 'manifest.json'), path.join(dist, 'manifest.json'));
  await cp(source('pages', 'page.html'), path.join(dist, 'page.html'));
}

async function buildAll(watch) {
  await prepare();
  const entries = [
    { entryPoints: [source('background', 'service-worker.ts')], outfile: path.join(dist, 'background', 'service-worker.js'), format: 'esm' },
    { entryPoints: [source('content', 'content-script.ts')], outfile: path.join(dist, 'content', 'content-script.js'), format: 'iife' },
    { entryPoints: [source('pages', 'page.ts')], outfile: path.join(dist, 'page.js'), format: 'esm' },
  ];
  if (!watch) {
    await Promise.all(entries.map((entry) => build({ ...options, ...entry })));
    return;
  }
  const contexts = await Promise.all(entries.map((entry) => context({ ...options, ...entry })));
  await Promise.all(contexts.map((instance) => instance.watch()));
  process.stdout.write('Watching extension sources. Reload the unpacked extension after changes.\n');
}

await buildAll(process.argv.includes('--watch'));

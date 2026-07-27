import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(extensionRoot, '..');
const [rootPackage, renderYaml] = await Promise.all([
  readFile(path.join(repositoryRoot, 'package.json'), 'utf8').then(JSON.parse),
  readFile(path.join(repositoryRoot, 'render.yaml'), 'utf8'),
]);

const scripts = rootPackage.scripts;
const prefixes = new Set();
const visited = new Set();
function collectBuildPrefixes(scriptName) {
  if (visited.has(scriptName)) return;
  visited.add(scriptName);
  const script = scripts?.[scriptName];
  if (typeof script !== 'string') throw new Error(`Root build references missing script ${scriptName}.`);
  for (const match of script.matchAll(/--prefix\s+([^\s&]+)/g)) prefixes.add(match[1]);
  for (const match of script.matchAll(/npm run (build:[\w-]+)/g)) collectBuildPrefixes(match[1]);
}
collectBuildPrefixes('build');
const renderBuildCommand = renderYaml.match(/^\s*buildCommand:\s*(.+)$/m)?.[1];
if (renderBuildCommand === undefined) throw new Error('Render buildCommand is missing.');

for (const prefix of prefixes) {
  const install = `npm ci --prefix ${prefix} --include=dev`;
  if (!renderBuildCommand.includes(install)) {
    throw new Error(`Render buildCommand must install ${prefix} with npm ci --include=dev.`);
  }
}
if (!renderBuildCommand.includes('npm run build')) throw new Error('Render buildCommand must invoke the root build.');
process.stdout.write(`Render build validation passed for: ${[...prefixes].join(', ')}.\n`);

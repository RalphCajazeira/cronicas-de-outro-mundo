import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function splitCommandChain(command) {
  return command
    .split('&&')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function collectPrefixes(scripts, scriptName, prefixes = new Set(), visited = new Set()) {
  if (visited.has(scriptName)) return prefixes;
  visited.add(scriptName);
  const script = scripts?.[scriptName];
  if (typeof script !== 'string') throw new Error(`Root build references missing script ${scriptName}.`);
  for (const match of script.matchAll(/--prefix\s+([^\s&|;]+)/g)) prefixes.add(match[1]);
  for (const match of script.matchAll(/npm run (build:[\w-]+)/g)) collectPrefixes(scripts, match[1], prefixes, visited);
  return prefixes;
}

export function hasExactRootBuildCommand(command) {
  return splitCommandChain(command).some((segment) => /^npm\s+run\s+build\s*$/.test(segment));
}

export async function validateRenderBuildConfiguration({ rootPackage, renderYaml }) {
  const scripts = rootPackage.scripts;
  const prefixes = collectPrefixes(scripts, 'build');
  const renderBuildCommand = renderYaml.match(/^\s*buildCommand:\s*(.+)$/m)?.[1];
  if (renderBuildCommand === undefined) throw new Error('Render buildCommand is missing.');
  for (const prefix of prefixes) {
    const install = `npm ci --prefix ${prefix} --include=dev`;
    if (!renderBuildCommand.includes(install)) {
      throw new Error(`Render buildCommand must install ${prefix} with npm ci --include=dev.`);
    }
  }
  if (!hasExactRootBuildCommand(renderBuildCommand)) throw new Error('Render buildCommand must invoke npm run build as an independent command segment.');
  return { prefixes: [...prefixes], command: renderBuildCommand };
}

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(extensionRoot, '..');
const [rootPackage, renderYaml] = await Promise.all([
  readFile(path.join(repositoryRoot, 'package.json'), 'utf8').then(JSON.parse),
  readFile(path.join(repositoryRoot, 'render.yaml'), 'utf8'),
]);
const result = await validateRenderBuildConfiguration({ rootPackage, renderYaml });
process.stdout.write(`Render build validation passed for: ${result.prefixes.join(', ')}.\n`);

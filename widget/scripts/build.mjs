import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const widgetRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDirectory = path.join(widgetRoot, 'dist');

async function bundle(entryPoint) {
  const result = await build({
    entryPoints: [path.join(widgetRoot, entryPoint)],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    legalComments: 'none',
  });
  const output = result.outputFiles?.[0];
  if (output === undefined) throw new Error(`No bundle produced for ${entryPoint}`);
  return output.text.replaceAll('</script', '<\\/script');
}

async function buildHtml({ template, styles, entryPoint, output }) {
  const [htmlTemplate, css, script] = await Promise.all([
    readFile(path.join(widgetRoot, template), 'utf8'),
    readFile(path.join(widgetRoot, styles), 'utf8'),
    bundle(entryPoint),
  ]);
  const html = htmlTemplate
    .replace('/*__STYLES__*/', () => css)
    .replace('/*__SCRIPT__*/', () => script);
  await writeFile(path.join(distDirectory, output), html, 'utf8');
}

await mkdir(distDirectory, { recursive: true });
await Promise.all([
  buildHtml({
    template: 'home.template.html',
    styles: 'src/styles.css',
    entryPoint: 'src/main.ts',
    output: 'home.html',
  }),
  buildHtml({
    template: 'preview.template.html',
    styles: 'src/preview.css',
    entryPoint: 'src/preview-host.ts',
    output: 'preview.html',
  }),
]);

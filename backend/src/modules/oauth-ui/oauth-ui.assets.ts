import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface OAuthUiAssets {
  readHtml(): Promise<string>;
  readScript(): Promise<Buffer>;
  readStyles(): Promise<Buffer>;
}

async function readAsset(fileName: string): Promise<Buffer> {
  const candidates = [
    path.resolve(process.cwd(), 'oauth-ui', 'dist', fileName),
    path.resolve(process.cwd(), '..', 'oauth-ui', 'dist', fileName),
  ];
  for (const candidate of candidates) {
    try {
      return await readFile(candidate);
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code !== 'ENOENT') throw error;
    }
  }
  throw new Error(`OAuth UI asset is not built: ${fileName}`);
}

export function createFileOAuthUiAssets(): OAuthUiAssets {
  return {
    readHtml: async () => (await readAsset('index.html')).toString('utf8'),
    readScript: () => readAsset('app.js'),
    readStyles: () => readAsset('styles.css'),
  };
}

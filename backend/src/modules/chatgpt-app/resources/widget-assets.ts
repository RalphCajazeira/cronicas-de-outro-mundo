import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface WidgetAssets {
  readHome(): Promise<string>;
  readPreview(): Promise<string>;
}

async function readWidgetAsset(fileName: string): Promise<string> {
  const candidates = [
    path.resolve(process.cwd(), 'widget', 'dist', fileName),
    path.resolve(process.cwd(), '..', 'widget', 'dist', fileName),
  ];

  for (const candidate of candidates) {
    try {
      return await readFile(candidate, 'utf8');
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code !== 'ENOENT') throw error;
    }
  }

  throw new Error(`Widget asset is not built: ${fileName}`);
}

export function createFileWidgetAssets(): WidgetAssets {
  return {
    readHome: () => readWidgetAsset('home.html'),
    readPreview: () => readWidgetAsset('preview.html'),
  };
}

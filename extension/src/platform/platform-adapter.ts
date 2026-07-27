import type { ExtensionPreferences } from '../shared/types.js';

export type GameAppMode = 'web' | 'overlay' | 'extension-page';

export interface PlatformAdapter {
  readonly mode: GameAppMode;
  readPreferences(): Promise<ExtensionPreferences>;
  savePreferences(patch: Partial<ExtensionPreferences>): Promise<ExtensionPreferences>;
  openFullPage?: () => Promise<void>;
  minimize?: () => Promise<void>;
  close?: () => Promise<void>;
}

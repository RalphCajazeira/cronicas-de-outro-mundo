import { sendExtensionMessage } from '../shared/messages.js';
import { readPreferences } from '../shared/preferences.js';
import type { PlatformAdapter, GameAppMode } from './platform-adapter.js';

export function createExtensionPlatform(mode: Extract<GameAppMode, 'overlay' | 'extension-page'>): PlatformAdapter {
  return {
    mode,
    readPreferences,
    async savePreferences(patch) {
      const response = await sendExtensionMessage({ type: 'SAVE_PREFERENCES', preferences: patch });
      if (!response.ok || response.preferences === undefined) throw new Error('Não foi possível salvar as preferências visuais.');
      return response.preferences;
    },
    ...(mode === 'overlay' ? {
      openFullPage: async () => { await sendExtensionMessage({ type: 'OPEN_PAGE' }); },
      minimize: async () => { await sendExtensionMessage({ type: 'MINIMIZE' }); },
      close: async () => { await sendExtensionMessage({ type: 'CLOSE_OVERLAY' }); },
    } : {}),
  };
}

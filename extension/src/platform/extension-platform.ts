import { isExtensionAuthStateChangedEvent, sendExtensionMessage } from '../shared/messages.js';
import { readPreferences } from '../shared/preferences.js';
import type { PlatformAdapter, GameAppMode } from './platform-adapter.js';
import type { PublicAuthState } from '../auth/auth-types.js';

async function authMessage(type: 'AUTH_GET_STATE' | 'AUTH_LOGIN' | 'AUTH_LOGOUT' | 'AUTH_RETRY'): Promise<PublicAuthState> {
  const response = await sendExtensionMessage({ type });
  if (!response.ok || response.auth === undefined) return { status: 'error', code: 'backend_unavailable' };
  return response.auth;
}

export function createExtensionPlatform(mode: Extract<GameAppMode, 'overlay' | 'extension-page'>): PlatformAdapter {
  return {
    mode,
    readAuthState: () => authMessage('AUTH_GET_STATE'),
    login: () => authMessage('AUTH_LOGIN'),
    logout: () => authMessage('AUTH_LOGOUT'),
    subscribeAuthState(listener) {
      const messages = chrome.runtime.onMessage;
      if (messages === undefined) return () => undefined;
      const onMessage = (message: unknown) => {
        if (isExtensionAuthStateChangedEvent(message)) listener(message.auth);
      };
      messages.addListener(onMessage);
      return () => messages.removeListener(onMessage);
    },
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

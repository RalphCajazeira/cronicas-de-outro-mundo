import { DEFAULT_PREFERENCES, normalizePreferences } from '../shared/preferences.js';
import type { ExtensionPreferences } from '../shared/types.js';
import type { PlatformAdapter } from './platform-adapter.js';

const WEB_PREFERENCES_KEY = 'cronicas.web.visual-preferences';

function readStoredPreferences(): ExtensionPreferences {
  try {
    return normalizePreferences(JSON.parse(window.localStorage.getItem(WEB_PREFERENCES_KEY) ?? 'null'));
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function createWebPlatform(): PlatformAdapter {
  return {
    mode: 'web',
    readAuthState: () => Promise.resolve({ status: 'signed_out' }),
    login: () => Promise.resolve({ status: 'signed_out' }),
    logout: () => Promise.resolve({ status: 'signed_out' }),
    readPreferences() { return Promise.resolve(readStoredPreferences()); },
    savePreferences(patch) {
      const next = normalizePreferences({ ...readStoredPreferences(), ...patch });
      try { window.localStorage.setItem(WEB_PREFERENCES_KEY, JSON.stringify(next)); } catch { /* optional web preference */ }
      return Promise.resolve(next);
    },
  };
}

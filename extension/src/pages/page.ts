import { createAppShell } from '../shell/app-shell.js';
import { sendExtensionMessage } from '../shared/messages.js';
import { readPreferences } from '../shared/preferences.js';

async function mountPage(): Promise<void> {
  const root = document.getElementById('app');
  if (root === null) return;
  const preferences = await readPreferences();
  createAppShell({
    root,
    mode: 'page',
    preferences,
    onPreferencesChange: (patch) => { void sendExtensionMessage({ type: 'SAVE_PREFERENCES', preferences: patch }); },
    onModeChange: () => {},
    onOpenPage: () => { void sendExtensionMessage({ type: 'OPEN_PAGE' }); },
  });
}

void mountPage();

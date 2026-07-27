import { createAppShell, type ShellController } from '../shell/app-shell.js';
import { readPreferences } from '../shared/preferences.js';
import { sendExtensionMessage } from '../shared/messages.js';

const CONTENT_HOST_ID = 'cronicas-extension-root';

export async function mountContentShell(): Promise<ShellController | undefined> {
  const existing = document.getElementById(CONTENT_HOST_ID);
  if (existing?.shadowRoot !== null && existing?.shadowRoot !== undefined) return undefined;
  if (existing !== null) return undefined;
  if (document.documentElement === null) return undefined;
  const host = document.createElement('div');
  host.id = CONTENT_HOST_ID;
  host.setAttribute('data-cronicas-extension', 'root');
  const shadowRoot = host.attachShadow({ mode: 'open' });
  document.documentElement.append(host);
  const preferences = await readPreferences();
  return createAppShell({
    root: shadowRoot,
    mode: 'content',
    preferences,
    onPreferencesChange: (patch) => { void sendExtensionMessage({ type: 'SAVE_PREFERENCES', preferences: patch }); },
    onModeChange: (type) => { void sendExtensionMessage({ type }); },
    onOpenPage: () => { void sendExtensionMessage({ type: 'OPEN_PAGE' }); },
  });
}

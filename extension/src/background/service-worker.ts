import { isExtensionAuthStateChangedEvent, isExtensionMessage, type ExtensionResponse } from '../shared/messages.js';
import { readPreferences, savePreferences } from '../shared/preferences.js';
import { getAuthState, login, logout } from './auth-session.js';

function publishAuthState(auth: import('../auth/auth-types.js').PublicAuthState): void {
  void Promise.resolve(chrome.runtime.sendMessage({ type: 'AUTH_STATE_CHANGED', auth })).catch(() => undefined);
}

chrome.runtime.onMessage.addListener((rawMessage: unknown, sender, sendResponse: (response: ExtensionResponse) => void) => {
  if (isExtensionAuthStateChangedEvent(rawMessage)) return false;
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, error: 'INVALID_MESSAGE' });
    return false;
  }
  if (!isExtensionMessage(rawMessage)) {
    sendResponse({ ok: false, error: 'INVALID_MESSAGE' });
    return false;
  }
  void (async () => {
    try {
      if (rawMessage.type === 'PING') {
        sendResponse({ ok: true, pong: true });
        return;
      }
      if (rawMessage.type === 'AUTH_GET_STATE' || rawMessage.type === 'AUTH_RETRY') {
        const auth = await getAuthState();
        publishAuthState(auth);
        sendResponse({ ok: true, auth });
        return;
      }
      if (rawMessage.type === 'AUTH_LOGIN') {
        const operation = login();
        publishAuthState({ status: 'authorizing' });
        const auth = await operation;
        publishAuthState(auth);
        sendResponse({ ok: true, auth });
        return;
      }
      if (rawMessage.type === 'AUTH_LOGOUT') {
        const auth = await logout();
        publishAuthState(auth);
        sendResponse({ ok: true, auth });
        return;
      }
      if (rawMessage.type === 'GET_PREFERENCES') {
        sendResponse({ ok: true, preferences: await readPreferences() });
        return;
      }
      if (rawMessage.type === 'SAVE_PREFERENCES') {
        sendResponse({ ok: true, preferences: await savePreferences(rawMessage.preferences) });
        return;
      }
      if (rawMessage.type === 'OPEN_PAGE') {
        await savePreferences({ lastMode: 'page' });
        await chrome.tabs.create({ url: chrome.runtime.getURL('page.html') });
        sendResponse({ ok: true });
        return;
      }
      const lastMode = rawMessage.type === 'OPEN_OVERLAY' ? 'overlay' : 'minimized';
      sendResponse({ ok: true, preferences: await savePreferences({ lastMode }) });
    } catch {
      sendResponse({ ok: false, error: 'UNAVAILABLE' });
    }
  })();
  return true;
});

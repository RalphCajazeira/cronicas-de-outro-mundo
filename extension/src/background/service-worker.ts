import { isExtensionMessage, type ExtensionResponse } from '../shared/messages.js';
import { readPreferences, savePreferences } from '../shared/preferences.js';

chrome.runtime.onMessage.addListener((rawMessage: unknown, _sender, sendResponse: (response: ExtensionResponse) => void) => {
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

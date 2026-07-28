import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/shared/preferences.js', () => ({
  readPreferences: vi.fn(),
  savePreferences: vi.fn((preferences: unknown) => Promise.resolve(preferences)),
}));

type OnMessageListener = (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => void;

function installChromeMock(): void {
  const listeners: OnMessageListener[] = [];
  Object.assign(globalThis, {
    chrome: {
      runtime: {
        id: 'test',
        getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
        onMessage: {
          addListener: vi.fn((listener: OnMessageListener) => listeners.push(listener)),
        },
        sendMessage: vi.fn(),
      },
      tabs: {
        create: vi.fn(),
      },
    },
    __chroniclesServiceWorkerListener: listeners,
  });
}

afterEach(() => {
  delete (globalThis as { [key: string]: unknown }).__chroniclesServiceWorkerListener;
});

describe('service worker messages', () => {
  it('opens a page tab on OPEN_PAGE using extension URL exactly once', async () => {
    installChromeMock();
    await import('../src/background/service-worker.js');
    type GlobalListenerState = { __chroniclesServiceWorkerListener?: OnMessageListener[] };
    const listeners = (globalThis as GlobalListenerState).__chroniclesServiceWorkerListener;
    const listener = listeners?.[0];
    expect(listener).toBeDefined();
    const response = new Promise<Record<string, unknown>>((resolve) => {
      listener?.({ type: 'OPEN_PAGE' }, { id: 'test' }, (value: unknown) => resolve(value as Record<string, unknown>));
    });
    const result = await response;
    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'chrome-extension://test/page.html' });
    expect(chrome.runtime.getURL).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true });
  });
});

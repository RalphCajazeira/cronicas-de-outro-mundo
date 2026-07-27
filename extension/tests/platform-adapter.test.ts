import { describe, expect, it, vi } from 'vitest';
import { createExtensionPlatform } from '../src/platform/extension-platform.js';
import { createWebPlatform } from '../src/platform/web-platform.js';
import { DEFAULT_PREFERENCES } from '../src/shared/preferences.js';

describe('platform adapters', () => {
  it('keeps the web adapter independent from Chrome', async () => {
    const previousChrome = (globalThis as { chrome?: unknown }).chrome;
    delete (globalThis as { chrome?: unknown }).chrome;
    const adapter = createWebPlatform();
    await expect(adapter.savePreferences({ activeTab: 'inventory' })).resolves.toMatchObject({ activeTab: 'inventory' });
    (globalThis as { chrome?: unknown }).chrome = previousChrome;
  });

  it('sends extension commands only through the adapter', async () => {
    const sendMessage = vi.fn(() => Promise.resolve({ ok: true, preferences: DEFAULT_PREFERENCES }));
    Object.assign(globalThis, { chrome: { runtime: { sendMessage } } });
    const adapter = createExtensionPlatform('overlay');
    await adapter.openFullPage?.();
    await adapter.minimize?.();
    await adapter.close?.();
    await adapter.savePreferences({ activeTab: 'inventory' });
    expect(sendMessage).toHaveBeenCalledWith({ type: 'OPEN_PAGE' });
    expect(sendMessage).toHaveBeenCalledWith({ type: 'MINIMIZE' });
    expect(sendMessage).toHaveBeenCalledWith({ type: 'CLOSE_OVERLAY' });
    expect(sendMessage).toHaveBeenCalledWith({ type: 'SAVE_PREFERENCES', preferences: { activeTab: 'inventory' } });
  });
});

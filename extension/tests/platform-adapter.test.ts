// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createExtensionPlatform } from '../src/platform/extension-platform.js';
import { createWebPlatform } from '../src/platform/web-platform.js';
import { DEFAULT_PREFERENCES } from '../src/shared/preferences.js';
import type { ExtensionPreferences } from '../src/shared/types.js';

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

  it('preserves web adapter preference storage and order', async () => {
    const key = 'cronicas.web.visual-preferences';
    window.localStorage.removeItem(key);
    const adapter = createWebPlatform();
    const first = await adapter.savePreferences({ activeTab: 'inventory' });
    const second = await adapter.savePreferences({ activeTab: 'summary' });
    expect(first.activeTab).toBe('inventory');
    expect(second.activeTab).toBe('summary');
    await expect(adapter.readPreferences()).resolves.toMatchObject({ ...DEFAULT_PREFERENCES, activeTab: 'summary' } satisfies ExtensionPreferences);
    const stored = window.localStorage.getItem(key);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored as string)).toMatchObject({ ...DEFAULT_PREFERENCES, activeTab: 'summary' });
  });

  it('forwards SAVE_PREFERENCES in logical order', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const sendMessage = vi.fn((message: { readonly type: string; readonly preferences?: Partial<ExtensionPreferences> }) => {
      sent.push(message);
      const preferences = message.preferences ?? {};
      return Promise.resolve({ ok: true, preferences: { ...DEFAULT_PREFERENCES, ...preferences } });
    });
    Object.assign(globalThis, { chrome: { runtime: { sendMessage } } });
    const adapter = createExtensionPlatform('overlay');
    await adapter.savePreferences({ activeTab: 'summary' });
    await adapter.savePreferences({ activeTab: 'inventory' });
    await adapter.savePreferences({ activeTab: 'abilities' });
    expect(sent).toEqual([
      { type: 'SAVE_PREFERENCES', preferences: { activeTab: 'summary' } },
      { type: 'SAVE_PREFERENCES', preferences: { activeTab: 'inventory' } },
      { type: 'SAVE_PREFERENCES', preferences: { activeTab: 'abilities' } },
    ]);
  });
});

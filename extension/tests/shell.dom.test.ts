// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountContentShell } from '../src/content/mount.js';
import { createAppShell } from '../src/shell/app-shell.js';
import { DEFAULT_PREFERENCES } from '../src/shared/preferences.js';

function installChromeMock(): void {
  const values: Record<string, unknown> = {};
  Object.assign(globalThis, {
    chrome: {
      storage: {
        local: {
          get: vi.fn((key: string) => Promise.resolve({ [key]: values[key] })),
          set: vi.fn((patch: Record<string, unknown>) => { Object.assign(values, patch); return Promise.resolve(); }),
        },
      },
      runtime: { sendMessage: vi.fn(() => Promise.resolve({ ok: true })) },
    },
  });
}

afterEach(() => { document.body.replaceChildren(); document.head.replaceChildren(); });

describe('content shell DOM', () => {
  it('mounts exactly once in an open Shadow DOM without touching the host conversation', async () => {
    installChromeMock();
    document.body.innerHTML = '<main id="conversation">A conversa hospedeira permanece intacta.</main>';
    await mountContentShell();
    await mountContentShell();
    const host = document.getElementById('cronicas-extension-root');
    expect(host).not.toBeNull();
    expect(host?.shadowRoot).not.toBeNull();
    expect(document.querySelectorAll('#cronicas-extension-root')).toHaveLength(1);
    expect(document.getElementById('conversation')?.textContent).toContain('permanece intacta');
    expect(document.head.querySelector('style')).toBeNull();
    expect(host?.shadowRoot?.querySelector('style')).not.toBeNull();
  });

  it('traps Tab boundaries using ShadowRoot.activeElement and releases after Escape', async () => {
    installChromeMock();
    await mountContentShell();
    const shadowRoot = document.getElementById('cronicas-extension-root')?.shadowRoot;
    expect(shadowRoot).not.toBeNull();
    const launcher = shadowRoot?.querySelector<HTMLButtonElement>('.chronicles-launcher');
    launcher?.click();
    const overlay = shadowRoot?.querySelector<HTMLElement>('.chronicles-overlay');
    const controls = [...(overlay?.querySelectorAll<HTMLElement>('button') ?? [])];
    const first = controls[0];
    const last = controls.at(-1);
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    last?.focus();
    expect(shadowRoot?.activeElement).toBe(last);
    last?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, composed: true }));
    expect(shadowRoot?.activeElement).toBe(first);
    first?.focus();
    first?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, composed: true }));
    expect(shadowRoot?.activeElement).toBe(last);
    last?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
    expect(overlay?.hidden).toBe(true);
    expect(shadowRoot?.activeElement).toBe(launcher);
    shadowRoot?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, composed: true }));
    expect(overlay?.hidden).toBe(true);
  });

  it('opens, minimizes, closes with Escape, and restores focus to the launcher', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const onModeChange = vi.fn();
    const shell = createAppShell({
      root, mode: 'content', preferences: DEFAULT_PREFERENCES, onPreferencesChange: vi.fn(), onModeChange, onOpenPage: vi.fn(),
    });
    const launcher = root.querySelector<HTMLButtonElement>('.chronicles-launcher');
    const overlay = root.querySelector<HTMLElement>('.chronicles-overlay');
    expect(launcher).not.toBeNull();
    launcher?.click();
    expect(overlay?.hidden).toBe(false);
    expect(onModeChange).toHaveBeenCalledWith('OPEN_OVERLAY');
    expect(document.activeElement?.textContent).toBe('Fechar');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(overlay?.hidden).toBe(true);
    expect(document.activeElement).toBe(launcher);
    expect(onModeChange).toHaveBeenCalledWith('CLOSE_OVERLAY');
    shell.open();
    root.querySelector<HTMLButtonElement>('.chronicles-actions button:nth-child(2)')?.click();
    expect(overlay?.hidden).toBe(true);
    expect(onModeChange).toHaveBeenCalledWith('MINIMIZE');
    shell.destroy();
  });

  it('renders the same full shell in an extension page context', () => {
    const root = document.createElement('main');
    document.body.append(root);
    createAppShell({
      root, mode: 'page', preferences: { ...DEFAULT_PREFERENCES, activeTab: 'abilities' }, onPreferencesChange: vi.fn(), onModeChange: vi.fn(), onOpenPage: vi.fn(),
    });
    expect(root.querySelector('.chronicles-launcher')).toBeNull();
    expect(root.querySelectorAll('.chronicles-action')).toHaveLength(0);
    expect(root.textContent).toContain('Modo de demonstração local');
    expect(root.textContent).toContain('Luz Velada');
    root.querySelector<HTMLButtonElement>('[data-tab="inventory"]')?.click();
    expect(root.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Inventário');
    expect(root.textContent).toContain('Poção de Bruma');
  });

  it('keeps overlay controls available while omitting them from the page shell', () => {
    const root = document.createElement('div');
    document.body.append(root);
    createAppShell({
      root, mode: 'content', preferences: DEFAULT_PREFERENCES, onPreferencesChange: vi.fn(), onModeChange: vi.fn(), onOpenPage: vi.fn(),
    });
    expect(root.querySelectorAll('.chronicles-action')).toHaveLength(3);
  });
});

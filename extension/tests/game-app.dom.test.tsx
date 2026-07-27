// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameApp } from '../src/app/GameApp.js';
import { mountContentShell } from '../src/content/mount.js';
import type { PlatformAdapter } from '../src/platform/platform-adapter.js';
import { DEFAULT_PREFERENCES } from '../src/shared/preferences.js';

function adapter(mode: PlatformAdapter['mode']): PlatformAdapter {
  return {
    mode,
    readPreferences: vi.fn(() => Promise.resolve(DEFAULT_PREFERENCES)),
    savePreferences: vi.fn(() => Promise.resolve(DEFAULT_PREFERENCES)),
    ...(mode === 'overlay' ? { openFullPage: vi.fn(() => Promise.resolve()), minimize: vi.fn(() => Promise.resolve()), close: vi.fn(() => Promise.resolve()) } : {}),
  };
}

function installChromeMock(): void {
  Object.assign(globalThis, { chrome: { storage: { local: { get: vi.fn(() => Promise.resolve({})), set: vi.fn(() => Promise.resolve()) } }, runtime: { sendMessage: vi.fn(() => Promise.resolve({ ok: true, preferences: DEFAULT_PREFERENCES })) } } });
}

afterEach(() => { document.body.replaceChildren(); document.head.replaceChildren(); });

describe('GameApp', () => {
  it('renders the fixture and navigates in web mode without Chrome APIs', () => {
    const gameAdapter = adapter('web');
    render(<GameApp adapter={gameAdapter} />);
    expect(screen.getByText('Modo de demonstração local — sem conexão com o jogo')).toBeTruthy();
    expect(screen.getByText('Test Adventurer')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Inventário' }));
    expect(screen.getByText('Poção de Bruma')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Mapa' }));
    expect(screen.getByText('Mapa em breve')).toBeTruthy();
  });

  it('omits inert overlay controls in the extension page', () => {
    render(<GameApp adapter={adapter('extension-page')} />);
    expect(screen.queryByRole('button', { name: 'Minimizar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Fechar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Abrir em aba' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Habilidades' }));
    expect(screen.getByText('Luz Velada')).toBeTruthy();
  });

  it('mounts one React root in the Shadow DOM, traps focus, and cleans up', async () => {
    installChromeMock();
    document.body.innerHTML = '<main id="conversation">A conversa hospedeira permanece intacta.</main>';
    const controller = mountContentShell();
    expect(mountContentShell()).toBeUndefined();
    const host = document.getElementById('cronicas-extension-root');
    const shadowRoot = host?.shadowRoot;
    expect(host).not.toBeNull();
    expect(document.getElementById('conversation')?.textContent).toContain('permanece intacta');
    expect(shadowRoot?.querySelectorAll('style')).toHaveLength(1);
    await waitFor(() => expect(shadowRoot?.querySelector<HTMLButtonElement>('.chronicles-launcher')).not.toBeNull());
    const launcher = shadowRoot?.querySelector<HTMLButtonElement>('.chronicles-launcher');
    if (launcher !== null && launcher !== undefined) fireEvent.click(launcher);
    await waitFor(() => expect(shadowRoot?.querySelector<HTMLElement>('.chronicles-overlay')?.hidden).toBe(false));
    const overlay = shadowRoot?.querySelector<HTMLElement>('.chronicles-overlay');
    const controls = [...(overlay?.querySelectorAll<HTMLButtonElement>('button') ?? [])].filter((button) => button.tabIndex >= 0);
    const first = controls[0]; const last = controls.at(-1);
    last?.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, composed: true }));
    expect(shadowRoot?.activeElement).toBe(first);
    first?.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, composed: true }));
    expect(shadowRoot?.activeElement).toBe(last);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
    await waitFor(() => expect(overlay?.hidden).toBe(true));
    expect(shadowRoot?.activeElement).toBe(launcher);
    controller?.destroy();
    expect(document.getElementById('cronicas-extension-root')).toBeNull();
    expect(mountContentShell()).toBeDefined();
  });

  it('shows working overlay controls only in overlay mode', async () => {
    const gameAdapter = adapter('overlay');
    render(<GameApp adapter={gameAdapter} />);
    fireEvent.click(screen.getByRole('button', { name: /Abrir Crônicas/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Fechar' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Minimizar' }));
    await waitFor(() => expect(gameAdapter.minimize).toHaveBeenCalledTimes(1));
  });
});

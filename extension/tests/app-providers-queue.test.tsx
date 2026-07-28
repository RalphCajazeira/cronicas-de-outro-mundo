// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppProviders, useGameApp } from '../src/app/AppProviders.js';
import type { PlatformAdapter } from '../src/platform/platform-adapter.js';
import { DEFAULT_PREFERENCES } from '../src/shared/preferences.js';
import type { ExtensionPreferences } from '../src/shared/types.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

type SaveCall = {
  readonly patch: Partial<ExtensionPreferences>;
  readonly deferred: Deferred<ExtensionPreferences>;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolveDeferred, rejectDeferred) => {
    resolve = resolveDeferred;
    reject = rejectDeferred;
  });
  return { promise, resolve, reject };
}

function createControlledAdapter(mode: PlatformAdapter['mode']): {
  readonly adapter: PlatformAdapter;
  readonly calls: SaveCall[];
} {
  const calls: SaveCall[] = [];
  const adapter: PlatformAdapter = {
    mode,
    readPreferences: vi.fn(() => Promise.resolve(DEFAULT_PREFERENCES)),
    savePreferences: vi.fn((patch: Partial<ExtensionPreferences>) => {
      const deferred = createDeferred<ExtensionPreferences>();
      calls.push({ patch: { ...patch }, deferred });
      return deferred.promise;
    }),
  };
  return { adapter, calls };
}

function PreferencesPanel() {
  const { preferences, savePreferences } = useGameApp();
  return (
    <div>
      <output data-testid="active-tab">{preferences.activeTab}</output>
      <button onClick={() => savePreferences({ activeTab: 'summary' })}>Summary</button>
      <button onClick={() => savePreferences({ activeTab: 'inventory' })}>Inventory</button>
      <button onClick={() => savePreferences({ activeTab: 'abilities' })}>Abilities</button>
    </div>
  );
}

function renderWithAdapter(adapter: PlatformAdapter) {
  return render(
    <AppProviders adapter={adapter}>
      <PreferencesPanel />
    </AppProviders>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  document.head.replaceChildren();
});

describe('preference save queue', () => {
  it('aplica rapidamente e finaliza no último estado visual/persistido', async () => {
    const { adapter, calls } = createControlledAdapter('web');
    renderWithAdapter(adapter);

    fireEvent.click(screen.getByRole('button', { name: 'Summary' }));
    fireEvent.click(screen.getByRole('button', { name: 'Inventory' }));
    fireEvent.click(screen.getByRole('button', { name: 'Abilities' }));
    expect(screen.getByTestId('active-tab').textContent).toBe('abilities');

    await waitFor(() => expect(calls).toHaveLength(1));
    const first = calls[0]!;
    act(() => first.deferred.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'summary' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    const second = calls[1]!;
    act(() => second.deferred.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'inventory' }));
    await waitFor(() => expect(calls).toHaveLength(3));
    const third = calls[2]!;
    act(() => third.deferred.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'abilities' }));
    await waitFor(() => expect(screen.getByTestId('active-tab').textContent).toBe('abilities'));
  });

  it('não inicia o segundo save antes do primeiro concluir', async () => {
    const { adapter, calls } = createControlledAdapter('web');
    renderWithAdapter(adapter);

    fireEvent.click(screen.getByRole('button', { name: 'Summary' }));
    fireEvent.click(screen.getByRole('button', { name: 'Inventory' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    const first = calls[0]!;
    act(() => first.deferred.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'summary' }));
    await waitFor(() => expect(calls).toHaveLength(2));
  });

  it('não restaura estado antigo com resposta vencida', async () => {
    const { adapter, calls } = createControlledAdapter('web');
    renderWithAdapter(adapter);

    fireEvent.click(screen.getByRole('button', { name: 'Summary' }));
    fireEvent.click(screen.getByRole('button', { name: 'Inventory' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    const first = calls[0]!;
    act(() => first.deferred.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'summary' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    const second = calls[1]!;
    act(() => second.deferred.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'inventory' }));
    await waitFor(() => expect(screen.getByTestId('active-tab').textContent).toBe('inventory'));
  });

  it('segue para a segunda gravação após falha da primeira', async () => {
    const { adapter, calls } = createControlledAdapter('web');
    renderWithAdapter(adapter);

    fireEvent.click(screen.getByRole('button', { name: 'Summary' }));
    fireEvent.click(screen.getByRole('button', { name: 'Abilities' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    const first = calls[0]!;
    act(() => first.deferred.reject(new Error('erro controlado')));
    await waitFor(() => expect(calls).toHaveLength(2));
    const second = calls[1]!;
    act(() => second.deferred.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'abilities' }));
    await waitFor(() => expect(screen.getByTestId('active-tab').textContent).toBe('abilities'));
  });

  it('mantém a última opção em três mudanças rápidas', async () => {
    const { adapter, calls } = createControlledAdapter('web');
    renderWithAdapter(adapter);
    fireEvent.click(screen.getByRole('button', { name: 'Summary' }));
    fireEvent.click(screen.getByRole('button', { name: 'Inventory' }));
    fireEvent.click(screen.getByRole('button', { name: 'Abilities' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    const first = calls[0]!;
    act(() => first.deferred.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'summary' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    const second = calls[1]!;
    act(() => second.deferred.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'inventory' }));
    await waitFor(() => expect(calls).toHaveLength(3));
    const third = calls[2]!;
    act(() => third.deferred.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'abilities' }));
    await waitFor(() => expect(screen.getByTestId('active-tab').textContent).toBe('abilities'));
  });

  it('desmontagem bloqueia atualização tardia sem warning de estado', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { adapter, calls } = createControlledAdapter('web');
    const { unmount } = renderWithAdapter(adapter);

    fireEvent.click(screen.getByRole('button', { name: 'Inventory' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    unmount();

    const first = calls[0]!;
    act(() => first.deferred.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'inventory' }));
    await act(async () => Promise.resolve());
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('troca de adapter invalida resposta antiga', async () => {
    const first = createControlledAdapter('overlay');
    const second = createControlledAdapter('extension-page');
    const { rerender } = render(
      <AppProviders adapter={first.adapter}>
        <PreferencesPanel />
      </AppProviders>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Summary' }));
    await waitFor(() => expect(first.calls).toHaveLength(1));

    rerender(
      <AppProviders adapter={second.adapter}>
        <PreferencesPanel />
      </AppProviders>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Abilities' }));
    await waitFor(() => expect(second.calls).toHaveLength(1));

    act(() => first.calls[0]!.deferred.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'summary' }));
    act(() => second.calls[0]!.deferred.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'abilities' }));
    await waitFor(() => expect(screen.getByTestId('active-tab').textContent).toBe('abilities'));
  });
});

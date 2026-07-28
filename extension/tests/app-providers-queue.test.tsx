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

type ControlledAdapter = {
  readonly read: Deferred<ExtensionPreferences>;
  readonly calls: SaveCall[];
  readonly preferences: { current: ExtensionPreferences };
  readonly adapter: PlatformAdapter;
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

function createControlledAdapter(
  mode: PlatformAdapter['mode'],
  initialPreferences: ExtensionPreferences = DEFAULT_PREFERENCES,
  autoResolveRead = true,
): ControlledAdapter {
  const read = createDeferred<ExtensionPreferences>();
  const calls: SaveCall[] = [];
  const adapterState = { current: { ...initialPreferences } };
  const adapter: PlatformAdapter = {
    mode,
    readPreferences: vi.fn(() => read.promise.then((value) => {
      adapterState.current = value;
      return value;
    })),
    savePreferences: vi.fn((patch: Partial<ExtensionPreferences>) => {
      const deferred = createDeferred<ExtensionPreferences>();
      calls.push({ patch: { ...patch }, deferred });
      return deferred.promise.then((next) => {
        adapterState.current = next;
        return next;
      });
    }),
  };
  if (autoResolveRead) {
    read.resolve({ ...adapterState.current });
  }
  return { adapter, calls, preferences: adapterState, read };
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
  it('aguarda a leitura inicial para iniciar o primeiro save', async () => {
    const { adapter, calls, read } = createControlledAdapter('web', DEFAULT_PREFERENCES, false);
    renderWithAdapter(adapter);

    fireEvent.click(screen.getByRole('button', { name: 'Inventory' }));
    expect(calls).toHaveLength(0);

    act(() => read.resolve({ ...DEFAULT_PREFERENCES }));
    await waitFor(() => expect(calls).toHaveLength(1));
    act(() => calls[0]!.deferred.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'inventory' }));
    await waitFor(() => expect(screen.getByTestId('active-tab').textContent).toBe('inventory'));
  });

  it('não desfaz atualização otimista quando a leitura tarda', async () => {
    const { adapter, calls, read, preferences } = createControlledAdapter('web', { ...DEFAULT_PREFERENCES, activeTab: 'summary' }, false);
    renderWithAdapter(adapter);

    fireEvent.click(screen.getByRole('button', { name: 'Inventory' }));
    await waitFor(() => expect(screen.getByTestId('active-tab').textContent).toBe('inventory'));
    expect(calls).toHaveLength(0);

    act(() => read.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'summary' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId('active-tab').textContent).toBe('inventory'));
    expect(preferences.current).toEqual({ ...DEFAULT_PREFERENCES, activeTab: 'summary' });
  });

  it('estabelece estado persistido inicial pela leitura antes de salvar', async () => {
    const { adapter, read, preferences } = createControlledAdapter('web', { ...DEFAULT_PREFERENCES, activeTab: 'abilities' }, false);
    renderWithAdapter(adapter);
    act(() => read.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'summary' }));
    await waitFor(() => expect(screen.getByTestId('active-tab').textContent).toBe('summary'));
    expect(preferences.current).toEqual({ ...DEFAULT_PREFERENCES, activeTab: 'summary' });
  });

  it('persiste corretamente após leitura concluída', async () => {
    const { adapter, calls, read, preferences } = createControlledAdapter('web', { ...DEFAULT_PREFERENCES, activeTab: 'summary' }, false);
    renderWithAdapter(adapter);

    fireEvent.click(screen.getByRole('button', { name: 'Inventory' }));
    fireEvent.click(screen.getByRole('button', { name: 'Abilities' }));

    await waitFor(() => expect(calls).toHaveLength(0));
    act(() => read.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'summary' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    act(() => calls[0]!.deferred.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'inventory' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    act(() => calls[1]!.deferred.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'abilities' }));

    await waitFor(() => expect(screen.getByTestId('active-tab').textContent).toBe('abilities'));
    expect(preferences.current).toEqual({ ...DEFAULT_PREFERENCES, activeTab: 'abilities' });
  });

  it('retorna ao valor lido após falha do save', async () => {
    const { adapter, calls, read, preferences } = createControlledAdapter('web', { ...DEFAULT_PREFERENCES, activeTab: 'summary' }, false);
    renderWithAdapter(adapter);

    fireEvent.click(screen.getByRole('button', { name: 'Inventory' }));
    act(() => read.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'summary' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    act(() => calls[0]!.deferred.reject(new Error('fail after read')));
    await waitFor(() => expect(screen.getByTestId('active-tab').textContent).toBe('summary'));
    expect(preferences.current).toEqual({ ...DEFAULT_PREFERENCES, activeTab: 'summary' });
  });

  it('duas mudanças rápidas durante leitura finalizam na última', async () => {
    const { adapter, calls, read, preferences } = createControlledAdapter('web', { ...DEFAULT_PREFERENCES, activeTab: 'summary' }, false);
    renderWithAdapter(adapter);

    fireEvent.click(screen.getByRole('button', { name: 'Inventory' }));
    fireEvent.click(screen.getByRole('button', { name: 'Abilities' }));
    await waitFor(() => expect(calls).toHaveLength(0));

    act(() => read.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'summary' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    act(() => calls[0]!.deferred.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'inventory' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    act(() => calls[1]!.deferred.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'abilities' }));

    await waitFor(() => expect(screen.getByTestId('active-tab').textContent).toBe('abilities'));
    expect(preferences.current).toEqual({ ...DEFAULT_PREFERENCES, activeTab: 'abilities' });
  });

  it('continua salvando após leitura rejeitada', async () => {
    const { adapter, calls, read, preferences } = createControlledAdapter('web', { ...DEFAULT_PREFERENCES, activeTab: 'summary' }, false);
    renderWithAdapter(adapter);
    fireEvent.click(screen.getByRole('button', { name: 'Inventory' }));

    expect(calls).toHaveLength(0);
    act(() => read.reject(new Error('read failed')));
    await waitFor(() => expect(calls).toHaveLength(1));
    act(() => calls[0]!.deferred.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'inventory' }));
    await waitFor(() => expect(screen.getByTestId('active-tab').textContent).toBe('inventory'));
    expect(preferences.current).toEqual({ ...DEFAULT_PREFERENCES, activeTab: 'inventory' });
  });

  it('ignora leitura tardia de adapter antigo após troca', async () => {
    const first = createControlledAdapter('overlay', { ...DEFAULT_PREFERENCES, activeTab: 'summary' }, false);
    const second = createControlledAdapter('extension-page', { ...DEFAULT_PREFERENCES, activeTab: 'inventory' });

    const { rerender } = render(
      <AppProviders adapter={first.adapter}>
        <PreferencesPanel />
      </AppProviders>,
    );

    rerender(
      <AppProviders adapter={second.adapter}>
        <PreferencesPanel />
      </AppProviders>,
    );

    act(() => first.read.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'summary' }));
    await waitFor(() => expect(screen.getByTestId('active-tab').textContent).toBe('inventory'));
    expect(second.preferences.current).toEqual({ ...DEFAULT_PREFERENCES, activeTab: 'inventory' });
  });

  it('desmontagem ignora leitura tardia sem warning', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { preferences, read, unmount } = (() => {
      const tuple = createControlledAdapter('web', { ...DEFAULT_PREFERENCES, activeTab: 'summary' }, false);
      const renderResult = renderWithAdapter(tuple.adapter);
      return { ...tuple, ...renderResult };
    })();
    unmount();
    act(() => read.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'summary' }));
    await act(async () => Promise.resolve());
    expect(preferences.current).toEqual({ ...DEFAULT_PREFERENCES, activeTab: 'summary' });
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('mantém serialização após leitura inicial', async () => {
    const { adapter, calls, read } = createControlledAdapter('web', { ...DEFAULT_PREFERENCES, activeTab: 'summary' }, false);
    renderWithAdapter(adapter);

    fireEvent.click(screen.getByRole('button', { name: 'Inventory' }));
    fireEvent.click(screen.getByRole('button', { name: 'Abilities' }));
    act(() => read.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'summary' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    act(() => calls[0]!.deferred.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'inventory' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    act(() => calls[1]!.deferred.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'abilities' }));
    await waitFor(() => expect(screen.getByTestId('active-tab').textContent).toBe('abilities'));
  });

  it('converge UI e storage após leitura + saves', async () => {
    const { adapter, calls, read, preferences } = createControlledAdapter('web', { ...DEFAULT_PREFERENCES, activeTab: 'summary' }, false);
    renderWithAdapter(adapter);
    fireEvent.click(screen.getByRole('button', { name: 'Inventory' }));
    fireEvent.click(screen.getByRole('button', { name: 'Abilities' }));

    act(() => read.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'summary' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    act(() => calls[0]!.deferred.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'inventory' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    act(() => calls[1]!.deferred.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'abilities' }));
    await waitFor(() => expect(screen.getByTestId('active-tab').textContent).toBe('abilities'));
    expect(preferences.current).toEqual({ ...DEFAULT_PREFERENCES, activeTab: 'abilities' });
  });

  it('mantém estado no último sucesso, apesar de falha final', async () => {
    const { adapter, calls, preferences } = createControlledAdapter('web');
    renderWithAdapter(adapter);
    fireEvent.click(screen.getByRole('button', { name: 'Inventory' }));
    fireEvent.click(screen.getByRole('button', { name: 'Abilities' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    act(() => calls[0]!.deferred.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'inventory' }));
    await waitFor(() => expect(calls).toHaveLength(2));

    act(() => calls[1]!.deferred.reject(new Error('fail final')));
    await waitFor(() => expect(screen.getByTestId('active-tab').textContent).toBe('inventory'));
    expect(preferences.current).toEqual({ ...DEFAULT_PREFERENCES, activeTab: 'inventory' });
  });

  it('reverte para o valor inicial quando todas as gravações falham', async () => {
    const { adapter, calls, preferences } = createControlledAdapter('web', { ...DEFAULT_PREFERENCES, activeTab: 'summary' });
    renderWithAdapter(adapter);
    fireEvent.click(screen.getByRole('button', { name: 'Inventory' }));
    fireEvent.click(screen.getByRole('button', { name: 'Abilities' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    act(() => calls[0]!.deferred.reject(new Error('fail first')));
    await waitFor(() => expect(calls).toHaveLength(2));
    act(() => calls[1]!.deferred.reject(new Error('fail last')));
    await waitFor(() => expect(screen.getByTestId('active-tab').textContent).toBe('summary'));
    expect(preferences.current).toEqual({ ...DEFAULT_PREFERENCES, activeTab: 'summary' });
  });

  it('não desfaz sucesso intermediário por falha anterior', async () => {
    const { adapter, calls, preferences } = createControlledAdapter('web');
    renderWithAdapter(adapter);

    fireEvent.click(screen.getByRole('button', { name: 'Inventory' }));
    await waitFor(() => expect(screen.getByTestId('active-tab').textContent).toBe('inventory'));
    fireEvent.click(screen.getByRole('button', { name: 'Abilities' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId('active-tab').textContent).toBe('abilities'));

    act(() => calls[0]!.deferred.reject(new Error('fail first')));
    await waitFor(() => expect(calls).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId('active-tab').textContent).toBe('abilities'));

    act(() => calls[1]!.deferred.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'abilities' }));
    await waitFor(() => expect(screen.getByTestId('active-tab').textContent).toBe('abilities'));
    expect(preferences.current).toEqual({ ...DEFAULT_PREFERENCES, activeTab: 'abilities' });
  });

  it('permanece no penúltimo estado confirmado quando a última falha', async () => {
    const { adapter, calls, preferences } = createControlledAdapter('web');
    renderWithAdapter(adapter);

    fireEvent.click(screen.getByRole('button', { name: 'Summary' }));
    fireEvent.click(screen.getByRole('button', { name: 'Inventory' }));
    fireEvent.click(screen.getByRole('button', { name: 'Abilities' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    act(() => calls[0]!.deferred.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'summary' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    act(() => calls[1]!.deferred.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'inventory' }));
    await waitFor(() => expect(calls).toHaveLength(3));
    act(() => calls[2]!.deferred.reject(new Error('fail last')));
    await waitFor(() => expect(screen.getByTestId('active-tab').textContent).toBe('inventory'));
    expect(preferences.current).toEqual({ ...DEFAULT_PREFERENCES, activeTab: 'inventory' });
  });

  it('a fila continua serial: o segundo não inicia antes do primeiro concluir', async () => {
    const { adapter, calls } = createControlledAdapter('web');
    renderWithAdapter(adapter);
    fireEvent.click(screen.getByRole('button', { name: 'Inventory' }));
    fireEvent.click(screen.getByRole('button', { name: 'Abilities' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    act(() => calls[0]!.deferred.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'inventory' }));
    await waitFor(() => expect(calls).toHaveLength(2));
  });

  it('restaura UI na falha da operação mais recente, não de operações antigas', async () => {
    const { adapter, calls, preferences } = createControlledAdapter('web');
    renderWithAdapter(adapter);
    fireEvent.click(screen.getByRole('button', { name: 'Inventory' }));
    fireEvent.click(screen.getByRole('button', { name: 'Abilities' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    act(() => calls[0]!.deferred.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'inventory' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    act(() => calls[1]!.deferred.reject(new Error('fail last')));
    await waitFor(() => expect(screen.getByTestId('active-tab').textContent).toBe('inventory'));
    expect(preferences.current).toEqual({ ...DEFAULT_PREFERENCES, activeTab: 'inventory' });
  });

  it('atualiza lastPersistedPreferences a cada sucesso', async () => {
    const { adapter, calls, preferences } = createControlledAdapter('web');
    renderWithAdapter(adapter);

    fireEvent.click(screen.getByRole('button', { name: 'Summary' }));
    fireEvent.click(screen.getByRole('button', { name: 'Inventory' }));
    fireEvent.click(screen.getByRole('button', { name: 'Abilities' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    act(() => calls[0]!.deferred.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'summary' }));
    await waitFor(() => expect(preferences.current).toEqual({ ...DEFAULT_PREFERENCES, activeTab: 'summary' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    act(() => calls[1]!.deferred.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'inventory' }));
    await waitFor(() => expect(preferences.current).toEqual({ ...DEFAULT_PREFERENCES, activeTab: 'inventory' }));
    await waitFor(() => expect(calls).toHaveLength(3));
    act(() => calls[2]!.deferred.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'abilities' }));
    await waitFor(() => expect(preferences.current).toEqual({ ...DEFAULT_PREFERENCES, activeTab: 'abilities' }));
  });

  it('troca de adapter não reaplica ref persistido do adapter anterior', async () => {
    const first = createControlledAdapter('overlay', { ...DEFAULT_PREFERENCES, activeTab: 'summary' });
    const second = createControlledAdapter('extension-page', { ...DEFAULT_PREFERENCES, activeTab: 'inventory' });

    const { rerender } = render(
      <AppProviders adapter={first.adapter}>
        <PreferencesPanel />
      </AppProviders>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Abilities' }));
    await waitFor(() => expect(first.calls).toHaveLength(1));

    rerender(
      <AppProviders adapter={second.adapter}>
        <PreferencesPanel />
      </AppProviders>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Summary' }));
    await waitFor(() => expect(second.calls).toHaveLength(1));

    act(() => first.calls[0]!.deferred.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'abilities' }));
    act(() => second.calls[0]!.deferred.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'summary' }));
    await waitFor(() => expect(screen.getByTestId('active-tab').textContent).toBe('summary'));

    expect(second.preferences.current).toEqual({ ...DEFAULT_PREFERENCES, activeTab: 'summary' });
    expect(first.preferences.current).toEqual({ ...DEFAULT_PREFERENCES, activeTab: 'abilities' });
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

  it('converge armazenamento e UI para o mesmo valor final após falha final', async () => {
    const { adapter, calls, preferences } = createControlledAdapter('web');
    renderWithAdapter(adapter);
    fireEvent.click(screen.getByRole('button', { name: 'Inventory' }));
    fireEvent.click(screen.getByRole('button', { name: 'Abilities' }));
    fireEvent.click(screen.getByRole('button', { name: 'Summary' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    act(() => calls[0]!.deferred.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'inventory' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    act(() => calls[1]!.deferred.resolve({ ...DEFAULT_PREFERENCES, activeTab: 'abilities' }));
    await waitFor(() => expect(calls).toHaveLength(3));
    act(() => calls[2]!.deferred.reject(new Error('final fail')));

    await waitFor(() => expect(screen.getByTestId('active-tab').textContent).toBe('abilities'));
    expect(preferences.current).toEqual({ ...DEFAULT_PREFERENCES, activeTab: 'abilities' });
  });
});

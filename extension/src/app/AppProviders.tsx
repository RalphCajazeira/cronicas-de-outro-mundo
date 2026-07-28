import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import type { PlatformAdapter } from '../platform/platform-adapter.js';
import { DEFAULT_PREFERENCES } from '../shared/preferences.js';
import type { ExtensionPreferences } from '../shared/types.js';

interface AppContextValue {
  readonly adapter: PlatformAdapter;
  readonly preferences: ExtensionPreferences;
  readonly preferencesLoaded: boolean;
  readonly savePreferences: (patch: Partial<ExtensionPreferences>) => void;
}

const AppContext = createContext<AppContextValue | undefined>(undefined);

type SaveOutcome = { readonly requestId: number; readonly adapterVersion: number; readonly ok: false } | {
  readonly requestId: number;
  readonly adapterVersion: number;
  readonly ok: true;
  readonly next: ExtensionPreferences;
};

export function AppProviders({ adapter, children }: PropsWithChildren<{ readonly adapter: PlatformAdapter }>) {
  const [preferences, setPreferences] = useState(DEFAULT_PREFERENCES);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const adapterRef = useRef(adapter);
  const isActiveRef = useRef(true);
  const adapterVersionRef = useRef(0);
  const lastPersistedPreferencesRef = useRef(DEFAULT_PREFERENCES);
  const saveQueueRef = useRef(Promise.resolve());
  const lastRequestIdRef = useRef(0);
  const latestRequestIdRef = useRef(0);

  useEffect(() => {
    adapterRef.current = adapter;
    isActiveRef.current = true;
    const adapterVersion = ++adapterVersionRef.current;
    saveQueueRef.current = Promise.resolve();
    lastRequestIdRef.current = 0;
    latestRequestIdRef.current = 0;
    lastPersistedPreferencesRef.current = DEFAULT_PREFERENCES;
    setPreferencesLoaded(false);
    const initialRead = (async () => {
      try {
        const next = await adapter.readPreferences();
        if (isActiveRef.current && adapterVersion === adapterVersionRef.current) {
          lastPersistedPreferencesRef.current = next;
          if (latestRequestIdRef.current === 0) {
            setPreferences(next);
          }
        }
      } catch {
        if (isActiveRef.current && adapterVersion === adapterVersionRef.current) {
          lastPersistedPreferencesRef.current = DEFAULT_PREFERENCES;
          if (latestRequestIdRef.current === 0) {
            setPreferences(DEFAULT_PREFERENCES);
          }
        }
      } finally {
        if (isActiveRef.current && adapterVersion === adapterVersionRef.current) {
          setPreferencesLoaded(true);
        }
      }
    })();
    saveQueueRef.current = initialRead.then(() => undefined).catch(() => undefined);

    return () => {
      isActiveRef.current = false;
      adapterVersionRef.current += 1;
    };
  }, [adapter]);

  const savePreferences = useCallback((patch: Partial<ExtensionPreferences>) => {
    const requestId = ++lastRequestIdRef.current;
    const adapterVersion = adapterVersionRef.current;
    latestRequestIdRef.current = requestId;

    setPreferences((current) => ({ ...current, ...patch }));

    const execution = (async () => {
      try {
        await saveQueueRef.current;
      } catch {
        // keep queue serial even after any prior failure
      }
      if (!isActiveRef.current || adapterVersion !== adapterVersionRef.current) {
        return { requestId, adapterVersion, ok: false } satisfies SaveOutcome;
      }
      try {
        const next = await adapterRef.current.savePreferences(patch);
        return { requestId, adapterVersion, ok: true, next } satisfies SaveOutcome;
      } catch {
        return { requestId, adapterVersion, ok: false } satisfies SaveOutcome;
      }
    })();

    saveQueueRef.current = execution.then(() => undefined).catch(() => undefined);

    void execution.then((outcome) => {
      if (!isActiveRef.current || adapterVersion !== adapterVersionRef.current) {
        return;
      }
      if (outcome.ok) {
        lastPersistedPreferencesRef.current = outcome.next;
        if (outcome.requestId === latestRequestIdRef.current) {
          setPreferences(outcome.next);
        }
        return;
      }

      if (outcome.requestId === latestRequestIdRef.current) {
        setPreferences(lastPersistedPreferencesRef.current);
      }
    });
  }, []);

  const value = useMemo<AppContextValue>(() => ({
    adapter,
    preferences,
    preferencesLoaded,
    savePreferences,
  }), [adapter, preferences, preferencesLoaded, savePreferences]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useGameApp(): AppContextValue {
  const value = useContext(AppContext);
  if (value === undefined) throw new Error('GameApp must be rendered inside AppProviders.');
  return value;
}

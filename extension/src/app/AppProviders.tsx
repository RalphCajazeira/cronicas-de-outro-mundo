import { createContext, useContext, useEffect, useMemo, useState, type PropsWithChildren } from 'react';
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

export function AppProviders({ adapter, children }: PropsWithChildren<{ readonly adapter: PlatformAdapter }>) {
  const [preferences, setPreferences] = useState(DEFAULT_PREFERENCES);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    void adapter.readPreferences().then((value) => { if (active) setPreferences(value); }).catch(() => {}).finally(() => { if (active) setPreferencesLoaded(true); });
    return () => { active = false; };
  }, [adapter]);
  const value = useMemo<AppContextValue>(() => ({
    adapter, preferences, preferencesLoaded,
    savePreferences: (patch) => {
      setPreferences((current) => ({ ...current, ...patch }));
      void adapter.savePreferences(patch).then(setPreferences).catch(() => {});
    },
  }), [adapter, preferences, preferencesLoaded]);
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useGameApp(): AppContextValue {
  const value = useContext(AppContext);
  if (value === undefined) throw new Error('GameApp must be rendered inside AppProviders.');
  return value;
}

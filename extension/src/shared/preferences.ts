import type { ExtensionPreferences, ShellTab } from './types.js';
import { SHELL_TABS } from './types.js';

export const PREFERENCES_KEY = 'cronicas.visual-preferences';

export const DEFAULT_PREFERENCES: ExtensionPreferences = {
  buttonPosition: { right: 24, bottom: 24 },
  lastMode: 'minimized',
  activeTab: 'summary',
  reducedMotion: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isShellTab(value: unknown): value is ShellTab {
  return typeof value === 'string' && (SHELL_TABS as readonly string[]).includes(value);
}

function boundedNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 8 && value <= 128 ? value : fallback;
}

export function normalizePreferences(value: unknown): ExtensionPreferences {
  if (!isRecord(value)) return DEFAULT_PREFERENCES;
  const position = isRecord(value.buttonPosition) ? value.buttonPosition : {};
  return {
    buttonPosition: {
      right: boundedNumber(position.right, DEFAULT_PREFERENCES.buttonPosition.right),
      bottom: boundedNumber(position.bottom, DEFAULT_PREFERENCES.buttonPosition.bottom),
    },
    lastMode: value.lastMode === 'overlay' || value.lastMode === 'page' || value.lastMode === 'minimized'
      ? value.lastMode
      : DEFAULT_PREFERENCES.lastMode,
    activeTab: isShellTab(value.activeTab) ? value.activeTab : DEFAULT_PREFERENCES.activeTab,
    reducedMotion: typeof value.reducedMotion === 'boolean' ? value.reducedMotion : DEFAULT_PREFERENCES.reducedMotion,
  };
}

export async function readPreferences(): Promise<ExtensionPreferences> {
  const result = await chrome.storage.local.get(PREFERENCES_KEY);
  return normalizePreferences(result[PREFERENCES_KEY]);
}

export async function savePreferences(patch: Partial<ExtensionPreferences>): Promise<ExtensionPreferences> {
  const current = await readPreferences();
  const next = normalizePreferences({ ...current, ...patch });
  await chrome.storage.local.set({ [PREFERENCES_KEY]: next });
  return next;
}

import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES, normalizePreferences } from '../src/shared/preferences.js';

describe('visual preferences', () => {
  it('uses a safe default for malformed persisted data', () => {
    expect(normalizePreferences({ lastMode: 'chat', activeTab: 'unknown', buttonPosition: { right: -4, bottom: 999 } }))
      .toEqual(DEFAULT_PREFERENCES);
  });

  it('accepts bounded visual-only preferences', () => {
    expect(normalizePreferences({
      lastMode: 'overlay', activeTab: 'inventory', reducedMotion: true, buttonPosition: { right: 32, bottom: 48 },
    })).toEqual({
      lastMode: 'overlay', activeTab: 'inventory', reducedMotion: true, buttonPosition: { right: 32, bottom: 48 },
    });
  });
});

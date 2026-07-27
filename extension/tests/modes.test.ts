import { describe, expect, it } from 'vitest';
import { canTransitionMode } from '../src/shared/modes.js';

describe('display mode transitions', () => {
  it('allows the three declared display modes without an invalid state', () => {
    expect(canTransitionMode('minimized', 'overlay')).toBe(true);
    expect(canTransitionMode('overlay', 'minimized')).toBe(true);
    expect(canTransitionMode('overlay', 'page')).toBe(true);
    expect(canTransitionMode('page', 'overlay')).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { cryptographicRollProvider, createSequenceRollProvider } from './roll-provider.js';

describe('effect roll providers', () => {
  it('injects deterministic rolls in declared order', () => {
    const provider = createSequenceRollProvider([1, 10_000]);
    expect(provider.nextBps('hit')).toBe(1);
    expect(provider.nextBps('critical')).toBe(10_000);
    expect(() => provider.nextBps('hit')).toThrow('exhausted');
  });

  it('uses cryptographic production rolls inside the official bounds', () => {
    const values = Array.from({ length: 100 }, () => cryptographicRollProvider.nextBps('hit'));
    expect(values.every((value) => Number.isSafeInteger(value) && value >= 1 && value <= 10_000)).toBe(true);
  });
});

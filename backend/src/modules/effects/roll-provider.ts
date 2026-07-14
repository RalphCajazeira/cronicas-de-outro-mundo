import { randomInt } from 'node:crypto';

export type EffectRollRequestKind = 'hit' | 'critical' | 'concentration';

export interface RollProvider {
  nextBps(kind: EffectRollRequestKind): number;
}

export const cryptographicRollProvider: RollProvider = Object.freeze({
  nextBps: () => randomInt(1, 10_001),
});

export function createSequenceRollProvider(values: readonly number[]): RollProvider {
  let index = 0;
  return {
    nextBps() {
      const value = values[index];
      if (value === undefined || !Number.isSafeInteger(value) || value < 1 || value > 10_000) {
        throw new RangeError('Deterministic roll sequence is exhausted or invalid');
      }
      index += 1;
      return value;
    },
  };
}

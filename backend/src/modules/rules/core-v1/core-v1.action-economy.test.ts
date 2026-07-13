import { describe, expect, it } from 'vitest';
import {
  actionSlotEquivalentBps,
  calculateActionEconomyFactorBps,
  calculateAdjustedThreat,
  calculateEncounterThreat,
  calculateNpcEncounterThreat,
  calculatePhysicalActionTimes,
  calculateReferenceCycle,
  calculateTemporalSlots,
  expectedActionsPerWindowBps,
  getRepresentativeTemporalProfile,
  npcBaseThreatBps,
  temporalXpActionMultiplierBps,
  xpImpactMultiplierBps,
} from './index.js';
import type { TemporalSlotInput } from './index.js';

describe('core-v1 temporal encounter economy', () => {
  it('calculates sustainable and unavailable-signature reference cycles', () => {
    expect(calculateReferenceCycle(1000n, 1200n, 1000n)).toBe(1040n);
    expect(calculateReferenceCycle(1000n, 6000n, 1000n)).toBe(1000n);
    expect(expectedActionsPerWindowBps(1000n)).toBe(100000);
    expect(actionSlotEquivalentBps(1000n)).toBe(10000);
  });

  it('calculates three balanced actors against three standards', () => {
    const party = Array.from({ length: 3 }, (): TemporalSlotInput => ({ cycle: 1000n }));
    const hostile = Array.from({ length: 3 }, (): TemporalSlotInput => ({ cycle: 1000n }));
    expect(calculateTemporalSlots(party)).toBe(30000);
    expect(calculateActionEconomyFactorBps(party, hostile)).toBe(10000);
  });

  it('handles standard plus minions, boss secondary slots, haste and slow', () => {
    const party = [{ cycle: 1000n }];
    const standardAndMinions = [{ cycle: 1000n }, { cycle: 2000n }, { cycle: 2000n }];
    expect(calculateActionEconomyFactorBps(party, standardAndMinions)).toBe(20000);
    const boss = [{ cycle: 1000n }, { cycle: 1000n, secondary: true, potencyMultiplierBps: 5000 }];
    expect(calculateTemporalSlots(boss)).toBe(15000);
    expect(calculateActionEconomyFactorBps([{ cycle: 500n }], [{ cycle: 2000n }])).toBe(7500);
  });

  it('uses Fase 1A base threat and returns pure adjusted threat', () => {
    const baseThreat = npcBaseThreatBps('boss', 2);
    expect(calculateAdjustedThreat(baseThreat, 12500)).toBe(200000);
    expect(calculateEncounterThreat([npcBaseThreatBps('standard', 1), npcBaseThreatBps('minion', 1)], [{ cycle: 1000n }], [{ cycle: 800n }]))
      .toMatchObject({ baseThreat: 12500, actionEconomyFactorBps: 12500, adjustedThreat: 15625 });
    expect(calculateNpcEncounterThreat('boss', 2, [{ cycle: 1000n }], [{ cycle: 1000n }]))
      .toEqual({ baseThreat: 160000, actionEconomyFactorBps: 10000, adjustedThreat: 160000 });
  });

  it('rejects empty/zero slots, invalid cycles and unsafe threat overflow', () => {
    expect(() => calculateTemporalSlots([])).toThrow('at least one');
    expect(() => calculateActionEconomyFactorBps([], [{ cycle: 1000n }])).toThrow('at least one');
    expect(() => expectedActionsPerWindowBps(0n)).toThrow('between 100 and 40000');
    expect(expectedActionsPerWindowBps(100n)).toBe(1_000_000);
    expect(expectedActionsPerWindowBps(40000n)).toBe(2500);
    expect(() => expectedActionsPerWindowBps(40001n)).toThrow('between 100 and 40000');
    expect(() => calculateAdjustedThreat(Number.MAX_SAFE_INTEGER, 20000)).toThrow('adjusted threat');
  });
});

describe('core-v1 temporal XP multipliers', () => {
  it('applies 100%, 50% and 10% in a moving 1000 tick window', () => {
    expect(temporalXpActionMultiplierBps(1000n, [])).toBe(10000);
    expect(temporalXpActionMultiplierBps(1000n, [500n])).toBe(5000);
    expect(temporalXpActionMultiplierBps(1000n, [0n, 500n])).toBe(1000);
    expect(temporalXpActionMultiplierBps(2000n, [500n])).toBe(10000);
  });

  it.each([[0, 10000], [1, 12500], [2, 15000], [10, 15000]])('caps %i additional targets at %i BPS', (targets, expected) => {
    expect(xpImpactMultiplierBps(targets)).toBe(expected);
  });
});

describe('core-v1 RC1.1 approved timeline scenarios', () => {
  const profileCycle = (name: Parameters<typeof getRepresentativeTemporalProfile>[0]): bigint => getRepresentativeTemporalProfile(name).cycle;
  const scenarios = [
    ['balanced against balanced', 1000n, 1000n, 10000],
    ['dagger against heavy weapon', profileCycle('dagger'), profileCycle('heavy_axe'), 7500],
    ['short sword against bow', profileCycle('short_sword'), profileCycle('bow'), 7500],
    ['fast against slow', 500n, 2000n, 7500],
    ['extremely fast against five slow', 500n, 2000n, 12500],
    ['overloaded', 2000n, 1000n, 20000],
    ['haste', 500n, 1000n, 7500],
    ['slow', 2000n, 1000n, 20000],
    ['fast Fireball', 850n, 1000n, 8500],
    ['long spell', profileCycle('long_spell'), 1000n, 20000],
    ['interrupted casting', 1200n, 1000n, 12000],
    ['target swap', 1000n, 1000n, 10000],
    ['Whirlwind', profileCycle('whirlwind'), 1000n, 14000],
    ['chain against three', 1000n, 1000n, 10000],
    ['defensive reaction', 1150n, 1000n, 11500],
    ['counter-attack', 1400n, 1000n, 14000],
    ['same tick', 1000n, 1000n, 10000],
    ['boss secondary slot', 1000n, 667n, 14993],
    ['three players against three standards', 1000n, 1000n, 10000],
    ['twelve participants', 1000n, 1000n, 10000],
  ] as const;

  it.each(scenarios)('%s remains deterministic and bounded', (_name, partyCycle, hostileCycle, expectedFactor) => {
    const partyCount = _name === 'three players against three standards' ? 3 : _name === 'twelve participants' ? 6 : 1;
    const hostileCount = _name === 'three players against three standards' ? 3 : _name === 'twelve participants' ? 6 : _name === 'extremely fast against five slow' ? 5 : 1;
    const party = Array.from({ length: partyCount }, () => ({ cycle: partyCycle }));
    const hostile = Array.from({ length: hostileCount }, () => ({ cycle: hostileCycle }));
    const first = calculateActionEconomyFactorBps(party, hostile);
    expect(first).toBe(expectedFactor);
    expect(calculateActionEconomyFactorBps(party, hostile)).toBe(first);
    expect(first).toBeGreaterThanOrEqual(7500);
    expect(first).toBeLessThanOrEqual(20000);
  });

  it('keeps representative physical cycle math consistent with profiles', () => {
    const dagger = getRepresentativeTemporalProfile('dagger');
    expect(calculatePhysicalActionTimes(dagger.preparation, dagger.recovery, 10000)).toEqual(dagger);
  });
});

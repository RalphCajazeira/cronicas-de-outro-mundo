import { describe, expect, it } from 'vitest';
import {
  addTicks,
  advanceCombatTick,
  calculateEffectiveCycleTime,
  calculateEffectivePhaseTime,
  calculateFirstNextActionAtTick,
  calculateHybridSpeedBps,
  calculateMagicalActionTimes,
  calculateMagicalSpeed,
  calculatePhysicalActionTimes,
  calculatePhysicalSpeed,
  compareTicks,
  getInitialAttributePreset,
  getRepresentativeTemporalProfile,
  getTemporalProfile,
  tickToDecimalString,
  validateCooldown,
} from './index.js';
import {
  CORE_V1_REPRESENTATIVE_TEMPORAL_PROFILES, CORE_V1_TEMPORAL_PROFILES,
} from './core-v1.action-economy.config.js';

describe('core-v1 bigint ticks', () => {
  it('validates, adds, compares, advances and serializes ticks without number conversion', () => {
    const tick = addTicks(9_000_000_000_000_000n - 1n, 1n);
    expect(typeof tick).toBe('bigint');
    expect(tickToDecimalString(tick)).toBe('9000000000000000');
    expect(compareTicks(1n, 2n)).toBe(-1);
    expect(compareTicks(2n, 2n)).toBe(0);
    expect(compareTicks(3n, 2n)).toBe(1);
    expect(advanceCombatTick(10n, 100n)).toBe(100n);
    expect(() => addTicks(-1n, 1n)).toThrow('must not be negative');
    expect(() => addTicks(9_000_000_000_000_000n, 1n)).toThrow('supported maximum');
    expect(() => advanceCombatTick(100n, 99n)).toThrow('past');
    expect(() => advanceCombatTick(0n, 1_000_000_001n)).toThrow('supported maximum');
    expect(() => tickToDecimalString(1 as never)).toThrow('bigint');
    expect(validateCooldown(100n)).toBe(100n);
    expect(() => validateCooldown(99n)).toThrow('at least 100');
  });
});

describe('core-v1 action phase times and immutable profiles', () => {
  it.each([
    [5000, 2000n], [7500, 1334n], [10000, 1000n], [15000, 667n], [20000, 500n],
  ])('scales a 1000 tick phase at %i BPS to %s', (speed, expected) => {
    expect(calculateEffectivePhaseTime(1000n, speed)).toBe(expected);
  });

  it('keeps zero phases at zero and applies phase/cycle clamps', () => {
    expect(calculateEffectivePhaseTime(0n, 10000)).toBe(0n);
    expect(calculateEffectivePhaseTime(1n, 20000)).toBe(50n);
    expect(calculateEffectivePhaseTime(1_000_000n, 5000)).toBe(20000n);
    expect(calculateEffectiveCycleTime(50n, 0n)).toBe(100n);
    expect(calculateEffectiveCycleTime(20000n, 20000n)).toBe(40000n);
    expect(() => calculateEffectiveCycleTime(0n, 0n)).toThrow('non-zero phase');
  });

  it.each([
    ['quick', 350n, 250n, 600n],
    ['normal', 550n, 450n, 1000n],
    ['heavy', 800n, 700n, 1500n],
    ['very_heavy', 1100n, 900n, 2000n],
  ] as const)('returns the %s profile', (name, preparation, recovery, cycle) => {
    expect(getTemporalProfile(name)).toEqual({ preparation, recovery, cycle });
  });

  it('returns defensive representative copies and keeps internal tables frozen', () => {
    const dagger = getRepresentativeTemporalProfile('dagger') as { preparation: bigint };
    dagger.preparation = 999n;
    expect(getRepresentativeTemporalProfile('dagger').preparation).toBe(350n);
    expect(getRepresentativeTemporalProfile('fireball')).toEqual({ preparation: 700n, recovery: 500n, cycle: 1200n });
    expect(getRepresentativeTemporalProfile('long_spell').cycle).toBe(2100n);
    expect(Object.isFrozen(CORE_V1_TEMPORAL_PROFILES.quick)).toBe(true);
    expect(Object.isFrozen(CORE_V1_REPRESENTATIVE_TEMPORAL_PROFILES.dagger)).toBe(true);
  });

  it('exposes the revision but keeps mutable configuration tables outside the public barrel', async () => {
    const publicApi: object = await import('./index.js');
    expect('CORE_V1_ACTION_ECONOMY_REVISION' in publicApi).toBe(true);
    expect('CORE_V1_TEMPORAL_PROFILES' in publicApi).toBe(false);
    expect('CORE_V1_REACTION_DEFINITIONS' in publicApi).toBe(false);
  });

  it('calculates physical and magical recovery independently', () => {
    expect(calculatePhysicalActionTimes(550n, 450n, 20000)).toEqual({ preparation: 275n, recovery: 225n, cycle: 500n });
    expect(calculateMagicalActionTimes(700n, 500n, 20000, 10000)).toEqual({ preparation: 350n, recovery: 500n, cycle: 850n });
    expect(calculateMagicalActionTimes(700n, 500n, 20000, 12500).recovery).toBe(400n);
    expect(calculatePhysicalActionTimes(1n, 0n, 20000)).toEqual({ preparation: 100n, recovery: 0n, cycle: 100n });
  });
});

describe('core-v1 physical, magical and hybrid speeds', () => {
  const balanced = getInitialAttributePreset('balanced');

  it('handles light, heavy, two-handed and rank 0/10 weapons', () => {
    const light = calculatePhysicalSpeed({
      attributes: balanced, weaponFamilyRank: 0, weaponWeightUnits: 10, twoHanded: false,
      carriedWeightUnits: 70, carryingCapacityUnits: 100,
    });
    const heavy = calculatePhysicalSpeed({
      attributes: balanced, weaponFamilyRank: 10, weaponWeightUnits: 200, twoHanded: false,
      carriedWeightUnits: 70, carryingCapacityUnits: 100,
    });
    const twoHanded = calculatePhysicalSpeed({
      attributes: balanced, weaponFamilyRank: 10, weaponWeightUnits: 200, twoHanded: true,
      carriedWeightUnits: 70, carryingCapacityUnits: 100,
    });
    expect(light).toMatchObject({ rankSpeedBonusBps: 0, handlingPenaltyBps: 0, effectiveAttackSpeedBps: 10000 });
    expect(heavy.rankSpeedBonusBps).toBe(1000);
    expect(heavy.handlingPenaltyBps).toBe(2500);
    expect(twoHanded.handledWeaponWeight).toBe(160);
    expect(twoHanded.handlingPenaltyBps).toBe(500);
  });

  it.each([
    [70, 'normal', 0, true],
    [71, 'encumbered', 1000, true],
    [101, 'heavily_encumbered', 2500, true],
    [126, 'overloaded', 2500, false],
  ] as const)('maps load %i to %s', (load, state, penalty, allowed) => {
    expect(calculatePhysicalSpeed({
      attributes: balanced, weaponFamilyRank: 0, weaponWeightUnits: 0, twoHanded: false,
      carriedWeightUnits: load, carryingCapacityUnits: 100,
    })).toMatchObject({ encumbranceState: state, encumbrancePenaltyBps: penalty, canStartAttackOrMovement: allowed });
  });

  it('applies haste/slow after physical modifiers and clamps', () => {
    const haste = calculatePhysicalSpeed({
      attributes: balanced, weaponFamilyRank: 10, weaponWeightUnits: 0, twoHanded: false,
      carriedWeightUnits: 0, carryingCapacityUnits: 100, statusSpeedMultiplierBps: 20000,
    });
    const slow = calculatePhysicalSpeed({
      attributes: balanced, weaponFamilyRank: 0, weaponWeightUnits: 0, twoHanded: false,
      carriedWeightUnits: 0, carryingCapacityUnits: 100, statusSpeedMultiplierBps: 5000,
    });
    expect(haste.effectiveAttackSpeedBps).toBe(20000);
    expect(slow.effectiveAttackSpeedBps).toBe(5000);
  });

  it('applies school rank, armor and status while separating magical recovery', () => {
    const speed = calculateMagicalSpeed({
      attributes: balanced, magicSchoolRank: 10, armorCastingPenaltyBps: 2000,
      statusSpeedMultiplierBps: 15000,
    });
    expect(speed).toMatchObject({ baseCastingSpeedBps: 10000, schoolRankSpeedBonusBps: 750, effectiveCastingSpeedBps: 13125, recoverySpeedBps: 10000 });
    expect(calculateMagicalSpeed({
      attributes: balanced, magicSchoolRank: 0, armorCastingPenaltyBps: 0,
      statusSpeedMultiplierBps: 20000, explicitRecoveryModifiers: 2500,
    })).toMatchObject({ effectiveCastingSpeedBps: 20000, recoverySpeedBps: 12500 });
  });

  it('calculates harmonic hybrid speed and rejects invalid inputs', () => {
    expect(calculateHybridSpeedBps(10000, 10000)).toBe(10000);
    expect(calculateHybridSpeedBps(5000, 20000)).toBe(8000);
    expect(() => calculateHybridSpeedBps(0, 10000)).toThrow('between 5000 and 20000');
    expect(calculateFirstNextActionAtTick(30, false)).toBe(500n);
    expect(calculateFirstNextActionAtTick(30, true)).toBe(1500n);
  });
});

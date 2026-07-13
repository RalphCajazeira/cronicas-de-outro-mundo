import {
  CORE_V1_REPRESENTATIVE_TEMPORAL_PROFILES, CORE_V1_TEMPORAL_PROFILES,
} from './core-v1.action-economy.config.js';
import type {
  MagicalSpeedInput, MagicalSpeedResult, PhysicalSpeedInput, PhysicalSpeedResult,
  RepresentativeTemporalProfileName, TemporalProfile, TemporalProfileName,
} from './core-v1.action-economy.types.js';
import {
  calculateBaseAttackSpeedBps, calculateBaseCastingSpeedBps,
} from './core-v1.attributes.js';
import {
  assertInteger, assertIntegerInRange, clamp, roundHalfUp, safeIntegerAdd,
  safeIntegerMultiply, safeIntegerSum,
} from './core-v1.math.js';
import {
  assertTick, ceilDivBigInt, roundHalfUpDivBigInt,
} from './core-v1.ticks.js';

function assertNonNegativeInteger(value: number, name: string): void {
  assertInteger(value, name);
  if (value < 0) throw new RangeError(`${name} must not be negative`);
}

function assertSpeedMultiplier(value: number, name: string): void {
  assertIntegerInRange(value, 1, 40000, name);
}

export function getTemporalProfile(name: TemporalProfileName): TemporalProfile {
  const profile = CORE_V1_TEMPORAL_PROFILES[name];
  if (profile === undefined) throw new TypeError('temporal profile is invalid');
  return { ...profile };
}

export function getRepresentativeTemporalProfile(name: RepresentativeTemporalProfileName): TemporalProfile {
  const profile = CORE_V1_REPRESENTATIVE_TEMPORAL_PROFILES[name];
  if (profile === undefined) throw new TypeError('representative temporal profile is invalid');
  return { ...profile };
}

export function calculateEffectivePhaseTime(basePhaseTime: bigint, effectiveSpeedBps: number): bigint {
  assertTick(basePhaseTime, 'basePhaseTime');
  assertIntegerInRange(effectiveSpeedBps, 5000, 20000, 'effectiveSpeedBps');
  if (basePhaseTime === 0n) return 0n;
  const calculated = ceilDivBigInt(basePhaseTime * 10000n, BigInt(effectiveSpeedBps), 'effective phase time');
  return calculated < 50n ? 50n : calculated > 20000n ? 20000n : calculated;
}

export function calculateEffectiveCycleTime(preparation: bigint, recovery: bigint): bigint {
  assertTick(preparation, 'preparation');
  assertTick(recovery, 'recovery');
  if (preparation === 0n && recovery === 0n) {
    throw new RangeError('an active action must have at least one non-zero phase');
  }
  const cycle = preparation + recovery;
  return cycle < 100n ? 100n : cycle > 40000n ? 40000n : cycle;
}

export function calculatePhysicalActionTimes(
  baseActionTime: bigint,
  baseRecoveryTime: bigint,
  effectiveAttackSpeedBps: number,
): TemporalProfile {
  let preparation = calculateEffectivePhaseTime(baseActionTime, effectiveAttackSpeedBps);
  let recovery = calculateEffectivePhaseTime(baseRecoveryTime, effectiveAttackSpeedBps);
  if (preparation + recovery < 100n) {
    if (recovery > 0n) recovery = 100n - preparation;
    else preparation = 100n;
  }
  return { preparation, recovery, cycle: calculateEffectiveCycleTime(preparation, recovery) };
}

export function calculateMagicalActionTimes(
  castTime: bigint,
  recoveryTime: bigint,
  effectiveCastingSpeedBps: number,
  recoverySpeedBps: number,
): TemporalProfile {
  assertIntegerInRange(recoverySpeedBps, 7500, 12500, 'recoverySpeedBps');
  let preparation = calculateEffectivePhaseTime(castTime, effectiveCastingSpeedBps);
  let recovery = calculateEffectivePhaseTime(recoveryTime, recoverySpeedBps);
  if (preparation + recovery < 100n) {
    if (recovery > 0n) recovery = 100n - preparation;
    else preparation = 100n;
  }
  return { preparation, recovery, cycle: calculateEffectiveCycleTime(preparation, recovery) };
}

export function calculateHybridSpeedBps(attackSpeedBps: number, castingSpeedBps: number): number {
  assertIntegerInRange(attackSpeedBps, 5000, 20000, 'attackSpeedBps');
  assertIntegerInRange(castingSpeedBps, 5000, 20000, 'castingSpeedBps');
  const denominator = BigInt(attackSpeedBps) + BigInt(castingSpeedBps);
  if (denominator === 0n) throw new RangeError('hybrid speed denominator must not be zero');
  const value = (2n * BigInt(attackSpeedBps) * BigInt(castingSpeedBps)) / denominator;
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new RangeError('hybrid speed must be a safe integer');
  return clamp(5000, 20000, result);
}

export function calculateEncumbrance(
  carriedWeightUnits: number,
  carryingCapacityUnits: number,
): Pick<PhysicalSpeedResult, 'encumbranceState' | 'encumbrancePenaltyBps' | 'canStartAttackOrMovement'> {
  assertNonNegativeInteger(carriedWeightUnits, 'carriedWeightUnits');
  assertNonNegativeInteger(carryingCapacityUnits, 'carryingCapacityUnits');
  if (carryingCapacityUnits === 0) {
    if (carriedWeightUnits === 0) {
      return { encumbranceState: 'normal', encumbrancePenaltyBps: 0, canStartAttackOrMovement: true };
    }
    return { encumbranceState: 'overloaded', encumbrancePenaltyBps: 2500, canStartAttackOrMovement: false };
  }
  const scaledWeight = BigInt(carriedWeightUnits) * 100n;
  const scaledCapacity = BigInt(carryingCapacityUnits);
  if (scaledWeight <= scaledCapacity * 70n) {
    return { encumbranceState: 'normal', encumbrancePenaltyBps: 0, canStartAttackOrMovement: true };
  }
  if (scaledWeight <= scaledCapacity * 100n) {
    return { encumbranceState: 'encumbered', encumbrancePenaltyBps: 1000, canStartAttackOrMovement: true };
  }
  if (scaledWeight <= scaledCapacity * 125n) {
    return { encumbranceState: 'heavily_encumbered', encumbrancePenaltyBps: 2500, canStartAttackOrMovement: true };
  }
  return { encumbranceState: 'overloaded', encumbrancePenaltyBps: 2500, canStartAttackOrMovement: false };
}

export function calculatePhysicalSpeed(input: PhysicalSpeedInput): PhysicalSpeedResult {
  assertIntegerInRange(input.weaponFamilyRank, 0, 10, 'weaponFamilyRank');
  assertNonNegativeInteger(input.weaponWeightUnits, 'weaponWeightUnits');
  if (typeof input.twoHanded !== 'boolean') throw new TypeError('twoHanded must be boolean');
  const actionModifier = input.actionSpecificSpeedModifiers ?? 0;
  const statusMultiplier = input.statusSpeedMultiplierBps ?? 10000;
  assertInteger(actionModifier, 'actionSpecificSpeedModifiers');
  assertSpeedMultiplier(statusMultiplier, 'statusSpeedMultiplierBps');
  const baseAttackSpeedBps = calculateBaseAttackSpeedBps(input.attributes);
  const rankSpeedBonusBps = Math.min(1000, safeIntegerMultiply(100, input.weaponFamilyRank, 'rank speed bonus'));
  const weaponHandlingCapacity = safeIntegerSum([
    safeIntegerMultiply(10, input.attributes.strength, 'weapon handling strength'),
    safeIntegerMultiply(5, input.attributes.dexterity, 'weapon handling dexterity'),
  ], 'weapon handling capacity');
  const handledWeaponWeight = input.twoHanded
    ? Number(ceilDivBigInt(BigInt(input.weaponWeightUnits) * 8n, 10n, 'two-handed weight'))
    : input.weaponWeightUnits;
  const handlingPenaltyBps = Math.min(2500, safeIntegerMultiply(
    50, Math.max(0, handledWeaponWeight - weaponHandlingCapacity), 'handling penalty',
  ));
  const encumbrance = calculateEncumbrance(input.carriedWeightUnits, input.carryingCapacityUnits);
  const preStatusSpeed = safeIntegerSum([
    baseAttackSpeedBps, rankSpeedBonusBps, -handlingPenaltyBps,
    -encumbrance.encumbrancePenaltyBps, actionModifier,
  ], 'physical pre-status speed');
  const scaled = safeIntegerMultiply(preStatusSpeed, statusMultiplier, 'physical status speed');
  return {
    baseAttackSpeedBps,
    rankSpeedBonusBps,
    weaponHandlingCapacity,
    handledWeaponWeight,
    handlingPenaltyBps,
    ...encumbrance,
    effectiveAttackSpeedBps: clamp(5000, 20000, roundHalfUp(scaled / 10000)),
  };
}

export function calculateMagicalSpeed(input: MagicalSpeedInput): MagicalSpeedResult {
  assertIntegerInRange(input.magicSchoolRank, 0, 10, 'magicSchoolRank');
  assertNonNegativeInteger(input.armorCastingPenaltyBps, 'armorCastingPenaltyBps');
  const statusMultiplier = input.statusSpeedMultiplierBps ?? 10000;
  const recoveryModifier = input.explicitRecoveryModifiers ?? 0;
  assertSpeedMultiplier(statusMultiplier, 'statusSpeedMultiplierBps');
  assertInteger(recoveryModifier, 'explicitRecoveryModifiers');
  const baseCastingSpeedBps = calculateBaseCastingSpeedBps(input.attributes);
  const schoolRankSpeedBonusBps = Math.min(750, safeIntegerMultiply(75, input.magicSchoolRank, 'school rank speed bonus'));
  const preStatusSpeed = safeIntegerAdd(
    safeIntegerAdd(baseCastingSpeedBps, schoolRankSpeedBonusBps, 'casting pre-status speed'),
    -input.armorCastingPenaltyBps,
    'casting pre-status speed',
  );
  const scaled = safeIntegerMultiply(preStatusSpeed, statusMultiplier, 'casting status speed');
  return {
    baseCastingSpeedBps,
    schoolRankSpeedBonusBps,
    effectiveCastingSpeedBps: clamp(5000, 20000, roundHalfUp(scaled / 10000)),
    recoverySpeedBps: clamp(7500, 12500, safeIntegerAdd(10000, recoveryModifier, 'magic recovery speed')),
  };
}

export function applyTickMultiplier(time: bigint, multiplierBps: number, minimum = 0n): bigint {
  assertTick(time, 'time');
  assertIntegerInRange(multiplierBps, 1, 40000, 'multiplierBps');
  const result = roundHalfUpDivBigInt(time * BigInt(multiplierBps), 10000n, 'tick multiplier');
  return result < minimum ? minimum : result;
}

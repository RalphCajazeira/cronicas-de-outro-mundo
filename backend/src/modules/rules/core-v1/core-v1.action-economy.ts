import {
  CORE_V1_ENCOUNTER_WINDOW_TICKS, CORE_V1_TEMPORAL_XP_WINDOW_TICKS,
} from './core-v1.action-economy.config.js';
import type { TemporalSlotInput } from './core-v1.action-economy.types.js';
import {
  assertIntegerInRange, clamp, roundHalfUp, safeIntegerAdd, safeIntegerMultiply, safeIntegerSum,
} from './core-v1.math.js';
import { assertTick, roundHalfUpDivBigInt } from './core-v1.ticks.js';

function bigintToSafeNumber(value: bigint, name: string): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted)) throw new RangeError(`${name} must be a safe integer`);
  return converted;
}

function assertActionCycle(cycle: bigint, name: string): void {
  assertTick(cycle, name);
  if (cycle < 100n || cycle > 40000n) throw new RangeError(`${name} must be between 100 and 40000 ticks`);
}

export function calculateReferenceCycle(
  basicAttackCycle: bigint,
  sustainableSignatureCycle: bigint,
  movementOrDefenseCycle: bigint,
): bigint {
  [basicAttackCycle, sustainableSignatureCycle, movementOrDefenseCycle].forEach((value, index) => {
    assertActionCycle(value, ['basicAttackCycle', 'sustainableSignatureCycle', 'movementOrDefenseCycle'][index] ?? 'cycle');
  });
  const signatureSustainable = sustainableSignatureCycle * 2n <= CORE_V1_ENCOUNTER_WINDOW_TICKS;
  const numerator = signatureSustainable
    ? 70n * basicAttackCycle + 20n * sustainableSignatureCycle + 10n * movementOrDefenseCycle
    : 90n * basicAttackCycle + 10n * movementOrDefenseCycle;
  return roundHalfUpDivBigInt(numerator, 100n, 'reference cycle');
}

export function expectedActionsPerWindowBps(referenceCycle: bigint): number {
  assertActionCycle(referenceCycle, 'referenceCycle');
  return bigintToSafeNumber(CORE_V1_ENCOUNTER_WINDOW_TICKS * 10000n / referenceCycle, 'expected actions');
}

export function actionSlotEquivalentBps(referenceCycle: bigint): number {
  return roundHalfUp(expectedActionsPerWindowBps(referenceCycle) / 10);
}

export function calculateTemporalSlots(slots: readonly TemporalSlotInput[]): number {
  const runtimeSlots: unknown = slots;
  if (!Array.isArray(runtimeSlots) || slots.length === 0) throw new RangeError('at least one temporal slot is required');
  return slots.reduce((total, slot) => {
    const secondary = slot.secondary ?? false;
    if (typeof secondary !== 'boolean') throw new TypeError('secondary must be boolean');
    if (!secondary && slot.potencyMultiplierBps !== undefined && slot.potencyMultiplierBps !== 10000) {
      throw new RangeError('only secondary slots can use reduced or increased potency');
    }
    const potency = secondary ? slot.potencyMultiplierBps ?? 10000 : 10000;
    assertIntegerInRange(potency, 1, 20000, 'potencyMultiplierBps');
    const equivalent = actionSlotEquivalentBps(slot.cycle);
    const weighted = roundHalfUp(safeIntegerMultiply(equivalent, potency, 'weighted temporal slot') / 10000);
    return safeIntegerAdd(total, weighted, 'temporal slots');
  }, 0);
}

export function calculateActionEconomyFactorBps(
  partySlots: readonly TemporalSlotInput[],
  hostileSlots: readonly TemporalSlotInput[],
): number {
  const partyActionSlots = calculateTemporalSlots(partySlots);
  const hostileActionSlots = calculateTemporalSlots(hostileSlots);
  if (partyActionSlots === 0) throw new RangeError('party action slots must not be zero');
  const ratio = roundHalfUp(safeIntegerMultiply(hostileActionSlots, 10000, 'action economy ratio') / partyActionSlots);
  return clamp(7500, 20000, ratio);
}

export function calculateAdjustedThreat(baseThreat: number, actionEconomyFactorBps: number): number {
  assertIntegerInRange(baseThreat, 0, Number.MAX_SAFE_INTEGER, 'baseThreat');
  assertIntegerInRange(actionEconomyFactorBps, 7500, 20000, 'actionEconomyFactorBps');
  return roundHalfUp(safeIntegerMultiply(baseThreat, actionEconomyFactorBps, 'adjusted threat') / 10000);
}

export function calculateEncounterThreat(
  baseThreats: readonly number[],
  partySlots: readonly TemporalSlotInput[],
  hostileSlots: readonly TemporalSlotInput[],
): { readonly baseThreat: number; readonly actionEconomyFactorBps: number; readonly adjustedThreat: number } {
  const runtimeBaseThreats: unknown = baseThreats;
  if (!Array.isArray(runtimeBaseThreats) || baseThreats.length === 0) throw new RangeError('at least one base threat is required');
  baseThreats.forEach((value) => assertIntegerInRange(value, 0, Number.MAX_SAFE_INTEGER, 'baseThreat'));
  const baseThreat = safeIntegerSum(baseThreats, 'base threat total');
  const actionEconomyFactorBps = calculateActionEconomyFactorBps(partySlots, hostileSlots);
  return { baseThreat, actionEconomyFactorBps, adjustedThreat: calculateAdjustedThreat(baseThreat, actionEconomyFactorBps) };
}

export function temporalXpActionMultiplierBps(
  actionTick: bigint,
  previousEquivalentActionTicks: readonly bigint[],
): number {
  assertTick(actionTick, 'actionTick');
  const runtimeTicks: unknown = previousEquivalentActionTicks;
  if (!Array.isArray(runtimeTicks)) throw new TypeError('previousEquivalentActionTicks must be an array');
  const windowStart = actionTick >= CORE_V1_TEMPORAL_XP_WINDOW_TICKS
    ? actionTick - CORE_V1_TEMPORAL_XP_WINDOW_TICKS
    : 0n;
  const previousInWindow = previousEquivalentActionTicks.filter((tick) => {
    assertTick(tick, 'previous action tick');
    if (tick > actionTick) throw new RangeError('previous action tick must not be in the future');
    return tick >= windowStart;
  }).length;
  return previousInWindow === 0 ? 10000 : previousInWindow === 1 ? 5000 : 1000;
}

export function xpImpactMultiplierBps(additionalMeaningfulTargets: number): number {
  assertIntegerInRange(additionalMeaningfulTargets, 0, Number.MAX_SAFE_INTEGER, 'additionalMeaningfulTargets');
  if (additionalMeaningfulTargets >= 2) return 15000;
  return Math.min(15000, safeIntegerAdd(
    10000,
    safeIntegerMultiply(2500, additionalMeaningfulTargets, 'multi-target XP impact'),
    'multi-target XP impact',
  ));
}

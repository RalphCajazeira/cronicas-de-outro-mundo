import {
  CORE_V1_MAX_COMBAT_TICK, CORE_V1_MAX_TECHNICAL_TICK,
} from './core-v1.action-economy.config.js';
import type { CombatTick } from './core-v1.action-economy.types.js';

export function assertTick(tick: CombatTick, name = 'tick', maximum = CORE_V1_MAX_TECHNICAL_TICK): void {
  if (typeof tick !== 'bigint') throw new TypeError(`${name} must be a bigint`);
  if (tick < 0n) throw new RangeError(`${name} must not be negative`);
  if (tick > maximum) throw new RangeError(`${name} exceeds the supported maximum`);
}

export function assertCombatTick(tick: CombatTick, name = 'combatTick'): void {
  assertTick(tick, name, CORE_V1_MAX_COMBAT_TICK);
}

export function addTicks(left: CombatTick, right: CombatTick, name = 'tick sum'): CombatTick {
  assertTick(left, `${name} left operand`);
  assertTick(right, `${name} right operand`);
  const result = left + right;
  assertTick(result, name);
  return result;
}

export function compareTicks(left: CombatTick, right: CombatTick): -1 | 0 | 1 {
  assertTick(left, 'left tick');
  assertTick(right, 'right tick');
  return left < right ? -1 : left > right ? 1 : 0;
}

export function advanceCombatTick(current: CombatTick, next: CombatTick): CombatTick {
  assertCombatTick(current, 'currentTick');
  assertCombatTick(next, 'nextTick');
  if (next < current) throw new RangeError('nextTick must not be in the past');
  return next;
}

export function calculatePhaseTick(startTick: CombatTick, phaseTime: CombatTick): CombatTick {
  return addTicks(startTick, phaseTime, 'phase tick');
}

export function calculateCycleTick(
  startTick: CombatTick,
  preparationTime: CombatTick,
  recoveryTime: CombatTick,
): CombatTick {
  return addTicks(calculatePhaseTick(startTick, preparationTime), recoveryTime, 'cycle tick');
}

export function tickToDecimalString(tick: CombatTick): string {
  assertTick(tick);
  return tick.toString(10);
}

export function ceilDivBigInt(dividend: bigint, divisor: bigint, name = 'bigint division'): bigint {
  if (dividend < 0n) throw new RangeError(`${name} dividend must not be negative`);
  if (divisor <= 0n) throw new RangeError(`${name} divisor must be positive`);
  return (dividend + divisor - 1n) / divisor;
}

export function roundHalfUpDivBigInt(dividend: bigint, divisor: bigint, name = 'bigint division'): bigint {
  if (dividend < 0n) throw new RangeError(`${name} dividend must not be negative`);
  if (divisor <= 0n) throw new RangeError(`${name} divisor must be positive`);
  const quotient = dividend / divisor;
  const remainder = dividend % divisor;
  return remainder * 2n >= divisor ? quotient + 1n : quotient;
}

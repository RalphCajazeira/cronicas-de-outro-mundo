import type { AuthorizedNumericModifier, ModifierSourceType } from './core-v1.types.js';

const modifierSourceTypes = new Set<ModifierSourceType>([
  'species', 'class', 'condition', 'equipment', 'status', 'ruleset', 'administrative',
]);

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

export function hasExactOwnKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === expectedKeys.length
    && expectedKeys.every((key) => Object.hasOwn(value, key));
}

export function assertFiniteNumber(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  if (Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${name} must be within the safe number range`);
  }
}

export function assertInteger(value: number, name: string): void {
  assertFiniteNumber(value, name);
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer`);
}

export function clamp(minimum: number, maximum: number, value: number): number {
  assertFiniteNumber(minimum, 'minimum');
  assertFiniteNumber(maximum, 'maximum');
  assertFiniteNumber(value, 'value');
  if (minimum > maximum) throw new RangeError('minimum must not exceed maximum');
  return Math.min(maximum, Math.max(minimum, value));
}

// Mechanical formulas use non-negative values; signed inputs round ties away from zero explicitly.
export function roundHalfUp(value: number): number {
  assertFiniteNumber(value, 'value');
  if (value === 0) return 0;
  const magnitude = Math.abs(value);
  const integerPart = Math.floor(magnitude);
  const roundedMagnitude = magnitude - integerPart >= 0.5
    ? safeIntegerAdd(integerPart, 1, 'rounded value')
    : integerPart;
  return value < 0 ? -roundedMagnitude : roundedMagnitude;
}

// Signed division is supported and follows the mathematical ceiling; zero divisors are always invalid.
export function ceilDiv(dividend: number, divisor: number): number {
  assertInteger(dividend, 'dividend');
  assertInteger(divisor, 'divisor');
  if (divisor === 0) throw new RangeError('divisor must not be zero');
  const result = Math.ceil(dividend / divisor);
  if (!Number.isSafeInteger(result)) throw new RangeError('division result must be a safe integer');
  return result;
}

export function assertIntegerInRange(value: number, minimum: number, maximum: number, name: string): void {
  assertInteger(minimum, 'minimum');
  assertInteger(maximum, 'maximum');
  if (minimum > maximum) throw new RangeError('minimum must not exceed maximum');
  assertInteger(value, name);
  if (value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
}

export function safeIntegerAdd(left: number, right: number, name: string): number {
  assertInteger(left, `${name} left operand`);
  assertInteger(right, `${name} right operand`);
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new RangeError(`${name} must be a safe integer`);
  return result;
}

export function safeIntegerMultiply(left: number, right: number, name: string): number {
  assertInteger(left, `${name} left operand`);
  assertInteger(right, `${name} right operand`);
  const result = left * right;
  if (!Number.isSafeInteger(result)) throw new RangeError(`${name} must be a safe integer`);
  return result;
}

export function safeIntegerSum(values: readonly number[], name: string): number {
  return values.reduce((total, value) => safeIntegerAdd(total, value, name), 0);
}

export function sumAuthorizedModifiers(
  modifiers: readonly AuthorizedNumericModifier[] | undefined,
  name = 'modifiers',
): number {
  if (modifiers === undefined) return 0;
  const runtimeModifiers: unknown = modifiers;
  if (!Array.isArray(runtimeModifiers)) throw new TypeError(`${name} must be an array`);
  return modifiers.reduce((total, modifier, index) => {
    const modifierRecord: unknown = modifier;
    if (!isPlainRecord(modifierRecord) || !hasExactOwnKeys(modifierRecord, ['source', 'value'])) {
      throw new TypeError(`${name}[${index}] must contain only source and value`);
    }
    const source = modifier.source;
    const sourceRecord: unknown = source;
    if (!isPlainRecord(sourceRecord) || !hasExactOwnKeys(sourceRecord, ['type', 'ref'])) {
      throw new TypeError(`${name}[${index}].source must contain only type and ref`);
    }
    if (typeof sourceRecord.type !== 'string'
      || !modifierSourceTypes.has(sourceRecord.type as ModifierSourceType)) {
      throw new TypeError(`${name}[${index}].source.type is not authorized`);
    }
    if (typeof sourceRecord.ref !== 'string' || sourceRecord.ref.trim().length === 0) {
      throw new TypeError(`${name}[${index}].source.ref must not be empty`);
    }
    assertInteger(modifier.value, `${name}[${index}].value`);
    return safeIntegerAdd(total, modifier.value, `${name} total`);
  }, 0);
}

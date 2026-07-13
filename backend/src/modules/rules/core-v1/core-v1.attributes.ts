import {
  CORE_V1_ATTRIBUTE_HARD_CAP,
  CORE_V1_ATTRIBUTE_PRESETS,
  CORE_V1_CREATION_ATTRIBUTE_MAX,
  CORE_V1_CREATION_ATTRIBUTE_MIN,
  CORE_V1_INITIAL_ATTRIBUTE_BUDGET,
  CORE_V1_LEVEL_CAP,
  CORE_V1_PRIMARY_ATTRIBUTES,
} from './core-v1.config.js';
import {
  assertInteger, assertIntegerInRange, clamp, isPlainRecord, safeIntegerAdd, safeIntegerSum,
  sumAuthorizedModifiers,
} from './core-v1.math.js';
import type {
  AuthorizedNumericModifier, PrimaryAttributeCode, PrimaryAttributePreset, PrimaryAttributes,
  ResourceMaximums, ResourceModifierSet, SecondaryAttributeInput, SecondaryAttributes, ValidationIssue,
  ValidationResult,
} from './core-v1.types.js';

function assertKnownKeys(value: unknown, allowedKeys: readonly string[], name: string): void {
  if (!isPlainRecord(value)) throw new TypeError(`${name} must be a plain object`);
  const unknownKey = Object.keys(value).find((key) => !allowedKeys.includes(key));
  if (unknownKey !== undefined) throw new TypeError(`${name}.${unknownKey} is not supported`);
}

function sumWithModifiers(
  values: readonly number[],
  modifiers: readonly AuthorizedNumericModifier[] | undefined,
  name: string,
): number {
  return safeIntegerSum([...values, sumAuthorizedModifiers(modifiers, `${name}Modifiers`)], name);
}

export function validateInitialPrimaryAttributes(input: unknown): ValidationResult<PrimaryAttributes> {
  if (!isPlainRecord(input)) {
    return { ok: false, issues: [{ path: 'primaryAttributes', rule: 'PLAIN_OBJECT', message: 'Primary attributes must be a plain object' }] };
  }

  const issues: ValidationIssue[] = [];
  const allowed = new Set<string>(CORE_V1_PRIMARY_ATTRIBUTES);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  unknown.forEach((key) => issues.push({
    path: `primaryAttributes.${key}`, rule: 'UNKNOWN_ATTRIBUTE', message: 'Unknown primary attribute', received: key,
  }));

  let total = 0;
  for (const attribute of CORE_V1_PRIMARY_ATTRIBUTES) {
    if (!Object.hasOwn(input, attribute)) {
      issues.push({ path: `primaryAttributes.${attribute}`, rule: 'REQUIRED', message: 'Primary attribute is required' });
      continue;
    }
    const value = input[attribute];
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      issues.push({ path: `primaryAttributes.${attribute}`, rule: 'INTEGER', message: 'Primary attribute must be an integer', received: value });
      continue;
    }
    if (value < CORE_V1_CREATION_ATTRIBUTE_MIN || value > CORE_V1_CREATION_ATTRIBUTE_MAX) {
      issues.push({
        path: `primaryAttributes.${attribute}`,
        rule: 'CREATION_RANGE',
        message: `Primary attribute must be between ${CORE_V1_CREATION_ATTRIBUTE_MIN} and ${CORE_V1_CREATION_ATTRIBUTE_MAX}`,
        expected: { minimum: CORE_V1_CREATION_ATTRIBUTE_MIN, maximum: CORE_V1_CREATION_ATTRIBUTE_MAX },
        received: value,
      });
    }
    total += value;
  }

  if (CORE_V1_PRIMARY_ATTRIBUTES.every((attribute) => Number.isSafeInteger(input[attribute]))
    && total !== CORE_V1_INITIAL_ATTRIBUTE_BUDGET) {
    issues.push({
      path: 'primaryAttributes',
      rule: 'INITIAL_ATTRIBUTE_BUDGET',
      message: `The initial primary attribute allocation must total exactly ${CORE_V1_INITIAL_ATTRIBUTE_BUDGET} points`,
      expected: { total: CORE_V1_INITIAL_ATTRIBUTE_BUDGET },
      received: { total },
    });
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: Object.fromEntries(CORE_V1_PRIMARY_ATTRIBUTES.map((attribute) => [attribute, input[attribute]])) as PrimaryAttributes };
}

export function getInitialAttributePreset(preset: PrimaryAttributePreset): PrimaryAttributes {
  const attributes = CORE_V1_ATTRIBUTE_PRESETS[preset];
  if (attributes === undefined) throw new TypeError('initial attribute preset is invalid');
  return { ...attributes };
}

function assertPrimaryAttributes(attributes: PrimaryAttributes): void {
  assertKnownKeys(attributes, CORE_V1_PRIMARY_ATTRIBUTES, 'attributes');
  if (Object.keys(attributes).length !== CORE_V1_PRIMARY_ATTRIBUTES.length) {
    throw new TypeError('attributes must contain every primary attribute exactly once');
  }
  for (const attribute of CORE_V1_PRIMARY_ATTRIBUTES) {
    if (!Object.hasOwn(attributes, attribute)) {
      throw new TypeError(`attributes.${attribute} is required`);
    }
    assertIntegerInRange(attributes[attribute], 0, CORE_V1_ATTRIBUTE_HARD_CAP, `attributes.${attribute}`);
  }
}

export function calculateEffectiveAttribute(
  base: number,
  modifiers?: readonly AuthorizedNumericModifier[],
): number {
  assertIntegerInRange(base, 0, CORE_V1_ATTRIBUTE_HARD_CAP, 'base');
  return clamp(0, CORE_V1_ATTRIBUTE_HARD_CAP, safeIntegerAdd(base, sumAuthorizedModifiers(modifiers), 'effectiveAttribute'));
}

export function calculateEffectiveAttributes(
  base: PrimaryAttributes,
  modifiers: Partial<Record<PrimaryAttributeCode, readonly AuthorizedNumericModifier[]>> = {},
): PrimaryAttributes {
  assertPrimaryAttributes(base);
  assertKnownKeys(modifiers, CORE_V1_PRIMARY_ATTRIBUTES, 'attributeModifiers');
  return Object.fromEntries(CORE_V1_PRIMARY_ATTRIBUTES.map((attribute) => [
    attribute,
    calculateEffectiveAttribute(base[attribute], modifiers[attribute]),
  ])) as PrimaryAttributes;
}

export function calculateResourceMaximums(
  attributes: PrimaryAttributes,
  level: number,
  modifiers: ResourceModifierSet = {},
): ResourceMaximums {
  assertPrimaryAttributes(attributes);
  assertIntegerInRange(level, 1, CORE_V1_LEVEL_CAP, 'level');
  assertKnownKeys(modifiers, ['maxHp', 'maxMana', 'maxSp'], 'resourceModifiers');
  const levelOffset = level - 1;
  return {
    maxHp: clamp(1, 999, sumWithModifiers([
      20, 2 * attributes.vitality, Math.floor(attributes.strength / 2), 4 * levelOffset,
    ], modifiers.maxHp, 'maxHp')),
    maxMana: clamp(0, 999, sumWithModifiers([
      5, attributes.intelligence, attributes.wisdom, attributes.willpower, 2 * levelOffset,
    ], modifiers.maxMana, 'maxMana')),
    maxSp: clamp(0, 999, sumWithModifiers([
      10, attributes.vitality,
      Math.floor(safeIntegerSum([attributes.strength, attributes.agility, attributes.willpower], 'maxSp attributes') / 2),
      2 * levelOffset,
    ], modifiers.maxSp, 'maxSp')),
  };
}

export function calculateActorPhysicalPower(
  attributes: PrimaryAttributes,
  weaponFamilyRank: number,
  modifiers?: readonly AuthorizedNumericModifier[],
): number {
  assertPrimaryAttributes(attributes);
  assertIntegerInRange(weaponFamilyRank, 0, 10, 'weaponFamilyRank');
  return clamp(0, 200, sumWithModifiers([
    Math.floor((2 * attributes.strength + attributes.dexterity) / 6), Math.floor(weaponFamilyRank / 3),
  ], modifiers, 'actorPhysicalPower'));
}

export function calculateActorMagicalPower(
  attributes: PrimaryAttributes,
  magicSchoolRank: number,
  modifiers?: readonly AuthorizedNumericModifier[],
): number {
  assertPrimaryAttributes(attributes);
  assertIntegerInRange(magicSchoolRank, 0, 10, 'magicSchoolRank');
  return clamp(0, 200, sumWithModifiers([
    Math.floor((2 * attributes.intelligence + attributes.wisdom) / 6), Math.floor(magicSchoolRank / 3),
  ], modifiers, 'actorMagicalPower'));
}

export function calculatePhysicalDefense(attributes: PrimaryAttributes, modifiers?: readonly AuthorizedNumericModifier[]): number {
  assertPrimaryAttributes(attributes);
  return clamp(0, 300, sumWithModifiers([
    Math.floor((attributes.vitality + attributes.strength) / 5),
  ], modifiers, 'physicalDefense'));
}

export function calculateMagicalDefense(attributes: PrimaryAttributes, modifiers?: readonly AuthorizedNumericModifier[]): number {
  assertPrimaryAttributes(attributes);
  return clamp(0, 300, sumWithModifiers([
    Math.floor((attributes.wisdom + attributes.willpower) / 5),
  ], modifiers, 'magicalDefense'));
}

export function calculateAccuracy(
  attributes: PrimaryAttributes,
  relevantRank: number,
  modifiers?: readonly AuthorizedNumericModifier[],
): number {
  assertPrimaryAttributes(attributes);
  assertIntegerInRange(relevantRank, 0, 10, 'relevantRank');
  return clamp(0, 100, sumWithModifiers([
    2 * attributes.dexterity, attributes.perception, relevantRank,
  ], modifiers, 'accuracy'));
}

export function calculateEvasion(
  attributes: PrimaryAttributes,
  evasionRank: number,
  encumbrancePenalty: number,
  modifiers?: readonly AuthorizedNumericModifier[],
): number {
  assertPrimaryAttributes(attributes);
  assertIntegerInRange(evasionRank, 0, 10, 'evasionRank');
  assertIntegerInRange(encumbrancePenalty, 0, 100, 'encumbrancePenalty');
  return clamp(0, 100, sumWithModifiers([
    2 * attributes.agility, attributes.perception, evasionRank, -encumbrancePenalty,
  ], modifiers, 'evasion'));
}

export function calculateBaseAttackSpeedBps(attributes: PrimaryAttributes, modifiers?: readonly AuthorizedNumericModifier[]): number {
  assertPrimaryAttributes(attributes);
  return clamp(7500, 15000, sumWithModifiers([
    10000, 100 * (attributes.agility - 10), 50 * (attributes.dexterity - 10),
  ], modifiers, 'baseAttackSpeedBps'));
}

export function calculateBaseCastingSpeedBps(attributes: PrimaryAttributes, modifiers?: readonly AuthorizedNumericModifier[]): number {
  assertPrimaryAttributes(attributes);
  return clamp(7500, 15000, sumWithModifiers([
    10000, 100 * (attributes.intelligence - 10), 50 * (attributes.wisdom - 10),
    50 * (attributes.dexterity - 10),
  ], modifiers, 'baseCastingSpeedBps'));
}

export function calculateCriticalChanceBps(attributes: PrimaryAttributes, modifiers?: readonly AuthorizedNumericModifier[]): number {
  assertPrimaryAttributes(attributes);
  return clamp(100, 2500, sumWithModifiers([
    500, 25 * (attributes.dexterity - 10), 25 * (attributes.perception - 10),
    50 * (attributes.luck - 10),
  ], modifiers, 'criticalChanceBps'));
}

export function calculateCriticalDamageBps(attributes: PrimaryAttributes, modifiers?: readonly AuthorizedNumericModifier[]): number {
  assertPrimaryAttributes(attributes);
  return clamp(15000, 22000, sumWithModifiers([
    15000, 100 * Math.max(0, attributes.luck - 10),
    50 * Math.max(0, Math.max(attributes.strength, attributes.intelligence) - 10),
  ], modifiers, 'criticalDamageBps'));
}

export function calculateCriticalProfile(
  attributes: PrimaryAttributes,
  canCrit: boolean,
  chanceModifiers?: readonly AuthorizedNumericModifier[],
  damageModifiers?: readonly AuthorizedNumericModifier[],
) {
  return {
    canCrit,
    criticalChanceBps: canCrit ? calculateCriticalChanceBps(attributes, chanceModifiers) : 0,
    criticalDamageBps: calculateCriticalDamageBps(attributes, damageModifiers),
  } as const;
}

export function calculateMovementSpeed(
  attributes: PrimaryAttributes,
  encumbrancePenalty: number,
  modifiers?: readonly AuthorizedNumericModifier[],
): number {
  assertPrimaryAttributes(attributes);
  assertIntegerInRange(encumbrancePenalty, 0, 100, 'encumbrancePenalty');
  return clamp(2, 8, sumWithModifiers([
    4, Math.floor((attributes.agility - 10) / 5), -encumbrancePenalty,
  ], modifiers, 'movementSpeed'));
}

export function calculateCarryingCapacity(attributes: PrimaryAttributes, modifiers?: readonly AuthorizedNumericModifier[]): number {
  assertPrimaryAttributes(attributes);
  return clamp(100, 2000, sumWithModifiers([
    200, 20 * attributes.strength, 10 * attributes.vitality,
  ], modifiers, 'carryingCapacity'));
}

export function calculatePhysicalResistanceBps(attributes: PrimaryAttributes, modifiers?: readonly AuthorizedNumericModifier[]): number {
  assertPrimaryAttributes(attributes);
  return clamp(-5000, 4000, sumWithModifiers([
    20 * attributes.vitality, 10 * attributes.willpower,
  ], modifiers, 'physicalResistanceBps'));
}

export function calculateMagicalResistanceBps(attributes: PrimaryAttributes, modifiers?: readonly AuthorizedNumericModifier[]): number {
  assertPrimaryAttributes(attributes);
  return clamp(-5000, 4000, sumWithModifiers([
    20 * attributes.wisdom, 10 * attributes.willpower,
  ], modifiers, 'magicalResistanceBps'));
}

export function calculateElementalResistanceBps(attributes: PrimaryAttributes, modifiers?: readonly AuthorizedNumericModifier[]): number {
  assertPrimaryAttributes(attributes);
  return clamp(-5000, 7500, sumWithModifiers([
    10 * Math.max(0, attributes.wisdom + attributes.willpower - 20),
  ], modifiers, 'elementalResistanceBps'));
}

export function calculateHpRegen(attributes: PrimaryAttributes, modifiers?: readonly AuthorizedNumericModifier[]): number {
  assertPrimaryAttributes(attributes);
  return clamp(0, 20, sumWithModifiers([
    Math.floor(attributes.vitality / 5),
  ], modifiers, 'hpRegen'));
}

export function calculateManaRegen(attributes: PrimaryAttributes, modifiers?: readonly AuthorizedNumericModifier[]): number {
  assertPrimaryAttributes(attributes);
  return clamp(0, 20, sumWithModifiers([
    Math.floor((attributes.wisdom + attributes.willpower) / 10),
  ], modifiers, 'manaRegen'));
}

export function calculateSpRegen(attributes: PrimaryAttributes, modifiers?: readonly AuthorizedNumericModifier[]): number {
  assertPrimaryAttributes(attributes);
  return clamp(1, 20, sumWithModifiers([
    Math.max(1, Math.floor((attributes.vitality + attributes.willpower) / 8)),
  ], modifiers, 'spRegen'));
}

export function calculateSecondaryAttributes(input: SecondaryAttributeInput): SecondaryAttributes {
  const { attributes, modifiers = {} } = input;
  assertKnownKeys(modifiers, [
    'physicalPower', 'magicalPower', 'physicalFlatDefense', 'magicalFlatDefense', 'accuracy',
    'evasion', 'attackSpeedBps', 'castingSpeedBps', 'criticalChanceBps', 'criticalDamageBps',
    'movementSpeed', 'carryingCapacity', 'physicalResistanceBps', 'magicalResistanceBps',
    'elementalResistanceBps', 'hpRegen', 'manaRegen', 'spRegen',
  ], 'secondaryAttributeModifiers');
  assertInteger(input.encumbrancePenalty, 'encumbrancePenalty');
  return {
    actorPhysicalPower: calculateActorPhysicalPower(attributes, input.weaponFamilyRank, modifiers.physicalPower),
    actorMagicalPower: calculateActorMagicalPower(attributes, input.magicSchoolRank, modifiers.magicalPower),
    physicalDefense: calculatePhysicalDefense(attributes, modifiers.physicalFlatDefense),
    magicalDefense: calculateMagicalDefense(attributes, modifiers.magicalFlatDefense),
    accuracy: calculateAccuracy(attributes, input.accuracyRank, modifiers.accuracy),
    evasion: calculateEvasion(attributes, input.evasionRank, input.encumbrancePenalty, modifiers.evasion),
    baseAttackSpeedBps: calculateBaseAttackSpeedBps(attributes, modifiers.attackSpeedBps),
    baseCastingSpeedBps: calculateBaseCastingSpeedBps(attributes, modifiers.castingSpeedBps),
    criticalChanceBps: calculateCriticalChanceBps(attributes, modifiers.criticalChanceBps),
    criticalDamageBps: calculateCriticalDamageBps(attributes, modifiers.criticalDamageBps),
    movementSpeed: calculateMovementSpeed(attributes, input.encumbrancePenalty, modifiers.movementSpeed),
    carryingCapacity: calculateCarryingCapacity(attributes, modifiers.carryingCapacity),
    physicalResistanceBps: calculatePhysicalResistanceBps(attributes, modifiers.physicalResistanceBps),
    magicalResistanceBps: calculateMagicalResistanceBps(attributes, modifiers.magicalResistanceBps),
    elementalResistanceBps: calculateElementalResistanceBps(attributes, modifiers.elementalResistanceBps),
    hpRegen: calculateHpRegen(attributes, modifiers.hpRegen),
    manaRegen: calculateManaRegen(attributes, modifiers.manaRegen),
    spRegen: calculateSpRegen(attributes, modifiers.spRegen),
  };
}

export function calculateHitChanceBps(
  accuracy: number,
  evasion: number,
  situationalHitModifiersBps = 0,
): number {
  assertIntegerInRange(accuracy, 0, 100, 'accuracy');
  assertIntegerInRange(evasion, 0, 100, 'evasion');
  assertInteger(situationalHitModifiersBps, 'situationalHitModifiersBps');
  return clamp(1000, 9500, safeIntegerSum([
    7500, 75 * (accuracy - evasion), situationalHitModifiersBps,
  ], 'hitChanceBps'));
}

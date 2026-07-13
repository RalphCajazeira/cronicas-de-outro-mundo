import { describe, expect, it } from 'vitest';
import {
  CORE_V1_INITIAL_ATTRIBUTE_BUDGET,
  CORE_V1_PRIMARY_ATTRIBUTES,
  calculateCriticalProfile,
  calculateEffectiveAttribute,
  calculateEffectiveAttributes,
  calculateHitChanceBps,
  calculateResourceMaximums,
  calculateSecondaryAttributes,
  ceilDiv,
  clamp,
  getInitialAttributePreset,
  roundHalfUp,
  validateInitialPrimaryAttributes,
} from './index.js';
import type { AuthorizedNumericModifier, PrimaryAttributes } from './index.js';
import { CORE_V1_ATTRIBUTE_PRESETS } from './core-v1.config.js';

const modifier = (value: number): AuthorizedNumericModifier => ({
  source: { type: 'equipment', ref: 'test-equipment' }, value,
});

describe('core-v1 mathematical helpers', () => {
  it('clamps finite values and rejects invalid bounds or non-finite numbers', () => {
    expect(clamp(0, 10, -1)).toBe(0);
    expect(clamp(0, 10, 5)).toBe(5);
    expect(clamp(0, 10, 11)).toBe(10);
    expect(() => clamp(10, 0, 5)).toThrow('minimum must not exceed maximum');
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => clamp(0, 10, value)).toThrow('value must be finite');
      expect(() => roundHalfUp(value)).toThrow('value must be finite');
    }
    expect(() => clamp(0, 10, Number.MAX_VALUE)).toThrow('safe number range');
    expect(() => clamp(Number.MIN_SAFE_INTEGER - 1, 10, 0)).toThrow('safe number range');
  });

  it('rounds half away from zero and performs signed ceiling division', () => {
    expect(roundHalfUp(1.49)).toBe(1);
    expect(roundHalfUp(1.5)).toBe(2);
    expect(roundHalfUp(-1.49)).toBe(-1);
    expect(roundHalfUp(-1.5)).toBe(-2);
    expect(Object.is(roundHalfUp(-0), -0)).toBe(false);
    expect(ceilDiv(5, 2)).toBe(3);
    expect(ceilDiv(-5, 2)).toBe(-2);
    expect(ceilDiv(5, -2)).toBe(-2);
    expect(ceilDiv(-5, -2)).toBe(3);
    expect(roundHalfUp(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(roundHalfUp(Number.MIN_SAFE_INTEGER)).toBe(Number.MIN_SAFE_INTEGER);
    expect(() => ceilDiv(1, 0)).toThrow('divisor must not be zero');
    expect(() => ceilDiv(1.5, 1)).toThrow('dividend must be a safe integer');
    expect(() => ceilDiv(Number.MAX_SAFE_INTEGER + 1, 1)).toThrow('safe number range');
  });
});

describe('core-v1 initial primary attributes', () => {
  it('keeps internal mutable tables outside the public barrel', async () => {
    const publicApi: object = await import('./index.js');
    expect('CORE_V1_ATTRIBUTE_PRESETS' in publicApi).toBe(false);
    expect('CORE_V1_TIER_DAMAGE_ENVELOPES' in publicApi).toBe(false);
    expect('CORE_V1_NPC_RESOURCE_MULTIPLIERS' in publicApi).toBe(false);
    expect('assertInteger' in publicApi).toBe(false);
  });

  it('fixes the exact nine keys and the 90 point budget', () => {
    expect(CORE_V1_PRIMARY_ATTRIBUTES).toEqual([
      'strength', 'vitality', 'agility', 'dexterity', 'intelligence',
      'wisdom', 'perception', 'willpower', 'luck',
    ]);
    expect(CORE_V1_INITIAL_ATTRIBUTE_BUDGET).toBe(90);
    expect(Object.isFrozen(CORE_V1_PRIMARY_ATTRIBUTES)).toBe(true);
    expect(() => (CORE_V1_PRIMARY_ATTRIBUTES as unknown as string[]).push('courage')).toThrow(TypeError);
    expect(CORE_V1_PRIMARY_ATTRIBUTES).toHaveLength(9);
  });

  it.each(['balanced', 'physical', 'magical'] as const)('validates the %s preset', (preset) => {
    const attributes = getInitialAttributePreset(preset);
    expect(validateInitialPrimaryAttributes(attributes)).toEqual({ ok: true, value: attributes });
    expect(Object.values(attributes).reduce((total, value) => total + value, 0)).toBe(90);
    expect(attributes).not.toBe(CORE_V1_ATTRIBUTE_PRESETS[preset]);
  });

  it('returns defensive preset copies and keeps the global presets frozen', () => {
    const preset = getInitialAttributePreset('balanced');
    preset.strength = 16;
    expect(getInitialAttributePreset('balanced').strength).toBe(10);
    expect(Object.isFrozen(CORE_V1_ATTRIBUTE_PRESETS)).toBe(true);
    expect(Object.isFrozen(CORE_V1_ATTRIBUTE_PRESETS.balanced)).toBe(true);
    expect(() => {
      (CORE_V1_ATTRIBUTE_PRESETS.balanced as unknown as { strength: number }).strength = 16;
    }).toThrow(TypeError);
    expect(getInitialAttributePreset('balanced').strength).toBe(10);
    expect(() => getInitialAttributePreset('invalid' as never)).toThrow('preset is invalid');
  });

  it('rejects missing, unknown, non-integer and out-of-range attributes', () => {
    const base = getInitialAttributePreset('balanced');
    const missing: Partial<PrimaryAttributes> = { ...base };
    delete missing.luck;
    const missingResult = validateInitialPrimaryAttributes(missing);
    expect(missingResult.ok).toBe(false);
    if (!missingResult.ok) expect(missingResult.issues).toContainEqual(expect.objectContaining({ path: 'primaryAttributes.luck', rule: 'REQUIRED' }));

    const unknown = validateInitialPrimaryAttributes({ ...base, courage: 10 });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.issues).toContainEqual(expect.objectContaining({ path: 'primaryAttributes.courage', rule: 'UNKNOWN_ATTRIBUTE' }));

    for (const strength of [4.5, 3, 17]) {
      const result = validateInitialPrimaryAttributes({ ...base, strength });
      expect(result.ok).toBe(false);
    }
  });

  it('rejects allocations below and above the exact budget', () => {
    for (const strength of [9, 11]) {
      const result = validateInitialPrimaryAttributes({ ...getInitialAttributePreset('balanced'), strength });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues).toContainEqual(expect.objectContaining({ rule: 'INITIAL_ATTRIBUTE_BUDGET' }));
    }
  });

  it('rejects non-plain containers, non-finite values and secondary fields at runtime', () => {
    const base = getInitialAttributePreset('balanced');
    for (const input of [null, [], Object.assign(Object.create({ inherited: true }) as object, base)]) {
      const result = validateInitialPrimaryAttributes(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues[0]?.rule).toBe('PLAIN_OBJECT');
    }
    for (const strength of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const result = validateInitialPrimaryAttributes({ ...base, strength });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues).toContainEqual(expect.objectContaining({ rule: 'INTEGER' }));
    }
    const withSecondary = validateInitialPrimaryAttributes({ ...base, maxHp: 999 });
    expect(withSecondary.ok).toBe(false);
    if (!withSecondary.ok) {
      expect(withSecondary.issues).toContainEqual(expect.objectContaining({
        path: 'primaryAttributes.maxHp', rule: 'UNKNOWN_ATTRIBUTE',
      }));
    }
  });
});

describe('core-v1 resources and effective attributes', () => {
  it.each([
    ['balanced', { maxHp: 45, maxMana: 35, maxSp: 35 }],
    ['physical', { maxHp: 53, maxMana: 26, maxSp: 41 }],
    ['magical', { maxHp: 40, maxMana: 48, maxSp: 31 }],
  ] as const)('calculates the level 1 %s preset', (preset, expected) => {
    expect(calculateResourceMaximums(getInitialAttributePreset(preset), 1)).toEqual(expected);
  });

  it.each([
    ['balanced', 45, 35, 35], ['physical', 53, 26, 41], ['magical', 40, 48, 31],
  ] as const)('grows %s resources monotonically at representative levels', (preset, baseHp, baseMana, baseSp) => {
    for (const level of [1, 5, 9, 13, 19]) {
      const resources = calculateResourceMaximums(getInitialAttributePreset(preset), level);
      expect(resources).toEqual({
        maxHp: baseHp + 4 * (level - 1),
        maxMana: baseMana + 2 * (level - 1),
        maxSp: baseSp + 2 * (level - 1),
      });
    }
  });

  it('applies typed modifiers and resource caps', () => {
    expect(calculateEffectiveAttribute(29, [modifier(5)])).toBe(30);
    expect(calculateEffectiveAttribute(1, [modifier(-5)])).toBe(0);
    const effective = calculateEffectiveAttributes(getInitialAttributePreset('balanced'), {
      strength: [modifier(3)], intelligence: [modifier(-2)],
    });
    expect(effective).toMatchObject({ strength: 13, intelligence: 8, vitality: 10 });
    const capped = calculateResourceMaximums(getInitialAttributePreset('balanced'), 20, {
      maxHp: [modifier(5000)], maxMana: [modifier(-5000)], maxSp: [modifier(5000)],
    });
    expect(capped).toEqual({ maxHp: 999, maxMana: 0, maxSp: 999 });
  });

  it('rejects malformed modifier sources and invalid levels', () => {
    const unauthorized = { source: { type: 'gpt', ref: 'free-form' }, value: 1 } as unknown as AuthorizedNumericModifier;
    expect(() => calculateEffectiveAttribute(10, [unauthorized])).toThrow('source.type is not authorized');
    expect(() => calculateResourceMaximums(getInitialAttributePreset('balanced'), 0)).toThrow('level must be between 1 and 20');
    expect(() => calculateResourceMaximums(getInitialAttributePreset('balanced'), 1.5)).toThrow('level must be a safe integer');
  });

  it('rejects open modifier objects, unsafe totals and unknown modifier containers without mutation', () => {
    const valid = modifier(2);
    const modifiers = [valid] as const;
    expect(calculateEffectiveAttribute(10, modifiers)).toBe(12);
    expect(modifiers).toEqual([valid]);

    const extraModifier = {
      ...valid, note: 'freeform',
    } as unknown as AuthorizedNumericModifier;
    const extraSource = {
      source: { ...valid.source, suppliedBy: 'gpt' }, value: 1,
    } as unknown as AuthorizedNumericModifier;
    const fractional = modifier(1.5);
    expect(() => calculateEffectiveAttribute(10, [extraModifier])).toThrow('only source and value');
    expect(() => calculateEffectiveAttribute(10, [extraSource])).toThrow('only type and ref');
    expect(() => calculateEffectiveAttribute(10, [fractional])).toThrow('safe integer');
    expect(() => calculateEffectiveAttribute(10, [modifier(Number.MAX_SAFE_INTEGER)])).toThrow('effectiveAttribute');
    expect(() => calculateResourceMaximums(getInitialAttributePreset('balanced'), 1, {
      maxHp: [modifier(Number.MAX_SAFE_INTEGER)],
    })).toThrow('maxHp');
    expect(() => calculateEffectiveAttribute(10, {} as never)).toThrow('must be an array');
    expect(() => calculateResourceMaximums(getInitialAttributePreset('balanced'), 1, {
      maxHp: [], unexpected: [],
    } as never)).toThrow('resourceModifiers.unexpected is not supported');
  });
});

describe('core-v1 secondary attributes', () => {
  it.each([
    ['balanced', { actorPhysicalPower: 5, actorMagicalPower: 5, physicalDefense: 4, magicalDefense: 4, accuracy: 31, evasion: 31, baseAttackSpeedBps: 10000, baseCastingSpeedBps: 10000, criticalChanceBps: 500, criticalDamageBps: 15000, movementSpeed: 4, carryingCapacity: 500, physicalResistanceBps: 300, magicalResistanceBps: 300, elementalResistanceBps: 0, hpRegen: 2, manaRegen: 2, spRegen: 2 }],
    ['physical', { actorPhysicalPower: 7, actorMagicalPower: 3, physicalDefense: 5, magicalDefense: 3, accuracy: 39, evasion: 35, baseAttackSpeedBps: 10400, baseCastingSpeedBps: 9600, criticalChanceBps: 350, criticalDamageBps: 15250, movementSpeed: 4, carryingCapacity: 630, physicalResistanceBps: 350, magicalResistanceBps: 210, elementalResistanceBps: 0, hpRegen: 2, manaRegen: 1, spRegen: 2 }],
    ['magical', { actorPhysicalPower: 3, actorMagicalPower: 7, physicalDefense: 2, magicalDefense: 5, accuracy: 31, evasion: 25, baseAttackSpeedBps: 9700, baseCastingSpeedBps: 10850, criticalChanceBps: 300, criticalDamageBps: 15300, movementSpeed: 3, carryingCapacity: 390, physicalResistanceBps: 300, magicalResistanceBps: 420, elementalResistanceBps: 70, hpRegen: 1, manaRegen: 2, spRegen: 2 }],
  ] as const)('calculates the %s snapshot', (preset, expected) => {
    expect(calculateSecondaryAttributes({
      attributes: getInitialAttributePreset(preset), weaponFamilyRank: 1, magicSchoolRank: 1,
      accuracyRank: 1, evasionRank: 1, encumbrancePenalty: 0,
    })).toEqual(expected);
  });

  it('applies modifiers without changing input attributes and clamps secondary values', () => {
    const attributes = getInitialAttributePreset('balanced');
    const before = { ...attributes };
    const result = calculateSecondaryAttributes({
      attributes, weaponFamilyRank: 10, magicSchoolRank: 10, accuracyRank: 10, evasionRank: 10,
      encumbrancePenalty: 0,
      modifiers: {
        accuracy: [modifier(500)], evasion: [modifier(-500)], attackSpeedBps: [modifier(10000)],
        physicalResistanceBps: [modifier(-10000)], elementalResistanceBps: [modifier(10000)],
      },
    });
    expect(result).toMatchObject({ accuracy: 100, evasion: 0, baseAttackSpeedBps: 15000, physicalResistanceBps: -5000, elementalResistanceBps: 7500 });
    expect(attributes).toEqual(before);
  });

  it('preserves relevant monotonic relationships', () => {
    const base = getInitialAttributePreset('balanced');
    const stronger: PrimaryAttributes = { ...base, strength: 11 };
    const common = { weaponFamilyRank: 1, magicSchoolRank: 1, accuracyRank: 1, evasionRank: 1, encumbrancePenalty: 0 };
    const baseSecondary = calculateSecondaryAttributes({ attributes: base, ...common });
    const strongerSecondary = calculateSecondaryAttributes({ attributes: stronger, ...common });
    expect(strongerSecondary.actorPhysicalPower).toBeGreaterThanOrEqual(baseSecondary.actorPhysicalPower);
    expect(strongerSecondary.carryingCapacity).toBeGreaterThan(baseSecondary.carryingCapacity);
    expect(calculateResourceMaximums(stronger, 1).maxHp).toBeGreaterThanOrEqual(calculateResourceMaximums(base, 1).maxHp);
  });
});

describe('core-v1 accuracy and critical profile', () => {
  it.each([
    [-30, 5250], [-20, 6000], [-15, 6375], [-10, 6750], [-5, 7125], [0, 7500],
    [5, 7875], [10, 8250], [15, 8625], [20, 9000], [30, 9500],
  ])('maps score difference %i to %i BPS', (difference, expected) => {
    const accuracy = difference >= 0 ? 50 + difference : 50;
    const evasion = difference >= 0 ? 50 : 50 - difference;
    expect(calculateHitChanceBps(accuracy, evasion)).toBe(expected);
  });

  it('clamps hit chance and applies situational modifiers', () => {
    expect(calculateHitChanceBps(0, 100)).toBe(1000);
    expect(calculateHitChanceBps(100, 0)).toBe(9500);
    expect(calculateHitChanceBps(50, 50, -500)).toBe(7000);
    expect(() => calculateHitChanceBps(100, 0, Number.MAX_SAFE_INTEGER)).toThrow('hitChanceBps');
  });

  it.each([
    [4, 200, 15000], [10, 500, 15000], [16, 800, 15600], [20, 1000, 16000], [30, 1500, 17000],
  ])('calculates critical values for Luck %i', (luck, chance, damage) => {
    const attributes: PrimaryAttributes = { ...getInitialAttributePreset('balanced'), luck };
    expect(calculateCriticalProfile(attributes, true)).toEqual({ canCrit: true, criticalChanceBps: chance, criticalDamageBps: damage });
    expect(calculateCriticalProfile(attributes, false)).toEqual({ canCrit: false, criticalChanceBps: 0, criticalDamageBps: damage });
  });

  it('clamps authorized critical modifiers', () => {
    const attributes = getInitialAttributePreset('balanced');
    expect(calculateCriticalProfile(attributes, true, [modifier(10000)], [modifier(10000)]))
      .toEqual({ canCrit: true, criticalChanceBps: 2500, criticalDamageBps: 22000 });
  });
});

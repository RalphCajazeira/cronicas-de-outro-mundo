import { describe, expect, it } from 'vitest';
import {
  addDamageEffect,
  basicPhysicalRaw,
  createRawDamageComponent,
  mitigateDamage,
  spellRaw,
  weaponSkillRaw,
} from './index.js';
import type { DamageMitigationInput, RawDamageComponent } from './index.js';

const defenses = {
  physicalFlatDefense: 4,
  magicalFlatDefense: 3,
  blockValue: 0,
  completeBlock: false,
  resistances: { physicalResistanceBps: 270, magicalResistanceBps: 270, elementalResistanceBps: { fire: 0 } },
} as const;

function mitigate(components: readonly RawDamageComponent[], overrides: Partial<DamageMitigationInput> = {}) {
  return mitigateDamage({
    actionHit: true,
    components,
    critical: false,
    criticalDamageBps: 15000,
    ...defenses,
    ...overrides,
  });
}

describe('core-v1 raw damage without double counting', () => {
  it('applies weapon, spell and skill bases exactly once', () => {
    expect(basicPhysicalRaw(4, 5)).toBe(9);
    expect(weaponSkillRaw(4, 4, 7, 'full')).toBe(15);
    expect(spellRaw(8, 7, 'full', 0)).toBe(15);
    expect(spellRaw(8, 7, 'half', 3, 2)).toBe(14);
    expect(() => basicPhysicalRaw(Number.MAX_SAFE_INTEGER, 1)).toThrow('basicPhysicalRaw');
  });

  it('adds an add_damage effect as a separate component', () => {
    const weapon: RawDamageComponent = { id: 'dagger', channel: 'physical', element: null, amount: 9, canCrit: true };
    const result = addDamageEffect([weapon], {
      id: 'flame-blade', channel: 'magical', element: 'fire', baseDamage: 3, scaling: 'half', canCrit: true,
    }, 5);
    expect(result).toEqual([
      weapon,
      { id: 'flame-blade', channel: 'magical', element: 'fire', amount: 5, canCrit: true },
    ]);
  });

  it('creates closed raw components from a definition', () => {
    expect(createRawDamageComponent({
      id: 'arcane-rider', channel: 'magical', element: 'arcane', baseDamage: 4, scaling: 'none', canCrit: false,
    }, 100, 1)).toEqual({ id: 'arcane-rider', channel: 'magical', element: 'arcane', amount: 5, canCrit: false });
  });
});

describe('core-v1 damage mitigation', () => {
  it('resolves the approved dagger plus Flame Blade example', () => {
    const result = mitigate([
      { id: 'dagger', channel: 'physical', element: null, amount: 9, canCrit: true },
      { id: 'flame', channel: 'magical', element: 'fire', amount: 5, canCrit: true },
    ]);
    expect(result.totalDamage).toBe(7);
    expect(result.components.map((component) => component.finalDamage)).toEqual([5, 2]);
  });

  it('resolves Fireball and Whirlwind as independent approved examples', () => {
    const fireball = mitigate([{ id: 'fireball', channel: 'magical', element: 'fire', amount: spellRaw(8, 7, 'full', 0), canCrit: true }]);
    const whirlwind = mitigate([{ id: 'whirlwind', channel: 'physical', element: null, amount: weaponSkillRaw(4, 4, 7, 'full'), canCrit: true }]);
    expect(fireball.totalDamage).toBe(12);
    expect(whirlwind.totalDamage).toBe(11);
  });

  it('applies flat defense only once per channel and redistributes by largest remainder', () => {
    const result = mitigate([
      { id: 'a', channel: 'physical', element: null, amount: 5, canCrit: false },
      { id: 'b', channel: 'physical', element: null, amount: 3, canCrit: false },
      { id: 'c', channel: 'physical', element: null, amount: 2, canCrit: false },
    ], {
      physicalFlatDefense: 3,
      magicalFlatDefense: 0,
      resistances: { physicalResistanceBps: 0, magicalResistanceBps: 0 },
    });
    expect(result.components.map((component) => component.afterFlatDefense)).toEqual([4, 2, 1]);
    expect(result.totalDamage).toBe(7);
  });

  it('allows six components, rejects seven and never creates a minimum per component', () => {
    const six = Array.from({ length: 6 }, (_, index): RawDamageComponent => ({
      id: `small-${index}`, channel: 'physical', element: null, amount: 1, canCrit: false,
    }));
    const result = mitigate(six, {
      physicalFlatDefense: 4,
      magicalFlatDefense: 0,
      resistances: { physicalResistanceBps: 0, magicalResistanceBps: 0 },
    });
    expect(result.totalDamage).toBe(2);
    expect(result.components.filter((component) => component.finalDamage === 0)).toHaveLength(4);
    expect(() => mitigate([...six, { id: 'seventh', channel: 'physical', element: null, amount: 1, canCrit: false }])).toThrow('at most 6 components');
  });

  it('applies the minimum only to a hit total reduced to zero', () => {
    const component: RawDamageComponent = { id: 'weak', channel: 'physical', element: null, amount: 2, canCrit: false };
    const reduced = mitigate([component], { physicalFlatDefense: 100, magicalFlatDefense: 0 });
    expect(reduced).toMatchObject({ totalDamage: 1, appliedMinimumDamage: true });
    expect(reduced.components[0]?.finalDamage).toBe(0);
    expect(mitigate([component], { actionHit: false }).totalDamage).toBe(0);
  });

  it('returns zero for complete immunity and complete block', () => {
    const component: RawDamageComponent = { id: 'fire', channel: 'magical', element: 'fire', amount: 20, canCrit: true };
    expect(mitigate([component], { immunities: { elements: ['fire'] } })).toMatchObject({ totalDamage: 0, appliedMinimumDamage: false });
    expect(mitigate([component], { completeBlock: true })).toMatchObject({ totalDamage: 0, completeBlock: true, appliedMinimumDamage: false });
  });

  it('treats an authorized block value that absorbs all remaining damage as complete', () => {
    const component: RawDamageComponent = { id: 'blocked', channel: 'physical', element: null, amount: 10, canCrit: false };
    expect(mitigate([component], {
      physicalFlatDefense: 0,
      magicalFlatDefense: 0,
      blockValue: 10,
      resistances: { physicalResistanceBps: 0, magicalResistanceBps: 0 },
    })).toMatchObject({ totalDamage: 0, completeBlock: true, appliedMinimumDamage: false });
  });

  it('applies an authorized partial block once across the action', () => {
    const result = mitigate([
      { id: 'physical', channel: 'physical', element: null, amount: 10, canCrit: false },
      { id: 'magical', channel: 'magical', element: null, amount: 10, canCrit: false },
    ], {
      physicalFlatDefense: 0,
      magicalFlatDefense: 0,
      blockValue: 5,
      resistances: { physicalResistanceBps: 0, magicalResistanceBps: 0 },
    });
    expect(result.components.map((component) => component.afterBlock)).toEqual([8, 7]);
    expect(result.totalDamage).toBe(15);
  });

  it('supports resistance and vulnerability with approved rounding', () => {
    const component: RawDamageComponent = { id: 'physical', channel: 'physical', element: null, amount: 10, canCrit: false };
    const resistant = mitigate([component], {
      physicalFlatDefense: 0, magicalFlatDefense: 0,
      resistances: { physicalResistanceBps: 2500, magicalResistanceBps: 0 },
    });
    const vulnerable = mitigate([component], {
      physicalFlatDefense: 0, magicalFlatDefense: 0,
      resistances: { physicalResistanceBps: -5000, magicalResistanceBps: 0 },
    });
    expect(resistant.totalDamage).toBe(8);
    expect(vulnerable.totalDamage).toBe(15);
    expect(() => mitigate([component], {
      resistances: { physicalResistanceBps: 10000, magicalResistanceBps: 0 },
    })).toThrow('physicalResistanceBps must be between -5000 and 4000');
  });

  it('applies critical only to eligible components', () => {
    const result = mitigate([
      { id: 'eligible', channel: 'physical', element: null, amount: 10, canCrit: true },
      { id: 'fixed', channel: 'magical', element: null, amount: 10, canCrit: false },
    ], {
      critical: true,
      criticalDamageBps: 15000,
      physicalFlatDefense: 0,
      magicalFlatDefense: 0,
      resistances: { physicalResistanceBps: 0, magicalResistanceBps: 0 },
    });
    expect(result.components.map((component) => component.afterCritical)).toEqual([15, 10]);
    expect(result.totalDamage).toBe(25);
  });

  it('is deterministic for the same input', () => {
    const input = [
      { id: 'one', channel: 'physical', element: null, amount: 7, canCrit: true },
      { id: 'two', channel: 'magical', element: 'fire', amount: 5, canCrit: true },
    ] as const;
    expect(mitigate(input, { critical: true, blockValue: 2 })).toEqual(mitigate(input, { critical: true, blockValue: 2 }));
  });

  it('preserves component order and never mutates input data', () => {
    const components = Object.freeze([
      Object.freeze({ id: 'third', channel: 'physical', element: null, amount: 7, canCrit: true }),
      Object.freeze({ id: 'first', channel: 'magical', element: 'fire', amount: 5, canCrit: false }),
      Object.freeze({ id: 'second', channel: 'physical', element: null, amount: 3, canCrit: false }),
    ] as const);
    const input = Object.freeze({
      actionHit: true,
      components,
      critical: true,
      criticalDamageBps: 15000,
      physicalFlatDefense: 2,
      magicalFlatDefense: 1,
      blockValue: 1,
      completeBlock: false,
      resistances: Object.freeze({ physicalResistanceBps: 0, magicalResistanceBps: 0 }),
    });
    const before = JSON.stringify(input);
    const result = mitigateDamage(input);
    expect(result.components.map((component) => component.id)).toEqual(['third', 'first', 'second']);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('rejects open or malformed damage components and resistance metadata', () => {
    const valid = { id: 'valid', channel: 'physical', element: null, amount: 5, canCrit: true } as const;
    expect(() => mitigate([{ ...valid, finalDamage: 999 } as never])).toThrow('invalid fields');
    expect(() => mitigate([{ ...valid, canCrit: 1 } as never])).toThrow('canCrit must be boolean');
    expect(() => createRawDamageComponent({
      id: 'invalid', channel: 'physical', element: null, baseDamage: 4, scaling: 'full', canCrit: true,
      extra: true,
    } as never, 5)).toThrow('invalid fields');
    expect(() => mitigate([valid], {
      resistances: { physicalResistanceBps: 0, magicalResistanceBps: 0, elementalResistanceBps: { fire: 10000 } },
    })).toThrow('elementalResistanceBps.fire must be between -5000 and 7500');
    expect(() => mitigate([valid], { immunities: { elements: ['Not Valid'] } })).toThrow('valid element codes');
    expect(() => mitigate([valid], { immunities: { physical: true, suppliedBy: 'gpt' } as never })).toThrow('invalid fields');
    const unsafeCriticalAmount = Math.floor(Number.MAX_SAFE_INTEGER / 15000) + 1;
    expect(() => mitigate([{
      id: 'unsafe-critical', channel: 'physical', element: null, amount: unsafeCriticalAmount, canCrit: true,
    }], {
      critical: true,
      physicalFlatDefense: 0,
      magicalFlatDefense: 0,
      resistances: { physicalResistanceBps: 0, magicalResistanceBps: 0 },
    })).toThrow('critical damage product');
  });

  it('maintains mitigation monotonicity and non-negative deterministic totals', () => {
    const resistances = [-5000, 0, 1000, 2500, 4000] as const;
    for (let amount = 1; amount <= 15; amount += 1) {
      const component: RawDamageComponent = { id: 'property', channel: 'physical', element: null, amount, canCrit: false };
      let previousByDefense = Number.POSITIVE_INFINITY;
      for (let defense = 0; defense <= 10; defense += 1) {
        const result = mitigate([component], {
          physicalFlatDefense: defense,
          magicalFlatDefense: 0,
          resistances: { physicalResistanceBps: 0, magicalResistanceBps: 0 },
        });
        expect(result.totalDamage).toBeGreaterThanOrEqual(0);
        expect(result.totalDamage).toBeLessThanOrEqual(previousByDefense);
        previousByDefense = result.totalDamage;
      }

      let previousByResistance = Number.POSITIVE_INFINITY;
      for (const resistance of resistances) {
        const result = mitigate([component], {
          physicalFlatDefense: 0,
          magicalFlatDefense: 0,
          resistances: { physicalResistanceBps: resistance, magicalResistanceBps: 0 },
        });
        expect(result.totalDamage).toBeGreaterThanOrEqual(0);
        expect(result.totalDamage).toBeLessThanOrEqual(previousByResistance);
        previousByResistance = result.totalDamage;
      }
    }
  });

  it('conserves channel and action totals through largest-remainder redistribution', () => {
    for (let first = 0; first <= 8; first += 1) {
      for (let second = 0; second <= 8; second += 1) {
        const components: RawDamageComponent[] = [
          { id: 'first', channel: 'physical', element: null, amount: first, canCrit: false },
          { id: 'second', channel: 'physical', element: null, amount: second, canCrit: false },
        ];
        const sourceTotal = first + second;
        const defense = Math.min(3, sourceTotal);
        const afterDefenseTotal = Math.max(0, sourceTotal - defense);
        const block = Math.min(2, Math.max(0, afterDefenseTotal - 1));
        const result = mitigate(components, {
          physicalFlatDefense: defense,
          magicalFlatDefense: 0,
          blockValue: block,
          resistances: { physicalResistanceBps: 0, magicalResistanceBps: 0 },
        });
        expect(result.components.reduce((total, component) => total + component.afterFlatDefense, 0)).toBe(afterDefenseTotal);
        expect(result.components.reduce((total, component) => total + component.afterBlock, 0)).toBe(afterDefenseTotal - block);
      }
    }
  });
});

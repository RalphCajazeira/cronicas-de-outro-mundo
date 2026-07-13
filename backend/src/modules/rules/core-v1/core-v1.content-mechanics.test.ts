import { describe, expect, it } from 'vitest';
import {
  CORE_V1_CONTENT_RULESET_CODE,
  CORE_V1_CONTENT_SCHEMA_VERSION,
  getCoreV1ContentElements,
  getCoreV1ContentKinds,
  getCoreV1RarityAdditionalPropertyLimits,
  validateCoreV1ContentProfile,
} from './index.js';
import type {
  CoreV1ContentProfile,
  CoreV1ContentValidationResult,
  ValidationIssue,
} from './index.js';

const singleTarget = { type: 'single_target', rangeBand: 'engaged', maxTargets: 1 } as const;
const selfTarget = { type: 'self', rangeBand: 'self' } as const;
const noneCost = { type: 'none' } as const;
const passiveActivation = { type: 'passive' } as const;

const dagger = {
  schemaVersion: 1,
  rulesetCode: 'core-v1',
  profileMode: 'mechanical',
  contentKind: 'weapon',
  code: 'dagger',
  name: 'Adaga',
  tier: 1,
  rarity: 'common',
  activation: { type: 'active' },
  cost: noneCost,
  actionProfile: 'quick',
  targeting: singleTarget,
  damageComponents: [
    { id: 'dagger-physical', channel: 'physical', element: null, baseDamage: 4, scaling: 'full', canCrit: true },
  ],
  handedness: 'one_handed',
  weaponTags: ['dagger'],
} as const satisfies CoreV1ContentProfile;

const flameBlade = {
  schemaVersion: 1,
  rulesetCode: 'core-v1',
  profileMode: 'mechanical',
  contentKind: 'spell',
  code: 'flame_blade',
  name: 'Lâmina Flamejante',
  tier: 1,
  rarity: 'common',
  activation: { type: 'active' },
  cost: { type: 'mana', amount: 4 },
  actionProfile: 'quick',
  effects: [{
    type: 'add_damage',
    targeting: { type: 'weapon_attack', rangeBand: 'engaged' },
    damageComponents: [
      { id: 'flame-blade-fire', channel: 'magical', element: 'fire', baseDamage: 3, scaling: 'half', canCrit: true },
    ],
  }],
} as const satisfies CoreV1ContentProfile;

const fireball = {
  schemaVersion: 1,
  rulesetCode: 'core-v1',
  profileMode: 'mechanical',
  contentKind: 'spell',
  code: 'fireball',
  name: 'Bola de Fogo',
  tier: 1,
  rarity: 'common',
  activation: { type: 'active' },
  cost: { type: 'mana', amount: 8 },
  actionProfile: 'normal',
  effects: [{
    type: 'damage',
    targeting: { type: 'single_target', rangeBand: 'medium', maxTargets: 1 },
    damageComponents: [
      { id: 'fireball-fire', channel: 'magical', element: 'fire', baseDamage: 8, scaling: 'full', canCrit: true },
    ],
  }],
} as const satisfies CoreV1ContentProfile;

const whirlwind = {
  schemaVersion: 1,
  rulesetCode: 'core-v1',
  profileMode: 'mechanical',
  contentKind: 'skill',
  code: 'whirlwind',
  name: 'Golpe Giratório',
  tier: 1,
  rarity: 'common',
  activation: { type: 'active' },
  cost: { type: 'sp', amount: 6 },
  actionProfile: 'whirlwind',
  effects: [{
    type: 'damage',
    targeting: {
      type: 'multi_target',
      rangeBand: 'engaged',
      maxTargets: 3,
      damageMultiplierPerTargetBps: [6000, 4500, 4500],
    },
    damageComponents: [
      { id: 'whirlwind-physical', channel: 'physical', element: null, baseDamage: 6, scaling: 'full', canCrit: true },
    ],
  }],
} as const satisfies CoreV1ContentProfile;

const healingPotion = {
  schemaVersion: 1,
  rulesetCode: 'core-v1',
  profileMode: 'mechanical',
  contentKind: 'consumable',
  code: 'healing_potion',
  name: 'Poção de Cura',
  tier: 1,
  rarity: 'common',
  activation: { type: 'active' },
  cost: noneCost,
  actionProfile: 'normal',
  consumable: true,
  effects: [{ type: 'restore_resource', resource: 'hp', amount: 30, targeting: selfTarget }],
} as const satisfies CoreV1ContentProfile;

const manaPotion = {
  ...healingPotion,
  code: 'mana_potion',
  name: 'Poção de Mana',
  effects: [{ type: 'restore_resource', resource: 'mana', amount: 20, targeting: selfTarget }],
} as const satisfies CoreV1ContentProfile;

const spPotion = {
  ...healingPotion,
  code: 'sp_potion',
  name: 'Poção de SP',
  effects: [{ type: 'restore_resource', resource: 'sp', amount: 20, targeting: selfTarget }],
} as const satisfies CoreV1ContentProfile;

const physicalArmor = {
  schemaVersion: 1,
  rulesetCode: 'core-v1',
  profileMode: 'mechanical',
  contentKind: 'armor',
  code: 'physical_armor',
  name: 'Armadura Física',
  tier: 1,
  rarity: 'common',
  activation: passiveActivation,
  cost: noneCost,
  defense: { physicalFlatDefense: 5 },
  equipmentSlots: ['chest'],
} as const satisfies CoreV1ContentProfile;

const hybridArmor = {
  ...physicalArmor,
  code: 'hybrid_armor',
  name: 'Armadura Híbrida',
  rarity: 'uncommon',
  defense: { physicalFlatDefense: 4, magicalFlatDefense: 3 },
} as const satisfies CoreV1ContentProfile;

const shield = {
  schemaVersion: 1,
  rulesetCode: 'core-v1',
  profileMode: 'mechanical',
  contentKind: 'shield',
  code: 'round_shield',
  name: 'Escudo',
  tier: 1,
  rarity: 'uncommon',
  activation: passiveActivation,
  cost: noneCost,
  defense: { blockValue: 4 },
  equipmentSlots: ['off_hand'],
  effects: [{ type: 'grant_reaction', reactionKind: 'block', reactionDepth: 1 }],
} as const satisfies CoreV1ContentProfile;

const narrativeClothing = {
  schemaVersion: 1,
  rulesetCode: 'core-v1',
  profileMode: 'narrative',
  contentKind: 'clothing',
  code: 'traveler_clothes',
  name: 'Roupa de Viajante',
  description: 'Roupa simples para longas jornadas.',
  lore: 'Costurada por artesãos da estrada.',
  tags: ['traveler'],
  presentation: { appearance: 'Tecido resistente e sem proteção mecânica.' },
} as const satisfies CoreV1ContentProfile;

const passiveTalent = {
  schemaVersion: 1,
  rulesetCode: 'core-v1',
  profileMode: 'mechanical',
  contentKind: 'talent',
  code: 'keen_eye',
  name: 'Olhar Aguçado',
  tier: 1,
  rarity: 'common',
  activation: passiveActivation,
  cost: noneCost,
  passiveModifiers: [{ target: 'accuracy', amount: 2, sourceRule: 'content_intrinsic' }],
} as const satisfies CoreV1ContentProfile;

const condition = {
  schemaVersion: 1,
  rulesetCode: 'core-v1',
  profileMode: 'mechanical',
  contentKind: 'status_effect',
  code: 'slowed',
  name: 'Lentidão',
  tier: 1,
  rarity: 'common',
  activation: passiveActivation,
  cost: noneCost,
  duration: { type: 'actions', value: 3 },
  stacking: { type: 'refresh' },
  passiveModifiers: [{ target: 'attackSpeedBps', amount: -500, sourceRule: 'status_effect' }],
} as const satisfies CoreV1ContentProfile;

const mechanicalItem = {
  schemaVersion: 1,
  rulesetCode: 'core-v1',
  profileMode: 'mechanical',
  contentKind: 'item',
  code: 'load_belt',
  name: 'Cinto de Carga',
  tier: 1,
  rarity: 'common',
  activation: passiveActivation,
  cost: noneCost,
  passiveModifiers: [{ target: 'carryingCapacity', amount: 20, sourceRule: 'equipped_content' }],
} as const satisfies CoreV1ContentProfile;

const mechanicalRace = {
  schemaVersion: 1,
  rulesetCode: 'core-v1',
  profileMode: 'mechanical',
  contentKind: 'race',
  code: 'stonekin',
  name: 'Povo da Pedra',
  tier: 1,
  rarity: 'common',
  activation: passiveActivation,
  cost: noneCost,
  passiveModifiers: [{ target: 'vitality', amount: 1, sourceRule: 'content_intrinsic' }],
} as const satisfies CoreV1ContentProfile;

const mechanicalClass = {
  schemaVersion: 1,
  rulesetCode: 'core-v1',
  profileMode: 'mechanical',
  contentKind: 'class',
  code: 'guardian',
  name: 'Guardião',
  tier: 1,
  rarity: 'common',
  activation: passiveActivation,
  cost: noneCost,
  grants: [{ contentKind: 'skill', code: 'shield_bash' }],
} as const satisfies CoreV1ContentProfile;

const creatureTemplate = {
  schemaVersion: 1,
  rulesetCode: 'core-v1',
  profileMode: 'mechanical',
  contentKind: 'creature_template',
  code: 'standard_wolf',
  name: 'Lobo Padrão',
  tier: 1,
  rarity: 'common',
  activation: passiveActivation,
  cost: noneCost,
  template: {
    role: 'standard',
    primaryAttributeBudget: 81,
    contentRefs: [{ contentKind: 'skill', code: 'bite' }],
    tags: ['beast', 'wolf'],
    limits: { maxContentRefs: 4, maxActiveAbilities: 2 },
  },
} as const satisfies CoreV1ContentProfile;

const mandatoryFixtures = [
  dagger, flameBlade, fireball, whirlwind, healingPotion, manaPotion, spPotion,
  physicalArmor, hybridArmor, shield, narrativeClothing, passiveTalent, condition,
] as const;

const allKindFixtures = [
  dagger, physicalArmor, shield, narrativeClothing, fireball, whirlwind, passiveTalent,
  mechanicalItem, healingPotion, condition, mechanicalRace, mechanicalClass, creatureTemplate,
] as const;

function expectValid(input: unknown): CoreV1ContentProfile {
  const result = validateCoreV1ContentProfile(input);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function expectInvalid(input: unknown): readonly ValidationIssue[] {
  const result = validateCoreV1ContentProfile(input);
  expect(result).toMatchObject({ ok: false, code: 'INVALID_CORE_V1_CONTENT_PROFILE', retryable: true });
  if (result.ok) throw new Error('Expected invalid content profile');
  return result.issues;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function activeSkill(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    rulesetCode: 'core-v1',
    profileMode: 'mechanical',
    contentKind: 'skill',
    code: 'test_skill',
    name: 'Test Skill',
    tier: 1,
    rarity: 'common',
    activation: { type: 'active' },
    cost: { type: 'sp', amount: 3 },
    actionProfile: 'normal',
    effects: [{ type: 'movement', from: 'near', to: 'engaged', maximumTransitions: 1 }],
    ...overrides,
  };
}

describe('core-v1 canonical content fixtures', () => {
  it.each(mandatoryFixtures)('accepts mandatory fixture $code', (fixture) => {
    expect(expectValid(fixture)).toEqual(fixture);
  });

  it('covers every canonical content kind', () => {
    for (const fixture of allKindFixtures) expectValid(fixture);
    expect(new Set(allKindFixtures.map((fixture) => fixture.contentKind)))
      .toEqual(new Set(getCoreV1ContentKinds()));
  });

  it('keeps the required identity fixed', () => {
    expect(CORE_V1_CONTENT_SCHEMA_VERSION).toBe(1);
    expect(CORE_V1_CONTENT_RULESET_CODE).toBe('core-v1');
    expectInvalid({ ...dagger, schemaVersion: 2 });
    expectInvalid({ ...dagger, rulesetCode: 'core-v2' });
  });
});

describe('core-v1 narrative and mechanical modes', () => {
  it('accepts narrative presentation and rejects every mechanical field', () => {
    expectValid(narrativeClothing);
    for (const [field, value] of [
      ['tier', 1], ['defense', { physicalFlatDefense: 1 }], ['effects', []],
      ['cost', noneCost], ['passiveModifiers', []],
    ] as const) {
      const issues = expectInvalid({ ...narrativeClothing, [field]: value });
      expect(issues).toContainEqual(expect.objectContaining({ path: field, rule: 'UNKNOWN_FIELD' }));
    }
  });

  it('rejects empty mechanics, unsupported tier and rarity', () => {
    const empty = {
      schemaVersion: 1, rulesetCode: 'core-v1', profileMode: 'mechanical', contentKind: 'item',
      code: 'empty', name: 'Empty', tier: 1, rarity: 'common', activation: passiveActivation, cost: noneCost,
    };
    expect(expectInvalid(empty)).toContainEqual(expect.objectContaining({ rule: 'EMPTY_MECHANICAL_PROFILE' }));
    for (const tier of [0, 11]) expect(expectInvalid({ ...mechanicalItem, tier })).toContainEqual(expect.objectContaining({ path: 'tier' }));
    expect(expectInvalid({ ...mechanicalItem, rarity: 'artifact' })).toContainEqual(expect.objectContaining({ path: 'rarity' }));
    expect(expectInvalid({ ...hybridArmor, rarity: 'common' })).toContainEqual(expect.objectContaining({ rule: 'RARITY_PROPERTY_LIMIT' }));
  });
});

describe('core-v1 damage and elements', () => {
  it('accepts physical, magical and hybrid damage in the tier envelope', () => {
    expectValid(dagger);
    expectValid(fireball);
    expectValid(activeSkill({
      code: 'hybrid_strike',
      effects: [{
        type: 'damage', targeting: singleTarget,
        damageComponents: [
          { id: 'hybrid-physical', channel: 'physical', element: null, baseDamage: 3, scaling: 'full', canCrit: true },
          { id: 'hybrid-arcane', channel: 'magical', element: 'arcane', baseDamage: 3, scaling: 'half', canCrit: true },
        ],
      }],
    }));
  });

  it('uses a closed element catalog and keeps channels distinct from elements', () => {
    expect(getCoreV1ContentElements()).toEqual([
      'fire', 'ice', 'lightning', 'earth', 'wind', 'water', 'light', 'shadow', 'poison', 'arcane',
    ]);
    const unknown = clone(fireball) as unknown as { effects: Array<{ damageComponents: Array<{ element: string }> }> };
    unknown.effects[0]!.damageComponents[0]!.element = 'void';
    expect(expectInvalid(unknown)).toContainEqual(expect.objectContaining({ path: 'effects.0.damageComponents.0.element' }));
    const physicalElement = clone(dagger) as unknown as { damageComponents: Array<{ element: string | null }> };
    physicalElement.damageComponents[0]!.element = 'fire';
    expect(expectInvalid(physicalElement)).toContainEqual(expect.objectContaining({ rule: 'PHYSICAL_ELEMENT' }));
  });

  it('rejects damage outside the tier budget and seven components', () => {
    expect(expectInvalid({
      ...dagger,
      damageComponents: Array.from({ length: 7 }, (_, index) => ({
        id: `part-${index}`, channel: 'physical', element: null, baseDamage: 1, scaling: 'none', canCrit: false,
      })),
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: 'ARRAY_LENGTH' }),
      expect.objectContaining({ rule: 'MAX_DAMAGE_COMPONENTS' }),
    ]));
    expect(expectInvalid({
      ...dagger,
      damageComponents: [{ id: 'too-strong', channel: 'physical', element: null, baseDamage: 11, scaling: 'full', canCrit: true }],
    })).toContainEqual(expect.objectContaining({ path: 'damageBudget', rule: 'TIER_DAMAGE_ENVELOPE' }));
  });
});

describe('core-v1 defense and immunity', () => {
  it('keeps physical, magical, elemental, block and immunity fields explicit', () => {
    expectValid(physicalArmor);
    expectValid(hybridArmor);
    expectValid(shield);
    expectValid({
      ...physicalArmor,
      code: 'warded_armor',
      rarity: 'epic',
      defense: {
        physicalFlatDefense: 3,
        magicalFlatDefense: 3,
        elementalResistanceBps: { fire: 500 },
        immunities: { elements: ['poison'] },
      },
    });
  });

  it('rejects resistance-as-immunity, unknown elements and text-only defense', () => {
    expect(expectInvalid({ ...physicalArmor, defense: { magicalResistanceBps: 10000 } }))
      .toContainEqual(expect.objectContaining({ path: 'defense.magicalResistanceBps' }));
    expect(expectInvalid({ ...physicalArmor, defense: { elementalResistanceBps: { void: 500 } } }))
      .toContainEqual(expect.objectContaining({ path: 'defense.elementalResistanceBps.void' }));
    expect(expectInvalid({ ...physicalArmor, defense: { description: 'very sturdy' } }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ rule: 'UNKNOWN_FIELD' })]));
  });
});

describe('core-v1 costs and activation', () => {
  it.each([
    { type: 'mana', amount: 3 },
    { type: 'sp', amount: 3 },
    { type: 'hybrid', mana: 4, sp: 3 },
    { type: 'hp', percentBps: 300 },
    { type: 'none' },
    { type: 'custom', resourceRef: 'rage_points', amount: 1 },
  ])('accepts cost $type', (cost) => {
    expectValid(activeSkill({ cost }));
  });

  it('rejects missing cost, non-exclusive none and passive resource cost', () => {
    const withoutCost = activeSkill();
    delete withoutCost.cost;
    expect(expectInvalid(withoutCost)).toContainEqual(expect.objectContaining({ path: 'cost', rule: 'REQUIRED' }));
    expect(expectInvalid(activeSkill({ cost: { type: 'none', amount: 0 } })))
      .toContainEqual(expect.objectContaining({ path: 'cost', rule: 'COST_FIELDS' }));
    expect(expectInvalid({ ...passiveTalent, cost: { type: 'mana', amount: 3 } }))
      .toContainEqual(expect.objectContaining({ path: 'cost.type', rule: 'PASSIVE_COST' }));
  });

  it('validates triggered and reaction activation against allowlists and RC1.1', () => {
    expectValid({
      ...passiveTalent,
      code: 'reactive_guard',
      contentKind: 'skill',
      activation: { type: 'triggered', trigger: 'on_damage_taken' },
    });
    expectValid({
      schemaVersion: 1, rulesetCode: 'core-v1', profileMode: 'mechanical', contentKind: 'skill',
      code: 'block_reaction', name: 'Block Reaction', tier: 1, rarity: 'common',
      activation: { type: 'reaction', reactionKind: 'block' }, cost: noneCost, actionProfile: 'block',
    });
    expect(expectInvalid({ ...activeSkill(), activation: { type: 'triggered', trigger: 'anything' } }))
      .toContainEqual(expect.objectContaining({ path: 'activation.trigger' }));
    expect(expectInvalid({ ...activeSkill(), actionProfile: 'block' }))
      .toContainEqual(expect.objectContaining({ rule: 'REACTION_PROFILE' }));
  });

  it.each([
    'quick', 'normal', 'heavy', 'very_heavy', 'dagger', 'short_sword', 'long_sword',
    'heavy_axe', 'bow', 'crossbow', 'unarmed', 'potion', 'equipment_swap',
    'whirlwind', 'fireball', 'long_spell',
  ])('accepts allowlisted non-reaction action profile %s', (actionProfile) => {
    expectValid(activeSkill({ actionProfile }));
  });
});

describe('core-v1 targeting', () => {
  it('accepts single, area, chain, cleave and weapon attack targeting', () => {
    expectValid(fireball);
    for (const targeting of [
      { type: 'area', rangeBand: 'medium', maxTargets: 3, areaShape: 'circle', damageMultiplierPerTargetBps: [6000, 4500, 4500] },
      { type: 'chain', rangeBand: 'far', maxTargets: 3, chainCount: 3, chainInterval: 50, targetFalloffBps: 1000, damageMultiplierPerTargetBps: [6000, 5000, 4000] },
      { type: 'cleave', rangeBand: 'engaged', maxTargets: 2, damageMultiplierPerTargetBps: [6000, 6000] },
    ]) {
      expectValid(activeSkill({
        code: `target_${String(targeting.type)}`,
        effects: [{
          type: 'damage', targeting,
          damageComponents: [{ id: 'target-damage', channel: 'physical', element: null, baseDamage: 6, scaling: 'full', canCrit: true }],
        }],
      }));
    }
    expectValid(flameBlade);
  });

  it('rejects invalid single/multi/chain budgets and weapon_attack misuse', () => {
    const badSingle = clone(fireball) as unknown as { effects: Array<{ targeting: Record<string, unknown> }> };
    badSingle.effects[0]!.targeting.maxTargets = 2;
    expect(expectInvalid(badSingle)).toContainEqual(expect.objectContaining({ path: 'effects.0.targeting.maxTargets' }));
    const overBudget = clone(whirlwind) as unknown as { effects: Array<{ targeting: Record<string, unknown> }> };
    overBudget.effects[0]!.targeting.damageMultiplierPerTargetBps = [6000, 6000, 6000];
    expect(expectInvalid(overBudget)).toContainEqual(expect.objectContaining({ rule: 'AREA_TOTAL_CAP' }));
    const zeroMultiplier = clone(whirlwind) as unknown as { effects: Array<{ targeting: Record<string, unknown> }> };
    zeroMultiplier.effects[0]!.targeting.damageMultiplierPerTargetBps = [6000, 4500, 0];
    expect(expectInvalid(zeroMultiplier)).toContainEqual(expect.objectContaining({ path: 'effects.0.targeting.damageMultiplierPerTargetBps.2' }));
    expect(expectInvalid(activeSkill({
      effects: [{
        type: 'damage', targeting: { type: 'weapon_attack', rangeBand: 'engaged' },
        damageComponents: [{ id: 'bad', channel: 'physical', element: null, baseDamage: 4, scaling: 'full', canCrit: true }],
      }],
    }))).toContainEqual(expect.objectContaining({ rule: 'WEAPON_ATTACK_EFFECT' }));
  });
});

describe('core-v1 duration, stacking and effects', () => {
  it.each([
    { type: 'instant' }, { type: 'ticks', value: 100 }, { type: 'actions', value: 2 },
    { type: 'scene' }, { type: 'encounter' }, { type: 'permanent' },
  ])('accepts duration $type', (duration) => {
    const stacking = duration.type === 'permanent' ? { type: 'none' } : { type: 'refresh' };
    expectValid({ ...condition, duration, stacking });
  });

  it.each([
    { type: 'none' }, { type: 'refresh' }, { type: 'stack_intensity', maxStacks: 3 },
    { type: 'stack_duration', maxStacks: 3 }, { type: 'replace' },
  ])('accepts stacking $type', (stacking) => {
    expectValid({ ...condition, stacking });
  });

  it('validates every effect discriminator and rejects incompatible fields', () => {
    const effects = [
      { type: 'restore_resource', resource: 'mana', amount: 5, targeting: selfTarget },
      { type: 'modify_primary_attribute', attributeCode: 'strength', amount: 1, duration: { type: 'actions', value: 1 } },
      { type: 'modify_secondary_attribute', secondaryCode: 'evasion', amount: 1, duration: { type: 'scene' } },
      { type: 'apply_status', statusRef: 'burning', duration: { type: 'ticks', value: 100 }, stacking: { type: 'refresh' } },
      { type: 'remove_status', statusRef: 'burning' },
      { type: 'grant_reaction', reactionKind: 'dodge', reactionDepth: 1 },
      { type: 'movement', from: 'near', to: 'engaged', maximumTransitions: 1 },
    ];
    effects.forEach((effect, index) => expectValid(activeSkill({ code: `effect_${index}`, effects: [effect] })));
    expect(expectInvalid(activeSkill({ effects: [{ type: 'restore_resource', resource: 'hp', targeting: selfTarget }] })))
      .toContainEqual(expect.objectContaining({ path: 'effects.0.amount', rule: 'REQUIRED' }));
    expect(expectInvalid({ ...condition, duration: { type: 'turns', value: 2 } }))
      .toContainEqual(expect.objectContaining({ path: 'duration.type' }));
    expect(expectInvalid({ ...condition, duration: { type: 'permanent' }, stacking: { type: 'stack_intensity', maxStacks: 3 } }))
      .toContainEqual(expect.objectContaining({ rule: 'PERMANENT_STACKING' }));
  });
});

describe('core-v1 modifiers, requirements and templates', () => {
  it('accepts typed passive modifiers and closed requirements', () => {
    expectValid({
      ...mechanicalItem,
      requirements: {
        minimumLevel: 2,
        minimumPrimaryAttributes: { strength: 8, willpower: 6 },
        requiredContent: [{ contentKind: 'class', code: 'guardian' }],
        requiredWeaponTags: ['sword'],
        requiredEquipmentTags: ['shield'],
        requiredRuleset: 'core-v1',
      },
    });
    expectValid(mechanicalRace);
    expectValid(mechanicalClass);
    expectValid(creatureTemplate);
  });

  it('rejects arbitrary modifier paths, GPT sources, UUID/className requirements and bad creature budgets', () => {
    expect(expectInvalid({
      ...mechanicalItem,
      passiveModifiers: [{ target: 'attributes.strength', amount: 1, sourceRule: 'gpt' }],
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'passiveModifiers.0.target' }),
      expect.objectContaining({ path: 'passiveModifiers.0.sourceRule' }),
    ]));
    expect(expectInvalid({ ...mechanicalItem, requirements: { className: 'Guardian' } }))
      .toContainEqual(expect.objectContaining({ path: 'requirements.className', rule: 'UNKNOWN_FIELD' }));
    expect(expectInvalid({
      ...mechanicalItem,
      requirements: { requiredContent: [{ contentKind: 'class', code: '550e8400-e29b-41d4-a716-446655440000' }] },
    })).toContainEqual(expect.objectContaining({ path: 'requirements.requiredContent.0.code' }));
    expect(expectInvalid({
      ...creatureTemplate,
      template: { ...creatureTemplate.template, primaryAttributeBudget: 82 },
    })).toContainEqual(expect.objectContaining({ rule: 'NPC_ATTRIBUTE_BUDGET' }));
    expect(expectInvalid({ ...physicalArmor, equipmentSlots: ['main_hand'] }))
      .toContainEqual(expect.objectContaining({ path: 'equipmentSlots.0', rule: 'ARMOR_SLOT' }));
  });
});

describe('core-v1 runtime hardening', () => {
  it('rejects extra fields, unexpected prototypes and sparse arrays', () => {
    expect(expectInvalid({ ...dagger, finalDamage: 999 }))
      .toContainEqual(expect.objectContaining({ path: 'finalDamage', rule: 'UNKNOWN_FIELD' }));
    expect(expectInvalid({
      ...dagger,
      damageComponents: [{ ...dagger.damageComponents[0], finalDamage: 999 }],
    })).toContainEqual(expect.objectContaining({ path: 'damageComponents.0.finalDamage' }));
    const inherited = Object.assign(Object.create({ suppliedBy: 'gpt' }) as object, dagger);
    expect(expectInvalid(inherited)).toContainEqual(expect.objectContaining({ path: '$', rule: 'PLAIN_OBJECT' }));
    const sparse = Array(1) as unknown[];
    expect(expectInvalid({ ...dagger, damageComponents: sparse }))
      .toContainEqual(expect.objectContaining({ path: 'damageComponents.0', rule: 'SPARSE_ARRAY' }));
    const accessor = { ...dagger } as Record<string, unknown>;
    Object.defineProperty(accessor, 'name', { enumerable: true, get: () => 'Accessor' });
    expect(expectInvalid(accessor)).toContainEqual(expect.objectContaining({ path: '$', rule: 'DATA_PROPERTIES' }));
  });

  it('rejects duplicate damage component ids across effect groups', () => {
    const component = { id: 'duplicate', channel: 'magical', element: 'fire', baseDamage: 3, scaling: 'none', canCrit: false };
    expect(expectInvalid(activeSkill({
      rarity: 'uncommon',
      effects: [
        { type: 'damage', targeting: singleTarget, damageComponents: [component] },
        { type: 'damage', targeting: singleTarget, damageComponents: [component] },
      ],
    }))).toContainEqual(expect.objectContaining({ path: 'effects.1.damageComponents.0.id', rule: 'DUPLICATE_DAMAGE_ID' }));
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 1.5])(
    'rejects unsafe numeric value %s',
    (value) => {
      expect(expectInvalid({ ...dagger, tier: value })).toContainEqual(expect.objectContaining({ path: 'tier', rule: 'SAFE_INTEGER' }));
      expect(expectInvalid({
        ...dagger,
        damageComponents: [{ ...dagger.damageComponents[0], baseDamage: value }],
      })).toContainEqual(expect.objectContaining({ path: 'damageComponents.0.baseDamage', rule: 'SAFE_INTEGER' }));
    },
  );

  it('is deterministic, does not mutate frozen input and returns path-addressable issues', () => {
    const frozen = Object.freeze({
      ...dagger,
      damageComponents: Object.freeze(dagger.damageComponents.map((component) => Object.freeze({ ...component }))),
      targeting: Object.freeze({ ...dagger.targeting }),
    });
    const before = JSON.stringify(frozen);
    const first = validateCoreV1ContentProfile(frozen);
    const second = validateCoreV1ContentProfile(frozen);
    expect(first).toEqual(second);
    expect(JSON.stringify(frozen)).toBe(before);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.value).not.toBe(frozen);
      expect(first.value).toEqual(frozen);
    }

    const invalidResult: CoreV1ContentValidationResult = validateCoreV1ContentProfile({
      ...fireball,
      effects: [{ ...fireball.effects[0], damageComponents: [{ ...fireball.effects[0].damageComponents[0], element: 'void' }] }],
    });
    expect(invalidResult).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ path: 'effects.0.damageComponents.0.element', rule: 'ENUM' })],
    });
  });

  it('exposes defensive configuration copies', () => {
    const elements = getCoreV1ContentElements() as string[];
    const limits = getCoreV1RarityAdditionalPropertyLimits() as Record<string, number>;
    elements.push('void');
    limits.common = 99;
    expect(getCoreV1ContentElements()).not.toContain('void');
    expect(getCoreV1RarityAdditionalPropertyLimits()).toEqual({
      common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4, mythic: 5,
    });
  });
});

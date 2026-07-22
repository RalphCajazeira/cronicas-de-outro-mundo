import { describe, expect, it } from 'vitest';
import {
  aggregateEquippedModifiers,
  calculateInventoryEncumbrance,
  collectEquippedModifiers,
  createCoreV1EmptyEquipmentLoadout,
  equipItem,
  evaluateEquipmentRequirements,
  getInitialAttributePreset,
  planEquipItem,
  unequipItem,
  validateCoreV1ContentProfile,
  validateCoreV1InventorySpec,
  validateEquipmentLoadout,
} from './index.js';
import type {
  CoreV1ContentProfile,
  CoreV1EquipmentLoadout,
  CoreV1EquipmentRequirementContext,
  CoreV1InventoryEntry,
  CoreV1InventoryResult,
  CoreV1InventorySpec,
  CoreV1InventoryState,
} from './index.js';

const noneCost = { type: 'none' } as const;
const passive = { type: 'passive' } as const;
const singleTarget = { type: 'single_target', rangeBand: 'engaged', maxTargets: 1 } as const;

function uniqueSpec(
  equipmentSlots?: CoreV1InventorySpec['equipmentSlots'],
  handedness?: CoreV1InventorySpec['handedness'],
): CoreV1InventorySpec {
  return {
    schemaVersion: 1,
    rulesetCode: 'core-v1',
    inventoryRulesCode: 'core-v1-inventory-v1',
    unitWeight: 10,
    stacking: { mode: 'unique' },
    ...(equipmentSlots === undefined ? {} : { equipmentSlots }),
    ...(handedness === undefined ? {} : { handedness }),
  };
}

function weaponProfile(
  code: string,
  handedness: 'one_handed' | 'two_handed' | 'versatile',
  requirements?: Extract<CoreV1ContentProfile, { profileMode: 'mechanical' }>['requirements'],
): CoreV1ContentProfile {
  return {
    schemaVersion: 1,
    rulesetCode: 'core-v1',
    profileMode: 'mechanical',
    contentKind: 'weapon',
    code,
    name: code,
    tier: 1,
    rarity: 'common',
    activation: { type: 'active' },
    cost: noneCost,
    actionProfile: handedness === 'two_handed' ? 'heavy_axe' : 'long_sword',
    targeting: singleTarget,
    damageComponents: [{ id: `${code}-hit`, channel: 'physical', element: null, baseDamage: 4, scaling: 'full', canCrit: true }],
    handedness,
    weaponTags: [code],
    ...(requirements === undefined ? {} : { requirements }),
  };
}

const shieldProfile = {
  schemaVersion: 1,
  rulesetCode: 'core-v1',
  profileMode: 'mechanical',
  contentKind: 'shield',
  code: 'shield',
  name: 'Escudo',
  tier: 1,
  rarity: 'common',
  activation: passive,
  cost: noneCost,
  defense: { blockValue: 3 },
  equipmentSlots: ['off_hand'],
} as const satisfies CoreV1ContentProfile;

const fullArmorProfile = {
  schemaVersion: 1,
  rulesetCode: 'core-v1',
  profileMode: 'mechanical',
  contentKind: 'armor',
  code: 'full_armor',
  name: 'Armadura Completa',
  tier: 1,
  rarity: 'common',
  activation: passive,
  cost: noneCost,
  defense: { physicalFlatDefense: 4 },
  equipmentSlots: ['head', 'chest', 'hands', 'legs', 'feet', 'body'],
} as const satisfies CoreV1ContentProfile;

function itemProfile(
  code: string,
  amount = 1,
  requirements?: Extract<CoreV1ContentProfile, { profileMode: 'mechanical' }>['requirements'],
): CoreV1ContentProfile {
  return {
    schemaVersion: 1,
    rulesetCode: 'core-v1',
    profileMode: 'mechanical',
    contentKind: 'item',
    code,
    name: code,
    tier: 1,
    rarity: 'common',
    activation: passive,
    cost: noneCost,
    passiveModifiers: [{ target: 'accuracy', amount, sourceRule: 'equipped_content' }],
    ...(requirements === undefined ? {} : { requirements }),
  };
}

const narrativeItem = {
  schemaVersion: 1,
  rulesetCode: 'core-v1',
  profileMode: 'narrative',
  contentKind: 'item',
  code: 'keepsake',
  name: 'Lembrança',
} as const satisfies CoreV1ContentProfile;

function instance(
  entryRef: string,
  contentType: 'weapon' | 'shield' | 'armor' | 'item',
  profile: CoreV1ContentProfile,
  spec = uniqueSpec(),
  state: 'available' | 'equipped' = 'available',
): CoreV1InventoryEntry {
  return {
    entryKind: 'instance',
    entryRef,
    contentVersion: { scope: 'world', contentType, code: profile.code, versionNumber: 1 },
    inventorySpec: spec,
    profile,
    state,
  };
}

const requirementContext = (overrides: Partial<CoreV1EquipmentRequirementContext> = {}): CoreV1EquipmentRequirementContext => ({
  level: 5,
  primaryAttributes: getInitialAttributePreset('balanced'),
  knownContentRefs: [],
  equippedWeaponTags: [],
  equippedEquipmentTags: [],
  rulesetCode: 'core-v1',
  ...overrides,
});

function expectOk<T>(result: CoreV1InventoryResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function expectInvalid<T>(result: CoreV1InventoryResult<T>, rule?: string): void {
  expect(result).toMatchObject({ ok: false, code: 'INVALID_CORE_V1_INVENTORY_OPERATION', retryable: true });
  if (!result.ok && rule !== undefined) expect(result.issues.some((issue) => issue.rule === rule)).toBe(true);
}

function equip(
  inventory: CoreV1InventoryState,
  loadout: CoreV1EquipmentLoadout,
  entryRef: string,
  targetSlotRef?: 'main_hand' | 'off_hand' | 'accessory_1' | 'accessory_2',
  versatileMode?: 'one_handed' | 'two_handed',
) {
  return expectOk(equipItem(
    inventory,
    loadout,
    {
      entryRef,
      ...(targetSlotRef === undefined ? {} : { targetSlotRef }),
      ...(versatileMode === undefined ? {} : { versatileMode }),
    },
    requirementContext(),
  ));
}

describe('core-v1 equipment loadout and hand rules', () => {
  it('creates and validates the closed physical slot catalog', () => {
    const loadout = createCoreV1EmptyEquipmentLoadout();
    expect(loadout.slots.map((slot) => slot.slotRef)).toEqual([
      'main_hand', 'off_hand', 'head', 'chest', 'hands', 'legs', 'feet', 'body', 'accessory_1', 'accessory_2',
    ]);
    expect(expectOk(validateEquipmentLoadout({ entries: [] }, loadout))).toEqual(loadout);
    expectInvalid(validateEquipmentLoadout({ entries: [] }, { slots: loadout.slots.slice(1) }), 'SLOT_CATALOG');
  });

  it.each(['main_hand', 'off_hand'] as const)('equips a dagger in %s', (targetSlotRef) => {
    const dagger = instance('dagger', 'weapon', weaponProfile('dagger', 'one_handed'));
    const result = equip({ entries: [dagger] }, createCoreV1EmptyEquipmentLoadout(), 'dagger', targetSlotRef);
    expect(result.loadout.slots.find((slot) => slot.slotRef === targetSlotRef)?.entryRef).toBe('dagger');
    expect(result.inventory.entries[0]).toMatchObject({ state: 'equipped' });
  });

  it('supports one-handed sword plus shield', () => {
    const inventory = {
      entries: [
        instance('sword', 'weapon', weaponProfile('sword', 'one_handed')),
        instance('shield', 'shield', shieldProfile),
      ],
    } satisfies CoreV1InventoryState;
    const sword = equip(inventory, createCoreV1EmptyEquipmentLoadout(), 'sword', 'main_hand');
    const shield = equip(sword.inventory, sword.loadout, 'shield');
    expect(shield.loadout.slots.slice(0, 2).map((slot) => slot.entryRef)).toEqual(['sword', 'shield']);
  });

  it('reserves both hands for two-handed weapons and reports shield conflicts without replacement', () => {
    const inventory = {
      entries: [
        instance('axe', 'weapon', weaponProfile('axe', 'two_handed')),
        instance('shield', 'shield', shieldProfile),
      ],
    } satisfies CoreV1InventoryState;
    const axe = equip(inventory, createCoreV1EmptyEquipmentLoadout(), 'axe');
    expect(axe.loadout.slots.slice(0, 2).map((slot) => slot.entryRef)).toEqual(['axe', 'axe']);
    const plan = expectOk(planEquipItem(axe.inventory, axe.loadout, { entryRef: 'shield' }, requirementContext()));
    expect(plan.canEquip).toBe(false);
    expect(plan.occupiedConflicts).toEqual([{ slotRef: 'off_hand', entryRef: 'axe' }]);
  });

  it('requires explicit versatile mode and supports one or two hands', () => {
    const versatile = instance('versatile', 'weapon', weaponProfile('versatile', 'versatile'));
    const inventory = { entries: [versatile] };
    const loadout = createCoreV1EmptyEquipmentLoadout();
    expect(expectOk(planEquipItem(inventory, loadout, { entryRef: 'versatile' }, requirementContext()))).toMatchObject({
      canEquip: false,
      issues: [expect.objectContaining({ rule: 'VERSATILE_MODE_REQUIRED' })],
    });
    expect(equip(inventory, loadout, 'versatile', 'off_hand', 'one_handed').changedSlots).toEqual(['off_hand']);
    expect(equip(inventory, loadout, 'versatile', undefined, 'two_handed').changedSlots).toEqual(['main_hand', 'off_hand']);
  });

  it('rejects the same one-handed instance occupying both hands', () => {
    const dagger = instance('dagger', 'weapon', weaponProfile('dagger', 'one_handed'), uniqueSpec(), 'equipped');
    const loadout = createCoreV1EmptyEquipmentLoadout();
    const invalid = {
      slots: loadout.slots.map((slot) => ['main_hand', 'off_hand'].includes(slot.slotRef) ? { ...slot, entryRef: 'dagger' } : slot),
    };
    expectInvalid(validateEquipmentLoadout({ entries: [dagger] }, invalid), 'ONE_HANDED_SLOTS');
  });
});

describe('core-v1 body, accessory and multslot equipment', () => {
  it('validates the starter body armor blueprint within common rarity and weight budgets', () => {
    const profile = {
      schemaVersion: 1,
      rulesetCode: 'core-v1',
      profileMode: 'mechanical',
      contentKind: 'armor',
      code: 'starter-body-armor',
      name: 'Armadura de corpo inteiro',
      tier: 1,
      rarity: 'common',
      activation: { type: 'passive' },
      cost: { type: 'none' },
      defense: { physicalFlatDefense: 5 },
      equipmentSlots: ['body'],
    } as const satisfies CoreV1ContentProfile;
    const inventorySpec = {
      schemaVersion: 1,
      rulesetCode: 'core-v1',
      inventoryRulesCode: 'core-v1-inventory-v1',
      unitWeight: 3,
      stacking: { mode: 'unique' },
      equipmentSlots: ['body'],
    } as const satisfies CoreV1InventorySpec;

    expect(validateCoreV1ContentProfile(profile)).toMatchObject({ ok: true });
    expect(validateCoreV1InventorySpec(inventorySpec)).toMatchObject({ ok: true });
    const equipped = equip(
      { entries: [instance('starter-body-armor-1', 'armor', profile, inventorySpec)] },
      createCoreV1EmptyEquipmentLoadout(),
      'starter-body-armor-1',
    );
    expect(equipped.loadout.slots.find((slot) => slot.slotRef === 'body')?.entryRef).toBe('starter-body-armor-1');
    expect(equipped.loadout.slots.find((slot) => slot.slotRef === 'chest')?.entryRef).toBeNull();
    expect(calculateInventoryEncumbrance(3, 100)).toMatchObject({
      ok: true, value: { carriedWeight: 3, carryingCapacity: 100, state: 'normal', penaltyBps: 0 },
    });

    const overBudget = validateCoreV1ContentProfile({
      ...profile,
      defense: { physicalFlatDefense: 5, magicalFlatDefense: 1 },
    });
    expect(overBudget).toMatchObject({ ok: false });
    if (overBudget.ok) throw new Error('fixture');
    expect(overBudget.issues).toContainEqual(expect.objectContaining({ rule: 'RARITY_PROPERTY_LIMIT' }));
  });

  it('keeps body and chest semantically distinct without slot substitution', () => {
    const bodyArmor = instance('body-armor', 'armor', {
      ...fullArmorProfile, code: 'body_armor', name: 'Traje completo', equipmentSlots: ['body'],
    }, uniqueSpec(['body']));
    const plan = expectOk(planEquipItem(
      { entries: [bodyArmor] }, createCoreV1EmptyEquipmentLoadout(),
      { entryRef: 'body-armor', targetSlotRef: 'chest' }, requirementContext(),
    ));
    expect(plan.canEquip).toBe(false);
    expect(plan.issues).toEqual(expect.arrayContaining([expect.objectContaining({
      rule: 'INCOMPATIBLE_SLOT', received: 'chest', expected: ['body'],
    })]));
  });

  it('equips full armor atomically across every declared body slot', () => {
    const armor = instance('armor', 'armor', fullArmorProfile);
    const result = equip({ entries: [armor] }, createCoreV1EmptyEquipmentLoadout(), 'armor');
    expect(result.changedSlots).toEqual(['head', 'chest', 'hands', 'legs', 'feet', 'body']);
    expect(result.loadout.slots.filter((slot) => result.changedSlots.includes(slot.slotRef)).every((slot) => slot.entryRef === 'armor')).toBe(true);
  });

  it('equips two accessories and rejects a third without silently replacing either', () => {
    const entries = ['ring-a', 'ring-b', 'ring-c'].map((ref) => instance(ref, 'item', itemProfile(ref), uniqueSpec(['accessory'])));
    const first = equip({ entries }, createCoreV1EmptyEquipmentLoadout(), 'ring-a');
    const second = equip(first.inventory, first.loadout, 'ring-b');
    expect(second.loadout.slots.slice(-2).map((slot) => slot.entryRef)).toEqual(['ring-a', 'ring-b']);
    const third = expectOk(planEquipItem(second.inventory, second.loadout, { entryRef: 'ring-c' }, requirementContext()));
    expect(third.canEquip).toBe(false);
    expect(third.occupiedConflicts).toEqual([{ slotRef: 'accessory_1', entryRef: 'ring-a' }]);
  });

  it('equips and unequips multslot items atomically independent of declared order', () => {
    const profile = itemProfile('harness');
    const harness = instance('harness', 'item', profile, uniqueSpec(['body', 'chest']));
    const before = { entries: [harness] } satisfies CoreV1InventoryState;
    const equipped = equip(before, createCoreV1EmptyEquipmentLoadout(), 'harness');
    expect(equipped.changedSlots).toEqual(['chest', 'body']);
    const unequipped = expectOk(unequipItem(equipped.inventory, equipped.loadout, 'harness'));
    expect(unequipped.changedSlots).toEqual(['chest', 'body']);
    expect(unequipped.loadout.slots.every((slot) => slot.entryRef === null)).toBe(true);
    expect(before.entries[0]).toMatchObject({ state: 'available' });
  });

  it('preserves both states when any multslot target conflicts', () => {
    const blocker = instance('blocker', 'armor', {
      ...fullArmorProfile, code: 'chest_armor', name: 'Peitoral', equipmentSlots: ['chest'],
    });
    const harness = instance('harness', 'item', itemProfile('harness'), uniqueSpec(['body', 'chest']));
    const blocked = equip({ entries: [blocker, harness] }, createCoreV1EmptyEquipmentLoadout(), 'blocker');
    const beforeInventory = structuredClone(blocked.inventory);
    const beforeLoadout = structuredClone(blocked.loadout);
    expectInvalid(equipItem(blocked.inventory, blocked.loadout, { entryRef: 'harness' }, requirementContext()), 'OCCUPIED_SLOT');
    expect(blocked.inventory).toEqual(beforeInventory);
    expect(blocked.loadout).toEqual(beforeLoadout);
  });

  it('rejects stacks, slotless mechanical items, narrative content and missing entries', () => {
    const profile = itemProfile('token');
    const stack = {
      entryKind: 'stack' as const,
      entryRef: 'tokens',
      contentVersion: { scope: 'world' as const, contentType: 'item' as const, code: 'token', versionNumber: 1 },
      inventorySpec: { ...uniqueSpec(), stacking: { mode: 'stackable' as const, maxStack: 10 } },
      profile,
      quantity: 2,
    };
    expect(expectOk(planEquipItem({ entries: [stack] }, createCoreV1EmptyEquipmentLoadout(), { entryRef: 'tokens' }, requirementContext())).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ rule: 'EQUIPPABLE_INSTANCE' })]));
    const slotless = instance('slotless', 'item', profile);
    expect(expectOk(planEquipItem({ entries: [slotless] }, createCoreV1EmptyEquipmentLoadout(), { entryRef: 'slotless' }, requirementContext())).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ rule: 'EQUIPMENT_SLOTS_REQUIRED' })]));
    const narrative = instance('keepsake', 'item', narrativeItem, uniqueSpec(['accessory']));
    expect(expectOk(planEquipItem({ entries: [narrative] }, createCoreV1EmptyEquipmentLoadout(), { entryRef: 'keepsake' }, requirementContext())).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ rule: 'MECHANICAL_EQUIPMENT' })]));
    expect(expectOk(planEquipItem({ entries: [] }, createCoreV1EmptyEquipmentLoadout(), { entryRef: 'missing' }, requirementContext())).canEquip).toBe(false);
  });
});

describe('core-v1 equipment requirements', () => {
  it('evaluates level, attributes, known content, tags and ruleset together', () => {
    const requirements = {
      minimumLevel: 10,
      minimumPrimaryAttributes: { strength: 15 },
      requiredContent: [{ contentKind: 'skill' as const, code: 'weapon_mastery' }],
      requiredWeaponTags: ['sword'],
      requiredEquipmentTags: ['heavy'],
      requiredRuleset: 'core-v1' as const,
    };
    const failed = evaluateEquipmentRequirements(requirements, requirementContext({ level: 1, rulesetCode: 'other' }));
    expect(failed.met).toBe(false);
    expect(new Set(failed.issues.map((issue) => issue.rule))).toEqual(new Set([
      'MINIMUM_LEVEL', 'MINIMUM_PRIMARY_ATTRIBUTE', 'REQUIRED_CONTENT', 'REQUIRED_WEAPON_TAG',
      'REQUIRED_EQUIPMENT_TAG', 'REQUIRED_RULESET',
    ]));
    const passed = evaluateEquipmentRequirements(requirements, requirementContext({
      level: 10,
      primaryAttributes: { ...getInitialAttributePreset('balanced'), strength: 15 },
      knownContentRefs: [{ contentKind: 'skill', code: 'weapon_mastery' }],
      equippedWeaponTags: ['sword'],
      equippedEquipmentTags: ['heavy'],
    }));
    expect(passed).toEqual({ met: true, issues: [] });
  });

  it('does not let an item satisfy its own required equipment tag', () => {
    const profile = itemProfile('sigil', 1, { requiredEquipmentTags: ['sigil'] });
    const sigil = instance('sigil', 'item', profile, uniqueSpec(['accessory']));
    const plan = expectOk(planEquipItem({ entries: [sigil] }, createCoreV1EmptyEquipmentLoadout(), { entryRef: 'sigil' }, requirementContext()));
    expect(plan.canEquip).toBe(false);
    expect(plan.requirements.issues).toEqual([expect.objectContaining({ rule: 'REQUIRED_EQUIPMENT_TAG' })]);
  });
});

describe('core-v1 equipped passive modifiers', () => {
  it('collects typed sources deterministically and ignores carried items', () => {
    const carried = instance('carried', 'item', itemProfile('carried', 9), uniqueSpec(['accessory']));
    const ringB = instance('ring-b', 'item', itemProfile('ring-b', 2), uniqueSpec(['accessory']));
    const ringA = instance('ring-a', 'item', itemProfile('ring-a', 1), uniqueSpec(['accessory']));
    const first = equip({ entries: [carried, ringB, ringA] }, createCoreV1EmptyEquipmentLoadout(), 'ring-b');
    const second = equip(first.inventory, first.loadout, 'ring-a');
    const modifiers = expectOk(collectEquippedModifiers(second.inventory, second.loadout));
    expect(modifiers).toEqual([
      { target: 'accuracy', source: { type: 'equipment', ref: 'ring-a' }, value: 1 },
      { target: 'accuracy', source: { type: 'equipment', ref: 'ring-b' }, value: 2 },
    ]);
    expect(expectOk(aggregateEquippedModifiers(second.inventory, second.loadout))).toEqual([{ target: 'accuracy', value: 3 }]);
  });

  it('counts a multslot item once and prepares modifiers without applying a snapshot', () => {
    const harness = instance('harness', 'item', itemProfile('harness', 4), uniqueSpec(['chest', 'body']));
    const equipped = equip({ entries: [harness] }, createCoreV1EmptyEquipmentLoadout(), 'harness');
    expect(expectOk(collectEquippedModifiers(equipped.inventory, equipped.loadout))).toEqual([
      { target: 'accuracy', source: { type: 'equipment', ref: 'harness' }, value: 4 },
    ]);
  });

  it('detects overflow only when aggregating', () => {
    const firstItem = instance('a', 'item', itemProfile('a', Number.MAX_SAFE_INTEGER), uniqueSpec(['accessory']));
    const secondItem = instance('b', 'item', itemProfile('b', 1), uniqueSpec(['accessory']));
    const first = equip({ entries: [firstItem, secondItem] }, createCoreV1EmptyEquipmentLoadout(), 'a');
    const second = equip(first.inventory, first.loadout, 'b');
    expect(expectOk(collectEquippedModifiers(second.inventory, second.loadout))).toHaveLength(2);
    expectInvalid(aggregateEquippedModifiers(second.inventory, second.loadout), 'SAFE_INTEGER');
  });
});

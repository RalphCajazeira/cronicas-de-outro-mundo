import { describe, expect, it } from 'vitest';
import {
  addInventoryEntry,
  calculateInventoryEncumbrance,
  calculateInventoryWeight,
  mergeInventoryStacks,
  removeInventoryQuantity,
  splitInventoryStack,
  validateCoreV1InventorySpec,
  validateCoreV1InventoryState,
} from './index.js';
import type {
  CoreV1ContentProfile,
  CoreV1ContentVersionReference,
  CoreV1InventoryEntry,
  CoreV1InventoryResult,
  CoreV1InventorySpec,
  CoreV1InventoryState,
} from './index.js';

const uniqueSpec = (unitWeight = 10): CoreV1InventorySpec => ({
  schemaVersion: 1,
  rulesetCode: 'core-v1',
  inventoryRulesCode: 'core-v1-inventory-v1',
  unitWeight,
  stacking: { mode: 'unique' },
});

const stackSpec = (maxStack = 20, unitWeight = 2): CoreV1InventorySpec => ({
  schemaVersion: 1,
  rulesetCode: 'core-v1',
  inventoryRulesCode: 'core-v1-inventory-v1',
  unitWeight,
  stacking: { mode: 'stackable', maxStack },
});

const potionProfile = {
  schemaVersion: 1,
  rulesetCode: 'core-v1',
  profileMode: 'mechanical',
  contentKind: 'consumable',
  code: 'healing_potion',
  name: 'Poção de Cura',
  tier: 1,
  rarity: 'common',
  activation: { type: 'active' },
  cost: { type: 'none' },
  actionProfile: 'potion',
  consumable: true,
  effects: [{ type: 'restore_resource', resource: 'hp', amount: 10, targeting: { type: 'self', rangeBand: 'self' } }],
} as const satisfies CoreV1ContentProfile;

const daggerProfile = {
  schemaVersion: 1,
  rulesetCode: 'core-v1',
  profileMode: 'mechanical',
  contentKind: 'weapon',
  code: 'dagger',
  name: 'Adaga',
  tier: 1,
  rarity: 'common',
  activation: { type: 'active' },
  cost: { type: 'none' },
  actionProfile: 'dagger',
  targeting: { type: 'single_target', rangeBand: 'engaged', maxTargets: 1 },
  damageComponents: [{ id: 'dagger-hit', channel: 'physical', element: null, baseDamage: 4, scaling: 'full', canCrit: true }],
  handedness: 'one_handed',
  weaponTags: ['dagger'],
} as const satisfies CoreV1ContentProfile;

function contentVersion(
  contentType: CoreV1ContentVersionReference['contentType'],
  code: string,
  versionNumber = 1,
): CoreV1ContentVersionReference {
  return { scope: 'world', contentType, code, versionNumber };
}

function stack(
  entryRef: string,
  quantity: number,
  versionNumber = 1,
  spec = stackSpec(),
): CoreV1InventoryEntry {
  return {
    entryKind: 'stack',
    entryRef,
    contentVersion: contentVersion('consumable', 'healing_potion', versionNumber),
    inventorySpec: spec,
    profile: potionProfile,
    quantity,
  };
}

function instance(
  entryRef: string,
  state: 'available' | 'equipped' | 'reserved' | 'consumed' | 'destroyed' = 'available',
): CoreV1InventoryEntry {
  return {
    entryKind: 'instance',
    entryRef,
    contentVersion: contentVersion('weapon', 'dagger'),
    inventorySpec: uniqueSpec(),
    profile: daggerProfile,
    state,
  };
}

function expectOk<T>(result: CoreV1InventoryResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function expectInvalid<T>(result: CoreV1InventoryResult<T>, rule?: string): void {
  expect(result).toMatchObject({ ok: false, code: 'INVALID_CORE_V1_INVENTORY_OPERATION', retryable: true });
  if (!result.ok && rule !== undefined) expect(result.issues.some((issue) => issue.rule === rule)).toBe(true);
}

describe('core-v1 inventory spec and state validation', () => {
  it('accepts unique, stackable, zero weight and max stack 999', () => {
    expect(expectOk(validateCoreV1InventorySpec(uniqueSpec(0)))).toEqual(uniqueSpec(0));
    expect(expectOk(validateCoreV1InventorySpec(stackSpec(999)))).toEqual(stackSpec(999));
  });

  it.each([
    [uniqueSpec(-1), 'INTEGER_RANGE'],
    [uniqueSpec(Number.MAX_SAFE_INTEGER + 1), 'SAFE_INTEGER'],
    [stackSpec(1), 'INTEGER_RANGE'],
    [stackSpec(1000), 'INTEGER_RANGE'],
  ])('rejects invalid spec %#', (spec, rule) => expectInvalid(validateCoreV1InventorySpec(spec), rule));

  it('rejects extra fields, unexpected prototypes and sparse physical slot arrays', () => {
    expectInvalid(validateCoreV1InventorySpec({ ...uniqueSpec(), extra: true }), 'UNKNOWN_FIELD');
    expectInvalid(validateCoreV1InventorySpec(Object.create({ inherited: true })), 'PLAIN_OBJECT');
    const equipmentSlots = new Array(2);
    equipmentSlots[1] = 'accessory';
    expectInvalid(validateCoreV1InventorySpec({ ...uniqueSpec(), equipmentSlots }), 'SPARSE_ARRAY');
  });

  it('accepts empty and 256-entry inventories, rejects 257 and duplicate refs', () => {
    expect(expectOk(validateCoreV1InventoryState({ entries: [] }))).toEqual({ entries: [] });
    const entries = Array.from({ length: 256 }, (_, index) => instance(`dagger-${index}`));
    expect(expectOk(validateCoreV1InventoryState({ entries })).entries).toHaveLength(256);
    expectInvalid(validateCoreV1InventoryState({ entries: [...entries, instance('dagger-256')] }), 'ARRAY_LENGTH');
    expectInvalid(validateCoreV1InventoryState({ entries: [instance('same-ref'), instance('same-ref')] }), 'DUPLICATE_ENTRY_REF');
  });

  it('rejects quantity on instances, stacks above max and equipment stacks', () => {
    expectInvalid(validateCoreV1InventoryState({ entries: [{ ...instance('dagger-a'), quantity: 1 }] }), 'UNKNOWN_FIELD');
    expectInvalid(validateCoreV1InventoryState({ entries: [stack('potions', 21)] }), 'INTEGER_RANGE');
    expectInvalid(validateCoreV1InventoryState({
      entries: [{
        entryKind: 'stack', entryRef: 'daggers', contentVersion: contentVersion('weapon', 'dagger'),
        inventorySpec: stackSpec(), profile: daggerProfile, quantity: 2,
      }],
    }), 'EQUIPMENT_UNIQUE');
  });

  it('allows consumed state but does not mutate or return received objects', () => {
    const state = { entries: [instance('spent-dagger', 'consumed')] } satisfies CoreV1InventoryState;
    const result = expectOk(validateCoreV1InventoryState(state));
    expect(result).toEqual(state);
    expect(result).not.toBe(state);
    expect(state.entries[0]?.entryKind === 'instance' && state.entries[0].state).toBe('consumed');
  });
});

describe('core-v1 inventory add and remove operations', () => {
  it('adds a unique instance and rejects duplicate or destroyed instances', () => {
    const added = expectOk(addInventoryEntry({ entries: [] }, { entryKind: 'instance', entry: instance('dagger-a') as never }));
    expect(added.inventory.entries.map((entry) => entry.entryRef)).toEqual(['dagger-a']);
    expect(added.createdEntryRefs).toEqual(['dagger-a']);
    expectInvalid(addInventoryEntry(added.inventory, { entryKind: 'instance', entry: instance('dagger-a') as never }), 'DUPLICATE_ENTRY_REF');
    expectInvalid(addInventoryEntry({ entries: [] }, { entryKind: 'instance', entry: instance('broken', 'destroyed') as never }), 'ADD_STATE');
  });

  it('fills compatible stacks first and creates deterministic overflow stacks without loss', () => {
    const original = { entries: [stack('potions-a', 10)] } satisfies CoreV1InventoryState;
    const result = expectOk(addInventoryEntry(original, {
      entryKind: 'stack',
      contentVersion: contentVersion('consumable', 'healing_potion'),
      inventorySpec: stackSpec(),
      profile: potionProfile,
      quantity: 55,
      newEntryRefs: ['potions-b', 'potions-c', 'potions-d'],
    }));
    expect(result.inventory.entries.map((entry) => entry.entryKind === 'stack' ? entry.quantity : 1)).toEqual([20, 20, 20, 5]);
    expect(result.changedEntryRefs).toEqual(['potions-a']);
    expect(result.createdEntryRefs).toEqual(['potions-b', 'potions-c', 'potions-d']);
    expect(original.entries[0]).toEqual(stack('potions-a', 10));
  });

  it('requires the exact deterministic ref count and rejects unsafe quantity', () => {
    const input = {
      entryKind: 'stack' as const,
      contentVersion: contentVersion('consumable', 'healing_potion'),
      inventorySpec: stackSpec(), profile: potionProfile, quantity: 21, newEntryRefs: ['only-one'],
    };
    expectInvalid(addInventoryEntry({ entries: [] }, input), 'STACK_REF_COUNT');
    expectInvalid(addInventoryEntry({ entries: [] }, { ...input, quantity: Number.MAX_SAFE_INTEGER + 1 }), 'SAFE_INTEGER');
  });

  it('removes partial/full stacks and unique instances while preserving order', () => {
    const state = { entries: [stack('potions', 10), instance('dagger')] } satisfies CoreV1InventoryState;
    const partial = expectOk(removeInventoryQuantity(state, 'potions', 4));
    expect(partial.inventory.entries[0]).toMatchObject({ entryRef: 'potions', quantity: 6 });
    const full = expectOk(removeInventoryQuantity(partial.inventory, 'potions', 6));
    expect(full.inventory.entries.map((entry) => entry.entryRef)).toEqual(['dagger']);
    expect(expectOk(removeInventoryQuantity(full.inventory, 'dagger', 1)).inventory.entries).toEqual([]);
  });

  it('rejects equipped removal, insufficient quantity and invalid unique quantity', () => {
    expectInvalid(removeInventoryQuantity({ entries: [instance('dagger', 'equipped')] }, 'dagger', 1), 'EQUIPPED_REMOVAL');
    expectInvalid(removeInventoryQuantity({ entries: [stack('potions', 3)] }, 'potions', 4), 'INSUFFICIENT_QUANTITY');
    expectInvalid(removeInventoryQuantity({ entries: [instance('dagger')] }, 'dagger', 2), 'UNIQUE_QUANTITY');
  });
});

describe('core-v1 stack split, merge and version pinning', () => {
  it('splits deterministically after the source and rejects zero, total and duplicate refs', () => {
    const state = { entries: [stack('potions-a', 30, 1, stackSpec(30)), instance('dagger')] } satisfies CoreV1InventoryState;
    const split = expectOk(splitInventoryStack(state, 'potions-a', 10, 'potions-b'));
    expect(split.inventory.entries.map((entry) => [entry.entryRef, entry.entryKind === 'stack' ? entry.quantity : 1]))
      .toEqual([['potions-a', 20], ['potions-b', 10], ['dagger', 1]]);
    expectInvalid(splitInventoryStack(state, 'potions-a', 0, 'potions-b'), 'INTEGER_RANGE');
    expectInvalid(splitInventoryStack(state, 'potions-a', 30, 'potions-b'), 'INTEGER_RANGE');
    expectInvalid(splitInventoryStack(state, 'potions-a', 10, 'dagger'), 'DUPLICATE_ENTRY_REF');
  });

  it('merges the chosen ref, rejects versions and max overflow, and is deterministic', () => {
    const state = { entries: [stack('a', 10), stack('b', 5), instance('dagger')] } satisfies CoreV1InventoryState;
    const merged = expectOk(mergeInventoryStacks(state, 'b', 'a'));
    expect(merged.inventory.entries.map((entry) => entry.entryRef)).toEqual(['b', 'dagger']);
    expect(merged.inventory.entries[0]).toMatchObject({ entryRef: 'b', quantity: 15 });
    expectInvalid(mergeInventoryStacks({ entries: [stack('v1', 2, 1), stack('v2', 2, 2)] }, 'v1', 'v2'), 'CONTENT_VERSION_MATCH');
    expectInvalid(mergeInventoryStacks({ entries: [stack('a', 15), stack('b', 6)] }, 'a', 'b'), 'MAX_STACK');
  });

  it('keeps v1 instances and stacks unchanged when a v2 reference exists', () => {
    const state = { entries: [stack('v1', 5, 1), stack('v2', 5, 2)] } satisfies CoreV1InventoryState;
    const validated = expectOk(validateCoreV1InventoryState(state));
    expect(validated.entries.map((entry) => entry.contentVersion.versionNumber)).toEqual([1, 2]);
  });
});

describe('core-v1 inventory weight and encumbrance', () => {
  it('calculates empty, simple and stack weight without double-counting equipped items', () => {
    expect(expectOk(calculateInventoryWeight({ entries: [] })).totalCarriedWeight).toBe(0);
    const result = expectOk(calculateInventoryWeight({ entries: [instance('equipped', 'equipped'), stack('potions', 3)] }));
    expect(result.totalCarriedWeight).toBe(16);
    expect(result.entryWeights).toEqual([
      { entryRef: 'equipped', quantity: 1, weight: 10 },
      { entryRef: 'potions', quantity: 3, weight: 6 },
    ]);
    expect(expectOk(calculateInventoryWeight({ entries: [instance('spent', 'consumed')] }))).toMatchObject({ totalCarriedWeight: 0 });
  });

  it('rejects entry product and total overflow', () => {
    const unsafeSpec = stackSpec(2, Number.MAX_SAFE_INTEGER);
    expectInvalid(calculateInventoryWeight({ entries: [stack('unsafe', 2, 1, unsafeSpec)] }), 'SAFE_INTEGER_WEIGHT');
    expectInvalid(calculateInventoryWeight({
      entries: [
        { ...instance('a'), inventorySpec: uniqueSpec(Number.MAX_SAFE_INTEGER) },
        { ...instance('b'), inventorySpec: uniqueSpec(1) },
      ],
    }), 'SAFE_INTEGER_WEIGHT');
  });

  it.each([
    [0, 0, 'normal', 0, true],
    [1, 0, 'overloaded', 2500, false],
    [70, 100, 'normal', 0, true],
    [71, 100, 'encumbered', 1000, true],
    [100, 100, 'encumbered', 1000, true],
    [101, 100, 'heavily_encumbered', 2500, true],
    [125, 100, 'heavily_encumbered', 2500, true],
    [126, 100, 'overloaded', 2500, false],
  ] as const)('maps weight %i/capacity %i to %s', (weight, capacity, state, penaltyBps, allowed) => {
    expect(expectOk(calculateInventoryEncumbrance(weight, capacity))).toMatchObject({
      state, penaltyBps, canStartAttackOrMovement: allowed,
    });
  });

  it('uses integer BPS and supports safe maximum values without threshold overflow', () => {
    expect(expectOk(calculateInventoryEncumbrance(1, 3)).ratioBps).toBe(3333);
    expect(expectOk(calculateInventoryEncumbrance(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).state).toBe('encumbered');
    expectInvalid(calculateInventoryEncumbrance(Number.MAX_SAFE_INTEGER + 1, 1), 'SAFE_INTEGER');
  });
});

import { describe, expect, it } from 'vitest';
import { loadActorInventoryMechanicalInputs } from './inventory-mechanical-inputs.js';

const actorId = '10000000-0000-0000-0000-000000000001';
const entryId = '20000000-0000-0000-0000-000000000001';
const inventoryRulesVersionId = '30000000-0000-0000-0000-000000000001';

function persistedRows() {
  const inventorySpec = {
    schemaVersion: 1, rulesetCode: 'core-v1', inventoryRulesCode: 'core-v1-inventory-v1',
    unitWeight: 12, stacking: { mode: 'unique' }, equipmentSlots: ['chest', 'body'],
  };
  const profile = {
    schemaVersion: 1, rulesetCode: 'core-v1', profileMode: 'mechanical', contentKind: 'item',
    code: 'test-harness', name: 'Arnês de Teste', tier: 1, rarity: 'common',
    activation: { type: 'passive' }, cost: { type: 'none' },
    passiveModifiers: [{ target: 'carryingCapacity', amount: 2, sourceRule: 'equipped_content' }],
  };
  const entries = [{
    id: entryId, actorId, entryRef: 'greatsword-1', contentVersionId: '40000000-0000-0000-0000-000000000001',
    inventoryRulesVersionId, entryKind: 'INSTANCE', quantity: 1, instanceLifecycle: 'AVAILABLE', customName: null,
    contentVersion: {
      versionNumber: 1, inventorySpec, inventorySpecHash: 'a'.repeat(64), inventoryRulesVersionId, profile,
      contentDefinition: { campaignId: null, contentType: 'ITEM', code: 'test-harness' },
    },
    equipmentSlots: [
      { inventoryEntryId: entryId, slotRef: 'CHEST' },
      { inventoryEntryId: entryId, slotRef: 'BODY' },
    ],
  }];
  const slots = [
    { inventoryEntryId: entryId, slotRef: 'CHEST' },
    { inventoryEntryId: entryId, slotRef: 'BODY' },
  ];
  return { entries, slots };
}

function client(rows = persistedRows()) {
  return {
    inventoryEntry: { findMany: () => Promise.resolve(rows.entries) },
    actorEquipmentSlot: { findMany: () => Promise.resolve(rows.slots) },
  };
}

describe('persisted inventory mechanical projection', () => {
  it('derives equipped state from slots and counts a multisslot item once', async () => {
    const rows = persistedRows();
    const before = JSON.stringify(rows);
    const result = await loadActorInventoryMechanicalInputs(client(rows) as never, actorId);
    expect(result.inventory.entries).toEqual([expect.objectContaining({ entryRef: 'greatsword-1', state: 'equipped' })]);
    expect(result.loadout.slots.filter((slot) => slot.entryRef === 'greatsword-1').map((slot) => slot.slotRef)).toEqual(['chest', 'body']);
    expect(result.totalCarriedWeight).toBe(12);
    expect(result.modifiers).toEqual([{ target: 'carryingCapacity', value: 2, source: { type: 'equipment', ref: 'greatsword-1' } }]);
    expect(result.equipmentHashInput).toHaveLength(1);
    expect(JSON.stringify(result.equipmentHashInput)).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27}/i);
    expect(JSON.stringify(rows)).toBe(before);
  });

  it('returns a sanitized integrity error for a drifted inventory rules link', async () => {
    const rows = persistedRows();
    rows.entries[0]!.inventoryRulesVersionId = '50000000-0000-0000-0000-000000000001';
    await expect(loadActorInventoryMechanicalInputs(client(rows) as never, actorId))
      .rejects.toThrow('Actor inventory state failed integrity validation');
  });
});

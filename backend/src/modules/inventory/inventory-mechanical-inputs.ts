import { normalizeEnum } from '../../shared/http/normalize-enum.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  calculateInventoryWeight,
  collectEquippedModifiers,
  createCoreV1EmptyEquipmentLoadout,
  validateCoreV1InventoryState,
  validateEquipmentLoadout,
  type CoreV1CollectedEquipmentModifier,
  type CoreV1EquipmentLoadout,
  type CoreV1InventoryState,
} from '../rules/core-v1/index.js';

export type InventoryMechanicalInputsClient = Pick<
  Prisma.TransactionClient,
  'inventoryEntry' | 'actorEquipmentSlot'
>;

export interface ActorInventoryMechanicalInputs {
  inventory: CoreV1InventoryState;
  loadout: CoreV1EquipmentLoadout;
  totalCarriedWeight: number;
  modifiers: readonly CoreV1CollectedEquipmentModifier[];
  equipmentHashInput: readonly {
    entryRef: string;
    contentType: string;
    code: string;
    versionNumber: number;
    inventorySpecHash: string;
    passiveModifiers: readonly { target: string; amount: number; sourceRule: string }[];
  }[];
}

function integrityError(): Error {
  return new Error('Actor inventory state failed integrity validation');
}

export async function loadActorInventoryMechanicalInputs(
  client: InventoryMechanicalInputsClient,
  actorId: string,
): Promise<ActorInventoryMechanicalInputs> {
  const rows = await client.inventoryEntry.findMany({
    where: { actorId },
    include: { contentVersion: { include: { contentDefinition: true } }, equipmentSlots: true },
    orderBy: { entryRef: 'asc' },
  });
  const slotRows = await client.actorEquipmentSlot.findMany({ where: { actorId }, orderBy: { slotRef: 'asc' } });
  const equippedRefs = new Set(slotRows.map((slot) => slot.inventoryEntryId));
  const entries = rows.map((row) => {
    const version = row.contentVersion;
    if (version.inventorySpec === null || version.inventorySpecHash === null
      || version.inventoryRulesVersionId === null || version.inventoryRulesVersionId !== row.inventoryRulesVersionId) {
      throw integrityError();
    }
    const contentVersion = {
      scope: version.contentDefinition.campaignId === null ? 'world' as const : 'campaign' as const,
      contentType: normalizeEnum(version.contentDefinition.contentType),
      code: version.contentDefinition.code,
      versionNumber: version.versionNumber,
    };
    if (row.entryKind === 'STACK') {
      return {
        entryKind: 'stack' as const, entryRef: row.entryRef, contentVersion,
        inventorySpec: version.inventorySpec, profile: version.profile, quantity: row.quantity,
      };
    }
    if (row.instanceLifecycle === null) throw integrityError();
    return {
      entryKind: 'instance' as const, entryRef: row.entryRef, contentVersion,
      inventorySpec: version.inventorySpec, profile: version.profile,
      ...(row.customName === null ? {} : { customName: row.customName }),
      state: equippedRefs.has(row.id) ? 'equipped' as const : normalizeEnum(row.instanceLifecycle),
    };
  });
  const validatedInventory = validateCoreV1InventoryState({ entries });
  if (!validatedInventory.ok) throw integrityError();
  const slotByRef = new Map(slotRows.map((slot) => [normalizeEnum(slot.slotRef), slot]));
  const loadout = createCoreV1EmptyEquipmentLoadout();
  const projectedLoadout = {
    slots: loadout.slots.map((slot) => {
      const persisted = slotByRef.get(slot.slotRef);
      if (persisted === undefined) return slot;
      const entry = rows.find((candidate) => candidate.id === persisted.inventoryEntryId);
      if (entry === undefined) throw integrityError();
      return { ...slot, entryRef: entry.entryRef };
    }),
  };
  const validatedLoadout = validateEquipmentLoadout(validatedInventory.value, projectedLoadout);
  if (!validatedLoadout.ok) throw integrityError();
  const weight = calculateInventoryWeight(validatedInventory.value);
  const modifiers = collectEquippedModifiers(validatedInventory.value, validatedLoadout.value);
  if (!weight.ok || !modifiers.ok) throw integrityError();
  const equippedEntryRefs = [...new Set(validatedLoadout.value.slots.flatMap((slot) => slot.entryRef === null ? [] : [slot.entryRef]))].sort();
  const equipmentHashInput = equippedEntryRefs.map((entryRef) => {
    const row = rows.find((candidate) => candidate.entryRef === entryRef);
    if (row === undefined || row.contentVersion.inventorySpecHash === null) throw integrityError();
    const profile = row.contentVersion.profile as { passiveModifiers?: Array<{ target: string; amount: number; sourceRule: string }> } | null;
    return {
      entryRef,
      contentType: normalizeEnum(row.contentVersion.contentDefinition.contentType),
      code: row.contentVersion.contentDefinition.code,
      versionNumber: row.contentVersion.versionNumber,
      inventorySpecHash: row.contentVersion.inventorySpecHash,
      passiveModifiers: [...(profile?.passiveModifiers ?? [])]
        .map((modifier) => ({ target: modifier.target, amount: modifier.amount, sourceRule: modifier.sourceRule }))
        .sort((left, right) => left.target.localeCompare(right.target) || left.amount - right.amount || left.sourceRule.localeCompare(right.sourceRule)),
    };
  });
  return {
    inventory: validatedInventory.value,
    loadout: validatedLoadout.value,
    totalCarriedWeight: weight.value.totalCarriedWeight,
    modifiers: modifiers.value,
    equipmentHashInput,
  };
}

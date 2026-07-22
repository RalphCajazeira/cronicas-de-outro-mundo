import {
  ActorEquipmentSlotRef,
  ContentType,
  InventoryEntryKind,
  InventoryInstanceLifecycle,
  Prisma,
} from '../../generated/prisma/client.js';
import { resolveScope, type DbClient } from '../../shared/database/game-scope.js';
import { NotFoundError } from '../../shared/errors/app-error.js';
import { normalizeEnum } from '../../shared/http/normalize-enum.js';
import { scopedActorKey } from '../actors/actors.repository.js';
import {
  loadActorMechanicalSheet,
  recomputeActorDerivedSnapshot,
} from '../actors/actor-mechanics.service.js';
import {
  addInventoryEntry,
  calculateInventoryEncumbrance,
  equipItem,
  mergeInventoryStacks,
  removeInventoryQuantity,
  splitInventoryStack,
  unequipItem,
  validateCoreV1InventoryState,
  type CoreV1EquipmentRequirementContext,
  type CoreV1InventoryState,
} from '../rules/core-v1/index.js';
import type { ValidationIssue } from '../rules/core-v1/core-v1.types.js';
import type { ManageActorInventoryInput } from '../gpt/gpt.schemas.js';
import { loadActorInventoryMechanicalInputs } from './inventory-mechanical-inputs.js';
import type { ActorInventoryMechanicalInputs } from './inventory-mechanical-inputs.js';
import { InventoryOperationRejectedError, InventoryStateVersionRejectedError } from './inventory.errors.js';
import { assertActorsMutableOutsideEncounter } from '../encounters/encounter-authority-guard.js';

type InventoryClient = DbClient;

const slotToDatabase = {
  main_hand: ActorEquipmentSlotRef.MAIN_HAND,
  off_hand: ActorEquipmentSlotRef.OFF_HAND,
  head: ActorEquipmentSlotRef.HEAD,
  chest: ActorEquipmentSlotRef.CHEST,
  hands: ActorEquipmentSlotRef.HANDS,
  legs: ActorEquipmentSlotRef.LEGS,
  feet: ActorEquipmentSlotRef.FEET,
  body: ActorEquipmentSlotRef.BODY,
  accessory_1: ActorEquipmentSlotRef.ACCESSORY_1,
  accessory_2: ActorEquipmentSlotRef.ACCESSORY_2,
} as const;

const inventoryContentTypeToDatabase = {
  weapon: ContentType.WEAPON,
  armor: ContentType.ARMOR,
  shield: ContentType.SHIELD,
  clothing: ContentType.CLOTHING,
  item: ContentType.ITEM,
  consumable: ContentType.CONSUMABLE,
  material: ContentType.MATERIAL,
  other: ContentType.OTHER,
} as const;

function operationError(issues: readonly ValidationIssue[] = []): InventoryOperationRejectedError {
  return new InventoryOperationRejectedError(issues);
}

async function resolveActor(client: InventoryClient, actorRef: string, input: ManageActorInventoryInput) {
  const scope = await resolveScope(client, input);
  const actor = await client.actor.findUnique({
    where: scopedActorKey(scope.campaign.id, actorRef),
    select: { id: true, code: true, level: true, inventoryStateVersion: true, mechanicsStateVersion: true },
  });
  if (actor === null) throw new NotFoundError('Actor');
  return { ...scope, actor };
}

export async function loadActorInventoryDto(client: InventoryClient, actorId: string, actorRef: string) {
  const actor = await client.actor.findUnique({ where: { id: actorId }, select: { inventoryStateVersion: true } });
  if (actor === null) throw new NotFoundError('Actor');
  const inputs = await loadActorInventoryMechanicalInputs(client, actorId);
  const sheet = await loadActorMechanicalSheet(client, actorId);
  const encumbrance = calculateInventoryEncumbrance(inputs.totalCarriedWeight, sheet.secondaryAttributes.carryingCapacity);
  if (!encumbrance.ok) throw operationError(encumbrance.issues);
  const rows = await client.inventoryEntry.findMany({
    where: { actorId },
    include: { contentVersion: { include: { contentDefinition: true } }, equipmentSlots: true },
    orderBy: { entryRef: 'asc' },
  });
  return {
    actorRef,
    inventoryStateVersion: actor.inventoryStateVersion,
    entries: rows.map((row) => {
      const slots = row.equipmentSlots.map((slot) => normalizeEnum(slot.slotRef)).sort();
      return {
        entryRef: row.entryRef,
        entryKind: normalizeEnum(row.entryKind),
        ...(row.entryKind === InventoryEntryKind.INSTANCE
          ? { state: slots.length > 0 ? 'equipped' : normalizeEnum(row.instanceLifecycle ?? InventoryInstanceLifecycle.AVAILABLE) }
          : {}),
        quantity: row.quantity,
        ...(row.customName === null ? {} : { customName: row.customName }),
        content: {
          scope: row.contentVersion.contentDefinition.campaignId === null ? 'world' : 'campaign',
          contentType: normalizeEnum(row.contentVersion.contentDefinition.contentType),
          code: row.contentVersion.contentDefinition.code,
          versionNumber: row.contentVersion.versionNumber,
          name: row.contentVersion.name,
        },
        inventorySpec: row.contentVersion.inventorySpec,
        equippedSlots: slots,
      };
    }),
    loadout: inputs.loadout.slots.map((slot) => ({ slotRef: slot.slotRef, entryRef: slot.entryRef })),
    weight: {
      totalCarriedWeight: inputs.totalCarriedWeight,
      carryingCapacity: sheet.secondaryAttributes.carryingCapacity,
    },
    encumbrance: {
      ratioBps: encumbrance.value.ratioBps,
      state: encumbrance.value.state,
      penaltyBps: encumbrance.value.penaltyBps,
      canStartAttackOrMovement: encumbrance.value.canStartAttackOrMovement,
    },
  };
}

export async function loadActorInventorySummary(client: InventoryClient, actorId: string) {
  const inputs = await loadActorInventoryMechanicalInputs(client, actorId);
  const sheet = await loadActorMechanicalSheet(client, actorId);
  return projectActorInventorySummary(inputs, sheet.secondaryAttributes.carryingCapacity);
}

export function projectActorInventorySummary(inputs: ActorInventoryMechanicalInputs, carryingCapacity: number) {
  const encumbrance = calculateInventoryEncumbrance(inputs.totalCarriedWeight, carryingCapacity);
  if (!encumbrance.ok) throw operationError(encumbrance.issues);
  return {
    entryCount: inputs.inventory.entries.length,
    equippedCount: new Set(inputs.loadout.slots.flatMap((slot) => slot.entryRef === null ? [] : [slot.entryRef])).size,
    totalCarriedWeight: inputs.totalCarriedWeight,
    encumbranceState: encumbrance.value.state,
  };
}

async function requirementContext(client: InventoryClient, actorId: string): Promise<CoreV1EquipmentRequirementContext> {
  const actor = await client.actor.findUnique({ where: { id: actorId }, select: { level: true } });
  if (actor === null) throw new NotFoundError('Actor');
  const sheet = await loadActorMechanicalSheet(client, actorId);
  const known = await client.actorContent.findMany({
    where: { actorId, state: { in: ['KNOWN', 'MASTERED'] } },
    include: { contentDefinition: true },
  });
  const inputs = await loadActorInventoryMechanicalInputs(client, actorId);
  const equipped = inputs.inventory.entries.filter((entry) => entry.entryKind === 'instance' && entry.state === 'equipped');
  return {
    level: actor.level,
    primaryAttributes: sheet.primaryAttributes,
    knownContentRefs: known.map((link) => ({
      contentKind: normalizeEnum(link.contentDefinition.contentType) as CoreV1EquipmentRequirementContext['knownContentRefs'][number]['contentKind'],
      code: link.contentDefinition.code,
    })),
    equippedWeaponTags: equipped.flatMap((entry) => entry.contentVersion.contentType === 'weapon'
      ? [...(entry.profile?.profileMode === 'mechanical' && entry.profile.contentKind === 'weapon'
        ? entry.profile.weaponTags ?? []
        : []), ...(entry.profile?.tags ?? [])]
      : []),
    equippedEquipmentTags: equipped.flatMap((entry) => [...(entry.profile?.tags ?? [])]),
    rulesetCode: 'core-v1',
  };
}

async function exactContentVersion(client: InventoryClient, scope: Awaited<ReturnType<typeof resolveActor>>, input: ManageActorInventoryInput) {
  const reference = input.contentRef;
  if (reference === undefined) throw operationError();
  const definition = await client.contentDefinition.findFirst({
    where: {
      worldId: scope.world.id,
      campaignId: reference.scope === 'campaign' ? scope.campaign.id : null,
      contentType: inventoryContentTypeToDatabase[reference.contentType],
      code: reference.code,
    },
    include: { versions: { where: { versionNumber: reference.versionNumber }, take: 1 } },
  });
  const version = definition?.versions[0];
  if (definition === null || definition === undefined || version === undefined) throw new NotFoundError('Content version');
  if (version.rulesetVersionId !== scope.campaign.rulesetVersionId
    || version.inventorySpec === null || version.inventorySpecHash === null || version.inventoryRulesVersionId === null) {
    throw operationError();
  }
  return { definition, version };
}

async function persistState(
  client: InventoryClient,
  actorId: string,
  before: CoreV1InventoryState,
  after: CoreV1InventoryState,
  loadout: Awaited<ReturnType<typeof loadActorInventoryMechanicalInputs>>['loadout'],
  grantVersion: Awaited<ReturnType<typeof exactContentVersion>> | null,
  splitSourceRef: string | null,
) {
  const rows = await client.inventoryEntry.findMany({ where: { actorId } });
  const byRef = new Map(rows.map((row) => [row.entryRef, row]));
  const beforeByRef = new Map(before.entries.map((entry) => [entry.entryRef, entry]));
  for (const row of rows) {
    if (!after.entries.some((entry) => entry.entryRef === row.entryRef)) await client.inventoryEntry.delete({ where: { id: row.id } });
  }
  for (const entry of after.entries) {
    const row = byRef.get(entry.entryRef);
    const lifecycle = entry.entryKind === 'instance'
      ? (entry.state === 'equipped' ? 'available' : entry.state).toUpperCase() as InventoryInstanceLifecycle
      : null;
    if (row !== undefined) {
      const previous = beforeByRef.get(entry.entryRef);
      if (previous === undefined || JSON.stringify(previous) !== JSON.stringify(entry)) {
        await client.inventoryEntry.update({
          where: { id: row.id },
          data: { quantity: entry.entryKind === 'stack' ? entry.quantity : 1, instanceLifecycle: lifecycle },
        });
      }
      continue;
    }
    let sourceVersion = grantVersion?.version ?? null;
    if (sourceVersion === null && splitSourceRef !== null) {
      const splitRow = byRef.get(splitSourceRef);
      if (splitRow === undefined) throw operationError();
      const version = await client.contentVersion.findUnique({ where: { id: splitRow.contentVersionId } });
      if (version === null) throw operationError();
      sourceVersion = version;
    }
    if (sourceVersion === null || sourceVersion.inventoryRulesVersionId === null) throw operationError();
    await client.inventoryEntry.create({
      data: {
        actorId,
        entryRef: entry.entryRef,
        contentVersionId: sourceVersion.id,
        inventoryRulesVersionId: sourceVersion.inventoryRulesVersionId,
        entryKind: entry.entryKind === 'instance' ? InventoryEntryKind.INSTANCE : InventoryEntryKind.STACK,
        quantity: entry.entryKind === 'stack' ? entry.quantity : 1,
        instanceLifecycle: lifecycle,
        customName: entry.entryKind === 'instance' ? entry.customName ?? null : null,
      },
    });
  }
  const finalRows = await client.inventoryEntry.findMany({ where: { actorId }, select: { id: true, entryRef: true } });
  const finalByRef = new Map(finalRows.map((row) => [row.entryRef, row.id]));
  const persistedSlots = await client.actorEquipmentSlot.findMany({ where: { actorId } });
  const desired = new Map(loadout.slots.flatMap((slot) => slot.entryRef === null ? [] : [[slot.slotRef, slot.entryRef] as const]));
  for (const slot of persistedSlots) {
    const slotRef = normalizeEnum(slot.slotRef) as keyof typeof slotToDatabase;
    if (desired.get(slotRef) !== finalRows.find((row) => row.id === slot.inventoryEntryId)?.entryRef) {
      await client.actorEquipmentSlot.delete({ where: { id: slot.id } });
    }
  }
  const remaining = await client.actorEquipmentSlot.findMany({ where: { actorId } });
  const occupied = new Set(remaining.map((slot) => normalizeEnum(slot.slotRef)));
  for (const [slotRef, entryRef] of desired) {
    if (occupied.has(slotRef)) continue;
    const inventoryEntryId = finalByRef.get(entryRef);
    if (inventoryEntryId === undefined) throw operationError();
    await client.actorEquipmentSlot.create({ data: { actorId, slotRef: slotToDatabase[slotRef], inventoryEntryId } });
  }
}

export async function manageActorInventory(
  client: InventoryClient,
  actorRef: string,
  input: ManageActorInventoryInput,
  options: { readonly projection?: 'full' | 'state_version' } = {},
) {
  const scope = await resolveActor(client, actorRef, input);
  if (input.operation === 'get') return loadActorInventoryDto(client, scope.actor.id, scope.actor.code);
  await assertActorsMutableOutsideEncounter(client, scope.campaign.id, [scope.actor]);
  await client.$queryRaw(Prisma.sql`SELECT "id" FROM "Actor" WHERE "id" = ${scope.actor.id}::uuid FOR UPDATE`);
  const locked = await client.actor.findUnique({ where: { id: scope.actor.id }, select: { inventoryStateVersion: true } });
  if (locked === null) throw new NotFoundError('Actor');
  if (locked.inventoryStateVersion !== input.expectedInventoryStateVersion) throw new InventoryStateVersionRejectedError();
  const currentInputs = await loadActorInventoryMechanicalInputs(client, scope.actor.id);
  let nextInventory = currentInputs.inventory;
  let nextLoadout = currentInputs.loadout;
  let grantVersion: Awaited<ReturnType<typeof exactContentVersion>> | null = null;
  let splitSourceRef: string | null = null;

  if (input.operation === 'grant') {
    grantVersion = await exactContentVersion(client, scope, input);
    const reference = input.contentRef;
    const spec = grantVersion.version.inventorySpec;
    if (reference === undefined || spec === null || input.quantity === undefined || input.entryRefs === undefined) throw operationError();
    const stacking = (spec as { stacking?: { mode?: string } }).stacking;
    if (stacking?.mode === 'unique') {
      if (input.entryRefs.length !== input.quantity || (input.customName !== undefined && input.quantity !== 1)) throw operationError();
      for (const entryRef of input.entryRefs) {
        const result = addInventoryEntry(nextInventory, {
          entryKind: 'instance',
          entry: {
            entryKind: 'instance', entryRef,
            contentVersion: reference,
            inventorySpec: spec as never,
            profile: grantVersion.version.profile as never,
            state: 'available',
            ...(input.customName === undefined ? {} : { customName: input.customName }),
          },
        });
        if (!result.ok) throw operationError(result.issues);
        nextInventory = result.value.inventory;
      }
    } else {
      const result = addInventoryEntry(nextInventory, {
        entryKind: 'stack', contentVersion: reference, inventorySpec: spec as never,
        profile: grantVersion.version.profile as never, quantity: input.quantity, newEntryRefs: input.entryRefs,
      });
      if (!result.ok) throw operationError(result.issues);
      nextInventory = result.value.inventory;
    }
  } else if (input.operation === 'remove') {
    const result = removeInventoryQuantity(nextInventory, input.entryRef ?? '', input.quantity ?? 0);
    if (!result.ok) throw operationError(result.issues);
    nextInventory = result.value.inventory;
  } else if (input.operation === 'split') {
    splitSourceRef = input.entryRef ?? null;
    const result = splitInventoryStack(nextInventory, input.entryRef ?? '', input.quantity ?? 0, input.newEntryRef ?? '');
    if (!result.ok) throw operationError(result.issues);
    nextInventory = result.value.inventory;
  } else if (input.operation === 'merge') {
    const result = mergeInventoryStacks(nextInventory, input.targetEntryRef ?? '', input.sourceEntryRef ?? '');
    if (!result.ok) throw operationError(result.issues);
    nextInventory = result.value.inventory;
  } else if (input.operation === 'equip') {
    const context = await requirementContext(client, scope.actor.id);
    const result = equipItem(nextInventory, nextLoadout, {
      entryRef: input.entryRef ?? '',
      ...(input.targetSlotRef === undefined ? {} : { targetSlotRef: input.targetSlotRef }),
      ...(input.versatileMode === undefined ? {} : { versatileMode: input.versatileMode }),
    }, context);
    if (!result.ok) throw operationError(result.issues);
    nextInventory = result.value.inventory;
    nextLoadout = result.value.loadout;
  } else if (input.operation === 'unequip') {
    const result = unequipItem(nextInventory, nextLoadout, input.entryRef ?? '');
    if (!result.ok) throw operationError(result.issues);
    nextInventory = result.value.inventory;
    nextLoadout = result.value.loadout;
  } else {
    const entryRef = input.entryRef ?? '';
    const entries = nextInventory.entries.map((entry) => {
      if (entry.entryRef !== entryRef) return entry;
      if (entry.entryKind !== 'instance' || entry.state === 'equipped') throw operationError();
      if (input.operation === 'reserve') {
        if (entry.state !== 'available') throw operationError();
        return { ...entry, state: 'reserved' as const };
      }
      if (input.operation === 'release') {
        if (entry.state !== 'reserved') throw operationError();
        return { ...entry, state: 'available' as const };
      }
      if (['consumed', 'destroyed'].includes(entry.state)) throw operationError();
      return { ...entry, state: 'destroyed' as const };
    });
    if (!entries.some((entry) => entry.entryRef === entryRef)) throw new NotFoundError('Inventory entry');
    const validation = validateCoreV1InventoryState({ entries });
    if (!validation.ok) throw operationError(validation.issues);
    nextInventory = validation.value;
  }

  await persistState(client, scope.actor.id, currentInputs.inventory, nextInventory, nextLoadout, grantVersion, splitSourceRef);
  const updated = await client.actor.updateMany({
    where: { id: scope.actor.id, inventoryStateVersion: locked.inventoryStateVersion },
    data: { inventoryStateVersion: { increment: 1 }, mechanicsStateVersion: { increment: 1 } },
  });
  if (updated.count !== 1) throw new InventoryStateVersionRejectedError();
  await recomputeActorDerivedSnapshot(client, scope.actor.id);
  if (options.projection === 'state_version') {
    return { inventoryStateVersion: locked.inventoryStateVersion + 1 };
  }
  return loadActorInventoryDto(client, scope.actor.id, scope.actor.code);
}

import {
  ActorResourceType,
  ContentType,
} from '../../generated/prisma/client.js';
import {
  reactivateDefeatedActorAfterHpRestoration,
  recomputeActorDerivedSnapshot,
} from '../actors/actor-mechanics.service.js';
import {
  persistActorActiveEffects,
  type ActiveEffectPersistenceOrigin,
} from '../effects/effect-state.service.js';
import type {
  CoreV1ActiveEffectInstance,
  CoreV1EncounterBatchResult,
  CoreV1EncounterState,
} from '../rules/core-v1/index.js';
import { EncounterError } from './encounter.errors.js';
import { canonicalEncounterMechanicalJson } from './encounter-mechanical-json.js';
import {
  loadPersistedEncounterAuthorities,
  type LoadedEncounter,
  type PersistedEncounterAuthority,
} from './encounter-state-loader.js';
import type { EncounterTransaction } from './encounter.repository.js';

const resourceType = {
  hp: ActorResourceType.HP,
  mana: ActorResourceType.MANA,
  sp: ActorResourceType.SP,
} as const;

interface ActorMutationFlags {
  resources: boolean;
  inventory: boolean;
  effects: boolean;
}

export function assertEncounterMutationPreflight(loaded: LoadedEncounter): void {
  const persisted = new Set(loaded.record.participants
    .filter((participant) => participant.actorId !== null)
    .map((participant) => participant.actorRef));
  for (const action of loaded.state.activeActions) {
    const sourcePersisted = persisted.has(action.sourceActorRef);
    if (sourcePersisted) continue;
    const producesPersistentEffect = action.targets.some((target) => persisted.has(target.targetRef))
      && (action.executionPlan.profile?.effects ?? []).some((effect) => (
        effect.type === 'apply_status'
        || effect.type === 'modify_primary_attribute'
        || effect.type === 'modify_secondary_attribute'
        || effect.type === 'grant_reaction'
      ));
    if (producesPersistentEffect) {
      throw new EncounterError('ENCOUNTER_EPHEMERAL_MUTATION_UNSUPPORTED');
    }
  }
}

async function persistResources(
  transaction: EncounterTransaction,
  authority: PersistedEncounterAuthority,
  before: CoreV1EncounterState['participants'][number],
  after: CoreV1EncounterState['participants'][number],
): Promise<boolean> {
  let persisted = false;
  for (const key of Object.keys(resourceType) as Array<keyof typeof resourceType>) {
    const beforeValue = before.resources[key].current;
    const afterValue = after.resources[key].current;
    if (beforeValue === afterValue) continue;
    const expectedVersion = authority.sheet.resources[key].stateVersion;
    const changed = await transaction.actorResource.updateMany({
      where: {
        actorId: authority.actor.id,
        type: resourceType[key],
        current: beforeValue,
        stateVersion: expectedVersion,
      },
      data: { current: afterValue, stateVersion: { increment: 1 } },
    });
    if (changed.count !== 1) throw new EncounterError('ENCOUNTER_RESOURCE_DRIFT');
    persisted = true;
    if (key === 'hp') {
      await reactivateDefeatedActorAfterHpRestoration(
        transaction, authority.actor.id, beforeValue, afterValue,
      );
    }
  }
  return persisted;
}

async function consumeInventoryEntry(
  transaction: EncounterTransaction,
  actorId: string,
  entryRef: string,
): Promise<void> {
  const entry = await transaction.inventoryEntry.findUnique({
    where: { actorId_entryRef: { actorId, entryRef } },
  });
  if (entry === null) throw new EncounterError('ENCOUNTER_INVENTORY_DRIFT');
  if (entry.entryKind === 'STACK') {
    const changed = entry.quantity === 1
      ? await transaction.inventoryEntry.deleteMany({ where: { id: entry.id, quantity: 1 } })
      : await transaction.inventoryEntry.updateMany({
        where: { id: entry.id, quantity: entry.quantity },
        data: { quantity: { decrement: 1 } },
      });
    if (changed.count !== 1) throw new EncounterError('ENCOUNTER_INVENTORY_DRIFT');
  } else {
    const changed = await transaction.inventoryEntry.updateMany({
      where: { id: entry.id, instanceLifecycle: 'AVAILABLE' },
      data: { instanceLifecycle: 'CONSUMED' },
    });
    if (changed.count !== 1) throw new EncounterError('ENCOUNTER_INVENTORY_DRIFT');
  }
}

async function contentVersionId(
  transaction: EncounterTransaction,
  loaded: LoadedEncounter,
  reference: CoreV1ActiveEffectInstance['sourceContent'],
): Promise<string> {
  const definition = await transaction.contentDefinition.findFirst({
    where: {
      worldId: loaded.record.campaign.worldId,
      campaignId: reference.scope === 'campaign' ? loaded.record.campaignId : null,
      contentType: reference.contentType.toUpperCase() as ContentType,
      code: reference.code,
    },
    include: {
      versions: {
        where: { versionNumber: reference.versionNumber },
        select: { id: true, rulesetVersionId: true },
        take: 1,
      },
    },
  });
  const version = definition?.versions[0];
  if (version === undefined || version.rulesetVersionId !== loaded.record.rulesetVersionId) {
    throw new EncounterError('ENCOUNTER_EFFECTS_DRIFT');
  }
  return version.id;
}

async function effectOrigins(
  transaction: EncounterTransaction,
  loaded: LoadedEncounter,
  targetActorId: string,
  effects: readonly CoreV1ActiveEffectInstance[],
): Promise<ReadonlyMap<string, ActiveEffectPersistenceOrigin>> {
  const existing = await transaction.activeEffect.findMany({ where: { targetActorId } });
  const targetRef = [...loaded.authorities].find(([, authority]) => authority.actor.id === targetActorId)?.[0];
  const beforeEffects = new Map(
    loaded.state.participants.find((participant) => participant.actorRef === targetRef)
      ?.activeEffects.map((effect) => [effect.effectRef, effect]) ?? [],
  );
  const desiredByRef = new Map(effects.map((effect) => [effect.effectRef, effect]));
  const existingByRef = new Map(existing.map((row) => [row.effectRef, row]));
  const origins = new Map<string, ActiveEffectPersistenceOrigin>();
  for (const row of existing) {
    const protectedOwnership = row.durationType === 'ENCOUNTER' && row.originEncounterId !== loaded.record.id;
    if (protectedOwnership) {
      const beforeEffect = beforeEffects.get(row.effectRef);
      const desiredEffect = desiredByRef.get(row.effectRef);
      if (beforeEffect === undefined || desiredEffect === undefined
        || canonicalEncounterMechanicalJson(beforeEffect) !== canonicalEncounterMechanicalJson(desiredEffect)) {
        throw new EncounterError('ENCOUNTER_EFFECT_OWNERSHIP_CONFLICT');
      }
    }
    origins.set(row.effectRef, {
      sourceActorId: row.sourceActorId,
      sourceContentVersionId: row.sourceContentVersionId,
      effectContentVersionId: row.effectContentVersionId,
      effectRulesVersionId: row.effectRulesVersionId,
      originEncounterId: row.originEncounterId,
    });
  }
  const rules = await transaction.effectRulesVersion.findFirst({
    where: { rulesetVersionId: loaded.record.rulesetVersionId },
    select: { id: true },
  });
  if (rules === null) throw new EncounterError('ENCOUNTER_EFFECTS_DRIFT');
  for (const effect of effects) {
    const existingOrigin = origins.get(effect.effectRef);
    if (existingOrigin !== undefined) {
      const existingRow = existingByRef.get(effect.effectRef);
      if (existingRow === undefined
        || (existingRow.durationType === 'ENCOUNTER') !== (effect.durationState.type === 'encounter')) {
        throw new EncounterError('ENCOUNTER_EFFECT_OWNERSHIP_CONFLICT');
      }
      continue;
    }
    const source = loaded.authorities.get(effect.sourceActorRef);
    if (source === undefined) throw new EncounterError('ENCOUNTER_EPHEMERAL_MUTATION_UNSUPPORTED');
    const sourceContentVersionId = await contentVersionId(transaction, loaded, effect.sourceContent);
    const effectContentVersionId = effect.payload.type === 'status'
      ? await contentVersionId(transaction, loaded, effect.payload.contentVersion)
      : null;
    origins.set(effect.effectRef, {
      sourceActorId: source.actor.id,
      sourceContentVersionId,
      effectContentVersionId,
      effectRulesVersionId: rules.id,
      originEncounterId: effect.durationState.type === 'encounter' ? loaded.record.id : null,
    });
  }
  return origins;
}

export function reconcileEncounterParticipant(
  participant: CoreV1EncounterState['participants'][number],
  authority: PersistedEncounterAuthority,
) {
  const sheet = authority.sheet;
  return {
    ...participant,
    actorStateVersion: sheet.mechanicsStateVersion,
    mechanicsStateVersion: sheet.mechanicsStateVersion,
    inventoryStateVersion: sheet.inventoryStateVersion,
    effectsStateVersion: sheet.effectsStateVersion,
    primaryAttributes: sheet.primaryAttributes,
    resources: {
      ...participant.resources,
      hp: { current: sheet.resources.hp.current, maximum: sheet.resources.hp.max },
      mana: { current: sheet.resources.mana.current, maximum: sheet.resources.mana.max },
      sp: { current: sheet.resources.sp.current, maximum: sheet.resources.sp.max },
    },
    secondaryAttributes: {
      ...sheet.secondaryAttributes,
      elementalResistanceBps: sheet.secondaryAttributes.elementalResistanceBps.default ?? 0,
    },
    activeEffects: authority.effects.activeEffects,
    equipmentContext: {
      ...participant.equipmentContext,
      inventory: authority.inventory.inventory,
      loadout: authority.inventory.loadout,
    },
  };
}

function assertPostWriteAuthority(
  after: CoreV1EncounterState['participants'][number],
  authorityBefore: PersistedEncounterAuthority,
  authorityAfter: PersistedEncounterAuthority,
  change: ActorMutationFlags,
): void {
  const orderedEffects = (effects: readonly CoreV1ActiveEffectInstance[]) => (
    [...effects].sort((left, right) => left.effectRef.localeCompare(right.effectRef))
  );
  const mechanicsIncrement = change.inventory || change.effects ? 1 : 0;
  if (authorityAfter.actor.mechanicsStateVersion !== authorityBefore.actor.mechanicsStateVersion + mechanicsIncrement) {
    throw new EncounterError('ENCOUNTER_MECHANICS_DRIFT');
  }
  if (authorityAfter.actor.inventoryStateVersion !== authorityBefore.actor.inventoryStateVersion + (change.inventory ? 1 : 0)) {
    throw new EncounterError('ENCOUNTER_INVENTORY_DRIFT');
  }
  if (authorityAfter.actor.effectsStateVersion !== authorityBefore.actor.effectsStateVersion + (change.effects ? 1 : 0)
    || canonicalEncounterMechanicalJson(orderedEffects(authorityAfter.effects.activeEffects))
      !== canonicalEncounterMechanicalJson(orderedEffects(after.activeEffects))) {
    throw new EncounterError('ENCOUNTER_EFFECTS_DRIFT');
  }
  if (authorityAfter.sheet.resources.hp.current !== after.resources.hp.current
    || authorityAfter.sheet.resources.mana.current !== after.resources.mana.current
    || authorityAfter.sheet.resources.sp.current !== after.resources.sp.current) {
    throw new EncounterError('ENCOUNTER_RESOURCE_DRIFT');
  }
  if (!change.inventory
    && (canonicalEncounterMechanicalJson(authorityAfter.inventory.inventory)
      !== canonicalEncounterMechanicalJson(after.equipmentContext.inventory)
      || canonicalEncounterMechanicalJson(authorityAfter.inventory.loadout)
        !== canonicalEncounterMechanicalJson(after.equipmentContext.loadout))) {
    throw new EncounterError('ENCOUNTER_INVENTORY_DRIFT');
  }
}

export async function applyEncounterMutations(
  transaction: EncounterTransaction,
  loaded: LoadedEncounter,
  afterInput: CoreV1EncounterState,
  batch?: CoreV1EncounterBatchResult,
): Promise<{
  readonly state: CoreV1EncounterState;
  readonly authorities: ReadonlyMap<string, PersistedEncounterAuthority>;
}> {
  assertEncounterMutationPreflight(loaded);
  const flags = new Map<string, ActorMutationFlags>();
  for (const [actorRef, authority] of loaded.authorities) {
    const change = { resources: false, inventory: false, effects: false };
    flags.set(actorRef, change);
    const before = loaded.state.participants.find((participant) => participant.actorRef === actorRef);
    const after = afterInput.participants.find((participant) => participant.actorRef === actorRef);
    if (before === undefined || after === undefined) throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
    change.resources = await persistResources(transaction, authority, before, after);
    if (canonicalEncounterMechanicalJson(before.activeEffects) !== canonicalEncounterMechanicalJson(after.activeEffects)) {
      const origins = await effectOrigins(transaction, loaded, authority.actor.id, after.activeEffects);
      const changed = await persistActorActiveEffects(transaction, authority.actor.id, after.activeEffects, origins);
      flags.get(actorRef)!.effects = changed;
    }
  }
  for (const actionRef of batch?.resolvedActions ?? []) {
    const action = loaded.state.activeActions.find((candidate) => candidate.actionRef === actionRef);
    const entryRef = action?.executionPlan.consumedEntryRef;
    if (entryRef === undefined || action === undefined) continue;
    const authority = loaded.authorities.get(action.sourceActorRef);
    if (authority === undefined) throw new EncounterError('ENCOUNTER_EPHEMERAL_MUTATION_UNSUPPORTED');
    await consumeInventoryEntry(transaction, authority.actor.id, entryRef);
    flags.get(action.sourceActorRef)!.inventory = true;
  }
  for (const [actorRef, change] of flags) {
    if (!change.inventory && !change.effects) continue;
    const authority = loaded.authorities.get(actorRef);
    if (authority === undefined) throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
    const updated = await transaction.actor.updateMany({
      where: {
        id: authority.actor.id,
        mechanicsStateVersion: authority.actor.mechanicsStateVersion,
        inventoryStateVersion: authority.actor.inventoryStateVersion,
        effectsStateVersion: authority.actor.effectsStateVersion,
      },
      data: {
        mechanicsStateVersion: { increment: 1 },
        ...(change.inventory ? { inventoryStateVersion: { increment: 1 } } : {}),
        ...(change.effects ? { effectsStateVersion: { increment: 1 } } : {}),
      },
    });
    if (updated.count !== 1) throw new EncounterError(
      change.inventory ? 'ENCOUNTER_INVENTORY_DRIFT' : 'ENCOUNTER_EFFECTS_DRIFT',
    );
  }
  for (const [actorRef, change] of flags) {
    if (!change.inventory && !change.effects) continue;
    const actor = loaded.authorities.get(actorRef);
    if (actor !== undefined) await recomputeActorDerivedSnapshot(transaction, actor.actor.id);
  }
  if (afterInput.currentTick !== loaded.record.campaign.engineTick) {
    if (afterInput.currentTick < loaded.record.campaign.engineTick) {
      throw new EncounterError('ENCOUNTER_CAMPAIGN_TICK_DRIFT');
    }
    const campaign = await transaction.campaign.updateMany({
      where: {
        id: loaded.record.campaignId,
        engineTick: loaded.record.campaign.engineTick,
        engineStateVersion: loaded.record.campaign.engineStateVersion,
      },
      data: { engineTick: afterInput.currentTick, engineStateVersion: { increment: 1 } },
    });
    if (campaign.count !== 1) throw new EncounterError('ENCOUNTER_CAMPAIGN_TICK_DRIFT');
  }
  const authorityReloadRequired = [...flags.values()].some((change) => (
    change.resources || change.inventory || change.effects
  ));
  const authorities = authorityReloadRequired
    ? await loadPersistedEncounterAuthorities(
      transaction,
      [...loaded.authorities.values()].map((authority) => authority.actor.id),
      afterInput.currentTick,
    )
    : loaded.authorities;
  if (authorityReloadRequired) {
    for (const [actorRef, authorityAfter] of authorities) {
      const authorityBefore = loaded.authorities.get(actorRef);
      const after = afterInput.participants.find((participant) => participant.actorRef === actorRef);
      const change = flags.get(actorRef);
      if (authorityBefore === undefined || after === undefined || change === undefined) {
        throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
      }
      assertPostWriteAuthority(after, authorityBefore, authorityAfter, change);
    }
  }
  const state = {
    ...afterInput,
    participants: afterInput.participants.map((participant) => {
      const authority = authorities.get(participant.actorRef);
      return authority === undefined ? participant : reconcileEncounterParticipant(participant, authority);
    }),
  };
  return { state, authorities };
}

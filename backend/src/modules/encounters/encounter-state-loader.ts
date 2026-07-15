import {
  EncounterCompletionCandidate,
  EncounterLifecycleStatus,
  EncounterOperationKind,
  EncounterStopReason,
  type Prisma,
} from '../../generated/prisma/client.js';
import { loadActorMechanicalSheet } from '../actors/actor-mechanics.service.js';
import { loadActorActiveEffectMechanicalInputs } from '../effects/active-effect-mechanical-inputs.js';
import { loadActorInventoryMechanicalInputs } from '../inventory/inventory-mechanical-inputs.js';
import type { CoreV1EncounterState } from '../rules/core-v1/index.js';
import { validateCoreV1RulesetVersion } from '../rules/ruleset.registry.js';
import {
  createCoreV1EncounterSnapshotHash,
  parseCoreV1EncounterSnapshot,
} from './encounter-state-snapshot.js';
import {
  createEncounterAdapterState,
  parseEncounterAdapterState,
  type EncounterAdapterParticipantStateV1,
  type EncounterAdapterStateV1,
} from './encounter-adapter-state.js';
import { EncounterError } from './encounter.errors.js';
import { canonicalEncounterMechanicalJson } from './encounter-mechanical-json.js';
import { absentEncounterStateHash, type EncounterTransaction } from './encounter.repository.js';

const encounterInclude = {
  campaign: { select: { id: true, worldId: true, rulesetVersionId: true, engineTick: true, engineStateVersion: true } },
  rulesetVersion: {
    select: {
      id: true, rulesetId: true, code: true, revision: true, schemaVersion: true,
      configHash: true, configSnapshot: true, ruleset: { select: { code: true } },
    },
  },
  participants: { orderBy: { actorRef: 'asc' as const } },
  operations: { orderBy: { nextStateVersion: 'desc' as const }, take: 1 },
} satisfies Prisma.EncounterInclude;

export type EncounterRecord = Prisma.EncounterGetPayload<{ include: typeof encounterInclude }>;

export interface PersistedEncounterAuthority {
  readonly actor: {
    readonly id: string;
    readonly code: string;
    readonly campaignId: string;
    readonly level: number;
    readonly mechanicsStateVersion: number;
    readonly inventoryStateVersion: number;
    readonly effectsStateVersion: number;
  };
  readonly sheet: Awaited<ReturnType<typeof loadActorMechanicalSheet>>;
  readonly inventory: Awaited<ReturnType<typeof loadActorInventoryMechanicalInputs>>;
  readonly effects: Awaited<ReturnType<typeof loadActorActiveEffectMechanicalInputs>>;
}

export interface LoadedEncounter {
  readonly record: EncounterRecord;
  readonly state: CoreV1EncounterState;
  readonly adapterState: EncounterAdapterStateV1;
  readonly authorities: ReadonlyMap<string, PersistedEncounterAuthority>;
}

function stopReason(value: CoreV1EncounterState['completionCandidate']): EncounterCompletionCandidate | null {
  if (value === null) return null;
  return {
    party_victory_candidate: EncounterCompletionCandidate.PARTY_VICTORY_CANDIDATE,
    hostile_victory_candidate: EncounterCompletionCandidate.HOSTILE_VICTORY_CANDIDATE,
    stalemate_candidate: EncounterCompletionCandidate.STALEMATE_CANDIDATE,
    cancelled: EncounterCompletionCandidate.CANCELLED,
  }[value];
}

export function databaseCompletionCandidate(value: CoreV1EncounterState['completionCandidate']) {
  return stopReason(value);
}

export function databaseStopReason(value: string | null): EncounterStopReason | null {
  if (value === null) return null;
  const mapped = Object.values(EncounterStopReason).find((entry) => entry.toLowerCase() === value);
  if (mapped === undefined) throw new EncounterError('ENCOUNTER_DENORMALIZED_DRIFT');
  return mapped;
}

export function deriveEncounterLifecycle(
  state: CoreV1EncounterState,
  stopReasonValue: string | null,
): EncounterLifecycleStatus {
  if (state.status === 'completed') return EncounterLifecycleStatus.COMPLETED;
  if (state.status === 'cancelled') return EncounterLifecycleStatus.CANCELLED;
  if (state.status === 'failed') return EncounterLifecycleStatus.FAILED;
  if (state.completionCandidate !== null) return EncounterLifecycleStatus.COMPLETION_PENDING;
  if (stopReasonValue === 'reaction_required') return EncounterLifecycleStatus.AWAITING_REACTION;
  if (stopReasonValue === 'new_intent_required' || state.scheduledEvents.length === 0) {
    return EncounterLifecycleStatus.AWAITING_INTENT;
  }
  return EncounterLifecycleStatus.PROCESSING_PAUSED;
}

export function assertEncounterDenormalized(record: EncounterRecord, state: CoreV1EncounterState): void {
  if (record.snapshotSchemaVersion !== 1
    || record.stateVersion !== state.stateVersion
    || record.currentTick !== state.currentTick
    || record.completionCandidate !== databaseCompletionCandidate(state.completionCandidate)) {
    throw new EncounterError('ENCOUNTER_DENORMALIZED_DRIFT');
  }
  const normalizedStopReason = record.stopReason === null ? null : record.stopReason.toLowerCase();
  const expectedLifecycle = deriveEncounterLifecycle(state, normalizedStopReason);
  const closed = new Set<EncounterLifecycleStatus>([
    EncounterLifecycleStatus.COMPLETED,
    EncounterLifecycleStatus.CANCELLED,
    EncounterLifecycleStatus.FAILED,
  ]).has(record.lifecycleStatus);
  const stopMatchesStatus = state.status === 'completed'
    ? normalizedStopReason === 'encounter_completed'
    : state.status === 'failed'
      ? normalizedStopReason === 'encounter_failed'
      : state.status === 'cancelled'
        ? normalizedStopReason === null && state.completionCandidate === 'cancelled'
        : true;
  if (record.lifecycleStatus !== expectedLifecycle || !stopMatchesStatus
    || (closed ? record.closedAt === null : record.closedAt !== null)) {
    throw new EncounterError('ENCOUNTER_DENORMALIZED_DRIFT');
  }
}

async function assertEncounterOperationChain(
  transaction: EncounterTransaction,
  record: EncounterRecord,
): Promise<void> {
  const operations = await transaction.encounterOperation.findMany({
    where: { encounterId: record.id },
    orderBy: { nextStateVersion: 'asc' },
    select: {
      id: true, operation: true, previousStateVersion: true, nextStateVersion: true,
      inputHash: true, beforeStateHash: true, afterStateHash: true,
      idempotencyRecord: { select: { operation: true, requestHash: true } },
    },
  });
  assertEncounterOperationChainRows(operations, record.stateVersion, record.stateHash, record.operations[0]?.id);
}

export function assertEncounterOperationChainRows(
  operations: readonly {
    readonly id: string;
    readonly operation: EncounterOperationKind;
    readonly previousStateVersion: number;
    readonly nextStateVersion: number;
    readonly inputHash: string;
    readonly beforeStateHash: string;
    readonly afterStateHash: string;
    readonly idempotencyRecord: { readonly operation: string; readonly requestHash: string };
  }[],
  stateVersion: number,
  stateHash: string,
  latestOperationId: string | undefined,
): void {
  if (operations.length === 0) throw new EncounterError('ENCOUNTER_DENORMALIZED_DRIFT');
  for (const [index, operation] of operations.entries()) {
    const previous = operations[index - 1];
    const expectedNamespace = `encounter.${operation.operation.toLowerCase()}`;
    const validIdentity = operation.inputHash === operation.idempotencyRecord.requestHash
      && operation.idempotencyRecord.operation === expectedNamespace;
    const validSequence = index === 0
      ? operation.operation === EncounterOperationKind.CREATE
        && operation.previousStateVersion === 0 && operation.nextStateVersion === 1
        && operation.beforeStateHash === absentEncounterStateHash()
      : operation.operation !== EncounterOperationKind.CREATE
        && operation.previousStateVersion === previous?.nextStateVersion
        && operation.beforeStateHash === previous?.afterStateHash;
    if (!validIdentity || !validSequence) throw new EncounterError('ENCOUNTER_DENORMALIZED_DRIFT');
  }
  const last = operations.at(-1);
  if (last?.id !== latestOperationId || last?.nextStateVersion !== stateVersion
    || last?.afterStateHash !== stateHash) {
    throw new EncounterError('ENCOUNTER_DENORMALIZED_DRIFT');
  }
}

export async function loadPersistedEncounterAuthorities(
  transaction: EncounterTransaction,
  actorIds: readonly string[],
  engineTick: bigint,
): Promise<ReadonlyMap<string, PersistedEncounterAuthority>> {
  const actors = await transaction.actor.findMany({
    where: { id: { in: [...actorIds] } },
    select: {
      id: true, code: true, campaignId: true, level: true, mechanicsStateVersion: true,
      inventoryStateVersion: true, effectsStateVersion: true,
    },
    orderBy: { id: 'asc' },
  });
  if (actors.length !== new Set(actorIds).size) throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
  const loaded: PersistedEncounterAuthority[] = [];
  for (const actor of actors) {
    loaded.push({
      actor,
      sheet: await loadActorMechanicalSheet(transaction, actor.id),
      inventory: await loadActorInventoryMechanicalInputs(transaction, actor.id),
      effects: await loadActorActiveEffectMechanicalInputs(transaction, actor.id, engineTick),
    });
  }
  return new Map(loaded.map((authority) => [authority.actor.code, authority]));
}

export function adapterStateFromAuthorities(
  authorities: ReadonlyMap<string, PersistedEncounterAuthority>,
): EncounterAdapterStateV1 {
  return createEncounterAdapterState([...authorities.values()].map(({ actor, sheet }) => ({
    actorRef: actor.code,
    mechanicsStateVersion: actor.mechanicsStateVersion,
    inventoryStateVersion: actor.inventoryStateVersion,
    effectsStateVersion: actor.effectsStateVersion,
    resourceStateVersions: {
      hp: sheet.resources.hp.stateVersion,
      mana: sheet.resources.mana.stateVersion,
      sp: sheet.resources.sp.stateVersion,
    },
  })));
}

function assertAuthorityVector(
  expected: EncounterAdapterParticipantStateV1,
  authority: PersistedEncounterAuthority | undefined,
): void {
  if (authority === undefined || authority.actor.mechanicsStateVersion !== expected.mechanicsStateVersion) {
    throw new EncounterError('ENCOUNTER_MECHANICS_DRIFT');
  }
  if (authority.actor.inventoryStateVersion !== expected.inventoryStateVersion) {
    throw new EncounterError('ENCOUNTER_INVENTORY_DRIFT');
  }
  if (authority.actor.effectsStateVersion !== expected.effectsStateVersion) {
    throw new EncounterError('ENCOUNTER_EFFECTS_DRIFT');
  }
  const actual = authority.sheet.resources;
  if (actual.hp.stateVersion !== expected.resourceStateVersions.hp
    || actual.mana.stateVersion !== expected.resourceStateVersions.mana
    || actual.sp.stateVersion !== expected.resourceStateVersions.sp) {
    throw new EncounterError('ENCOUNTER_RESOURCE_DRIFT');
  }
}

export async function findEncounterRecord(
  transaction: EncounterTransaction,
  campaignId: string,
  encounterRef: string,
): Promise<EncounterRecord> {
  const record = await transaction.encounter.findUnique({
    where: { campaignId_encounterRef: { campaignId, encounterRef } },
    include: encounterInclude,
  });
  if (record === null) throw new EncounterError('ENCOUNTER_NOT_FOUND');
  return record;
}

export async function validateLoadedEncounter(
  transaction: EncounterTransaction,
  record: EncounterRecord,
): Promise<LoadedEncounter> {
  let state: CoreV1EncounterState;
  try {
    if (createCoreV1EncounterSnapshotHash(record.stateSnapshot) !== record.stateHash) {
      throw new EncounterError('ENCOUNTER_SNAPSHOT_HASH_INVALID');
    }
    state = parseCoreV1EncounterSnapshot(record.stateSnapshot);
  } catch (error) {
    if (error instanceof EncounterError) throw error;
    throw new EncounterError('ENCOUNTER_SNAPSHOT_INVALID', { cause: error });
  }
  assertEncounterDenormalized(record, state);
  if (record.rulesetVersionId !== record.campaign.rulesetVersionId) {
    throw new EncounterError('ENCOUNTER_DENORMALIZED_DRIFT');
  }
  try {
    validateCoreV1RulesetVersion(record.rulesetVersion);
  } catch (error) {
    throw new EncounterError('ENCOUNTER_MECHANICS_DRIFT', { cause: error });
  }
  if (record.currentTick !== record.campaign.engineTick) {
    throw new EncounterError('ENCOUNTER_CAMPAIGN_TICK_DRIFT');
  }
  const latest = record.operations[0];
  if (latest === undefined || latest.nextStateVersion !== record.stateVersion
    || latest.afterStateHash !== record.stateHash || latest.stopReason !== record.stopReason) {
    throw new EncounterError('ENCOUNTER_DENORMALIZED_DRIFT');
  }
  await assertEncounterOperationChain(transaction, record);
  const summary = latest.resultSummary;
  if (summary === null || typeof summary !== 'object' || Array.isArray(summary)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(summary) as object | null)
    || Object.keys(summary).length !== 1 || !Object.hasOwn(summary, 'adapterState')) {
    throw new EncounterError('ENCOUNTER_SNAPSHOT_INVALID');
  }
  let adapterState: EncounterAdapterStateV1;
  try {
    adapterState = parseEncounterAdapterState((summary as Record<string, unknown>).adapterState);
  } catch (error) {
    throw new EncounterError('ENCOUNTER_SNAPSHOT_INVALID', { cause: error });
  }
  const persisted = record.participants.filter((participant) => participant.actorId !== null);
  const snapshotRefs = new Set(state.participants.map((participant) => participant.actorRef));
  if (record.participants.length !== state.participants.length
    || record.participants.some((participant) => !snapshotRefs.has(participant.actorRef))) {
    throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
  }
  if (adapterState.participants.length !== persisted.length) {
    throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
  }
  const persistedActorIds = persisted.map((participant) => participant.actorId as string);
  const versionRows = await transaction.actor.findMany({
    where: { id: { in: persistedActorIds } },
    select: {
      code: true, mechanicsStateVersion: true, inventoryStateVersion: true,
      effectsStateVersion: true, resources: { select: { type: true, stateVersion: true } },
    },
  });
  if (versionRows.length !== persistedActorIds.length) throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
  const adapterByRef = new Map(adapterState.participants.map((participant) => [participant.actorRef, participant]));
  for (const row of versionRows) {
    const expected = adapterByRef.get(row.code);
    if (expected === undefined) throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
    if (row.mechanicsStateVersion !== expected.mechanicsStateVersion) {
      throw new EncounterError('ENCOUNTER_MECHANICS_DRIFT');
    }
    if (row.inventoryStateVersion !== expected.inventoryStateVersion) {
      throw new EncounterError('ENCOUNTER_INVENTORY_DRIFT');
    }
    if (row.effectsStateVersion !== expected.effectsStateVersion) {
      throw new EncounterError('ENCOUNTER_EFFECTS_DRIFT');
    }
    const resources = Object.fromEntries(row.resources.map((resource) => [resource.type.toLowerCase(), resource.stateVersion]));
    if (resources.hp !== expected.resourceStateVersions.hp
      || resources.mana !== expected.resourceStateVersions.mana
      || resources.sp !== expected.resourceStateVersions.sp) {
      throw new EncounterError('ENCOUNTER_RESOURCE_DRIFT');
    }
  }
  let authorities: ReadonlyMap<string, PersistedEncounterAuthority>;
  try {
    authorities = await loadPersistedEncounterAuthorities(
      transaction,
      persistedActorIds,
      record.campaign.engineTick,
    );
  } catch (error) {
    if (error instanceof EncounterError) throw error;
    throw new EncounterError('ENCOUNTER_MECHANICS_DRIFT', { cause: error });
  }
  for (const expected of adapterState.participants) {
    assertAuthorityVector(expected, authorities.get(expected.actorRef));
    const projected = state.participants.find((participant) => participant.actorRef === expected.actorRef);
    const authority = authorities.get(expected.actorRef);
    if (projected === undefined || authority === undefined) throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
    const authoritativeSecondary = {
      ...authority.sheet.secondaryAttributes,
      elementalResistanceBps: authority.sheet.secondaryAttributes.elementalResistanceBps.default ?? 0,
    };
    if (projected.actorStateVersion !== expected.mechanicsStateVersion
      || projected.mechanicsStateVersion !== expected.mechanicsStateVersion
      || canonicalEncounterMechanicalJson(projected.primaryAttributes)
        !== canonicalEncounterMechanicalJson(authority.sheet.primaryAttributes)
      || canonicalEncounterMechanicalJson(projected.secondaryAttributes)
        !== canonicalEncounterMechanicalJson(authoritativeSecondary)) {
      throw new EncounterError('ENCOUNTER_MECHANICS_DRIFT');
    }
    if (projected.inventoryStateVersion !== expected.inventoryStateVersion
      || canonicalEncounterMechanicalJson(projected.equipmentContext.inventory) !== canonicalEncounterMechanicalJson(authority.inventory.inventory)
      || canonicalEncounterMechanicalJson(projected.equipmentContext.loadout) !== canonicalEncounterMechanicalJson(authority.inventory.loadout)) {
      throw new EncounterError('ENCOUNTER_INVENTORY_DRIFT');
    }
    if (projected.effectsStateVersion !== expected.effectsStateVersion
      || canonicalEncounterMechanicalJson(projected.activeEffects) !== canonicalEncounterMechanicalJson(authority.effects.activeEffects)) {
      throw new EncounterError('ENCOUNTER_EFFECTS_DRIFT');
    }
    if (projected.resources.hp.current !== authority.sheet.resources.hp.current
      || projected.resources.hp.maximum !== authority.sheet.resources.hp.max
      || projected.resources.mana.current !== authority.sheet.resources.mana.current
      || projected.resources.mana.maximum !== authority.sheet.resources.mana.max
      || projected.resources.sp.current !== authority.sheet.resources.sp.current
      || projected.resources.sp.maximum !== authority.sheet.resources.sp.max) {
      throw new EncounterError('ENCOUNTER_RESOURCE_DRIFT');
    }
  }
  return { record, state, adapterState, authorities };
}

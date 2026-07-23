import {
  EncounterCompletionCandidate,
  EncounterLifecycleStatus,
  EncounterOperationKind,
  EncounterStopReason,
  type Prisma,
} from '../../generated/prisma/client.js';
import { loadActorMechanicalSheet } from '../actors/actor-mechanics.service.js';
import { normalizeEnum } from '../../shared/http/normalize-enum.js';
import { observeOperationStage } from '../../shared/observability/operation-observability.js';
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
  type EncounterAdapterParticipantStateV1,
  type EncounterAdapterStateV1,
} from './encounter-adapter-state.js';
import { EncounterError } from './encounter.errors.js';
import { canonicalEncounterMechanicalJson } from './encounter-mechanical-json.js';
import {
  parseEncounterConsequenceSummary,
  encounterTerminalEventIdempotencyKey,
  parseEncounterOperationResultSummary,
  parseEncounterTerminalEventPayload,
  type EncounterConsequenceSummaryV1,
} from './encounter-consequence.js';
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
  consequence: { include: { gameEvent: true, encounterOperation: true } },
} satisfies Prisma.EncounterInclude;

export type EncounterRecord = Prisma.EncounterGetPayload<{ include: typeof encounterInclude }>;

export interface PersistedEncounterAuthority {
  readonly actor: {
    readonly id: string;
    readonly code: string;
    readonly campaignId: string;
    readonly role: string | null;
    readonly personality: Prisma.JsonValue;
    readonly metadata: Prisma.JsonValue;
    readonly level: number;
    readonly status: import('../../generated/prisma/client.js').ActorStatus;
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
  readonly consequencesSummary?: EncounterConsequenceSummaryV1;
  readonly context?: import('./encounter.types.js').EncounterContextV1;
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
    const acceptedNamespaces = operation.operation === EncounterOperationKind.SUBMIT_INTENT
      ? new Set([expectedNamespace, 'encounter.resolve_beat'])
      : operation.operation === EncounterOperationKind.CANCEL
        ? new Set([expectedNamespace, 'encounter.abandon'])
        : new Set([expectedNamespace]);
    const validIdentity = operation.inputHash === operation.idempotencyRecord.requestHash
      && acceptedNamespaces.has(operation.idempotencyRecord.operation);
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
      id: true, code: true, campaignId: true, role: true, personality: true, metadata: true,
      level: true, status: true, mechanicsStateVersion: true,
      inventoryStateVersion: true, effectsStateVersion: true,
    },
    orderBy: { id: 'asc' },
  });
  if (actors.length !== new Set(actorIds).size) throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
  const loaded: PersistedEncounterAuthority[] = [];
  for (const actor of actors) {
    loaded.push({
      actor,
      sheet: await observeOperationStage(
        'encounter_mechanics',
        () => loadActorMechanicalSheet(transaction, actor.id),
      ),
      inventory: await observeOperationStage(
        'encounter_inventory',
        () => loadActorInventoryMechanicalInputs(transaction, actor.id),
      ),
      effects: await observeOperationStage(
        'encounter_effects',
        () => loadActorActiveEffectMechanicalInputs(transaction, actor.id, engineTick),
      ),
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

function validateTerminalConsequence(
  record: EncounterRecord,
  operationSummary: ReturnType<typeof parseEncounterOperationResultSummary>,
): EncounterConsequenceSummaryV1 | undefined {
  const closedWithConsequence = record.lifecycleStatus === EncounterLifecycleStatus.COMPLETED
    || record.lifecycleStatus === EncounterLifecycleStatus.CANCELLED;
  if (record.consequence === null) {
    if (operationSummary.consequencesSummary !== undefined) {
      throw new EncounterError('ENCOUNTER_DENORMALIZED_DRIFT');
    }
    return undefined;
  }
  if (!closedWithConsequence || operationSummary.consequencesSummary === undefined) {
    throw new EncounterError('ENCOUNTER_DENORMALIZED_DRIFT');
  }
  const consequence = record.consequence;
  let summary: EncounterConsequenceSummaryV1;
  let eventPayload: ReturnType<typeof parseEncounterTerminalEventPayload>;
  try {
    summary = parseEncounterConsequenceSummary(consequence.resultSummary);
    eventPayload = parseEncounterTerminalEventPayload(consequence.gameEvent.payload);
  } catch (error) {
    throw new EncounterError('ENCOUNTER_SNAPSHOT_INVALID', { cause: error });
  }
  const expectedOutcome = record.lifecycleStatus === EncounterLifecycleStatus.CANCELLED
    ? 'cancelled'
    : ({
      PARTY_VICTORY_CANDIDATE: 'party_victory',
      HOSTILE_VICTORY_CANDIDATE: 'party_defeat',
      STALEMATE_CANDIDATE: 'stalemate',
    } as const)[record.completionCandidate as 'PARTY_VICTORY_CANDIDATE' | 'HOSTILE_VICTORY_CANDIDATE' | 'STALEMATE_CANDIDATE'];
  const expectedOperation = record.lifecycleStatus === EncounterLifecycleStatus.CANCELLED
    ? EncounterOperationKind.CANCEL : EncounterOperationKind.CONFIRM_COMPLETION;
  const expectedActorId = summary.event.actorRef === null ? null
    : record.participants.find((participant) => participant.actorRef === summary.event.actorRef)?.actorId;
  const expectedAffected = summary.actors.map((actor) => actor.actorRef);
  const expectedDefeated = summary.actors
    .filter((actor) => actor.statusAfter === 'defeated')
    .map((actor) => actor.actorRef);
  const expectedRemovedCount = summary.removedEncounterEffects
    .reduce((total, entry) => total + entry.effectRefs.length, 0);
  if (expectedOutcome === undefined
    || summary.outcome !== expectedOutcome
    || normalizeEnum(consequence.outcome) !== expectedOutcome
    || consequence.consequenceSchemaVersion !== 1
    || consequence.rewardPolicyVersion !== null
    || consequence.encounterOperationId !== record.operations[0]?.id
    || consequence.encounterOperation.operation !== expectedOperation
    || consequence.encounterOperation.encounterId !== record.id
    || consequence.gameEvent.campaignId !== record.campaignId
    || consequence.gameEvent.eventType !== summary.event.eventType
    || consequence.gameEvent.actorId !== expectedActorId
    || consequence.gameEvent.idempotencyKey !== encounterTerminalEventIdempotencyKey(record.id)
    || canonicalEncounterMechanicalJson(summary)
      !== canonicalEncounterMechanicalJson(operationSummary.consequencesSummary)
    || eventPayload.encounterRef !== record.encounterRef
    || eventPayload.outcome !== summary.outcome
    || canonicalEncounterMechanicalJson(eventPayload.affectedActorRefs)
      !== canonicalEncounterMechanicalJson(expectedAffected)
    || canonicalEncounterMechanicalJson(eventPayload.defeatedActorRefs)
      !== canonicalEncounterMechanicalJson(expectedDefeated)
    || eventPayload.removedEncounterEffectCount !== expectedRemovedCount) {
    throw new EncounterError('ENCOUNTER_DENORMALIZED_DRIFT');
  }
  return summary;
}

function validateClosedHistoricalVectors(
  state: CoreV1EncounterState,
  adapterState: EncounterAdapterStateV1,
  consequencesSummary: EncounterConsequenceSummaryV1 | undefined,
): void {
  const consequenceByRef = new Map(consequencesSummary?.actors.map((actor) => [actor.actorRef, actor]) ?? []);
  if (consequencesSummary !== undefined
    && consequenceByRef.size !== adapterState.participants.length) {
    throw new EncounterError('ENCOUNTER_DENORMALIZED_DRIFT');
  }
  for (const expected of adapterState.participants) {
    const projected = state.participants.find((participant) => participant.actorRef === expected.actorRef);
    if (projected === undefined
      || projected.actorStateVersion !== expected.mechanicsStateVersion
      || projected.mechanicsStateVersion !== expected.mechanicsStateVersion
      || projected.inventoryStateVersion !== expected.inventoryStateVersion
      || projected.effectsStateVersion !== expected.effectsStateVersion) {
      throw new EncounterError('ENCOUNTER_DENORMALIZED_DRIFT');
    }
    if (consequencesSummary === undefined) continue;
    const consequence = consequenceByRef.get(expected.actorRef);
    if (consequence === undefined
      || consequence.mechanicsStateVersion.after !== expected.mechanicsStateVersion
      || consequence.inventoryStateVersion.after !== expected.inventoryStateVersion
      || consequence.effectsStateVersion.after !== expected.effectsStateVersion
      || consequence.resources.hp.after.stateVersion !== expected.resourceStateVersions.hp
      || consequence.resources.mana.after.stateVersion !== expected.resourceStateVersions.mana
      || consequence.resources.sp.after.stateVersion !== expected.resourceStateVersions.sp
      || consequence.resources.hp.after.current !== projected.resources.hp.current
      || consequence.resources.hp.after.maximum !== projected.resources.hp.maximum
      || consequence.resources.mana.after.current !== projected.resources.mana.current
      || consequence.resources.mana.after.maximum !== projected.resources.mana.maximum
      || consequence.resources.sp.after.current !== projected.resources.sp.current
      || consequence.resources.sp.after.maximum !== projected.resources.sp.maximum) {
      throw new EncounterError('ENCOUNTER_DENORMALIZED_DRIFT');
    }
  }
}

export async function validateLoadedEncounter(
  transaction: EncounterTransaction,
  record: EncounterRecord,
  options: { readonly skipCurrentAuthorities?: boolean } = {},
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
  const closed = new Set<EncounterLifecycleStatus>([
    EncounterLifecycleStatus.COMPLETED,
    EncounterLifecycleStatus.CANCELLED,
    EncounterLifecycleStatus.FAILED,
  ]).has(record.lifecycleStatus);
  if (!closed && !options.skipCurrentAuthorities && record.currentTick !== record.campaign.engineTick) {
    throw new EncounterError('ENCOUNTER_CAMPAIGN_TICK_DRIFT');
  }
  const latest = record.operations[0];
  if (latest === undefined || latest.nextStateVersion !== record.stateVersion
    || latest.afterStateHash !== record.stateHash || latest.stopReason !== record.stopReason) {
    throw new EncounterError('ENCOUNTER_DENORMALIZED_DRIFT');
  }
  await assertEncounterOperationChain(transaction, record);
  let operationSummary: ReturnType<typeof parseEncounterOperationResultSummary>;
  try {
    operationSummary = parseEncounterOperationResultSummary(latest.resultSummary);
  } catch (error) {
    throw new EncounterError('ENCOUNTER_SNAPSHOT_INVALID', { cause: error });
  }
  const adapterState = operationSummary.adapterState;
  const consequencesSummary = validateTerminalConsequence(record, operationSummary);
  const persisted = record.participants.filter((participant) => participant.actorId !== null);
  const snapshotRefs = new Set(state.participants.map((participant) => participant.actorRef));
  if (operationSummary.encounterContext?.protectedActorRefs.some((actorRef) => !snapshotRefs.has(actorRef)) === true) {
    throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
  }
  if (record.participants.length !== state.participants.length
    || record.participants.some((participant) => !snapshotRefs.has(participant.actorRef))) {
    throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
  }
  if (adapterState.participants.length !== persisted.length) {
    throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
  }
  const persistedRefs = persisted.map((participant) => participant.actorRef).sort();
  const adapterRefs = adapterState.participants.map((participant) => participant.actorRef);
  if (canonicalEncounterMechanicalJson(adapterRefs) !== canonicalEncounterMechanicalJson(persistedRefs)) {
    throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
  }
  const persistedActorIds = persisted.map((participant) => participant.actorId as string);
  if (closed) {
    validateClosedHistoricalVectors(state, adapterState, consequencesSummary);
    return {
      record,
      state,
      adapterState,
      authorities: new Map(),
      ...(consequencesSummary === undefined ? {} : { consequencesSummary }),
      ...(operationSummary.encounterContext === undefined ? {} : { context: operationSummary.encounterContext }),
    };
  }
  if (options.skipCurrentAuthorities) {
    return {
      record, state, adapterState, authorities: new Map(),
      ...(operationSummary.encounterContext === undefined ? {} : { context: operationSummary.encounterContext }),
    };
  }
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
  return {
    record, state, adapterState, authorities,
    ...(operationSummary.encounterContext === undefined ? {} : { context: operationSummary.encounterContext }),
  };
}

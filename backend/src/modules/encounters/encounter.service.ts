import {
  ActiveEffectDurationType,
  ActorStatus,
  EncounterEphemeralKind,
  EncounterLifecycleStatus,
  EncounterOperationKind,
  EncounterParticipantBindingKind,
  EncounterRollKind,
  Prisma,
} from '../../generated/prisma/client.js';
import { resolveScope } from '../../shared/database/game-scope.js';
import { NotFoundError } from '../../shared/errors/app-error.js';
import { isExpectedUniqueConflict } from '../../shared/database/prisma-errors.js';
import { prisma } from '../../shared/database/prisma.js';
import { normalizeEnum } from '../../shared/http/normalize-enum.js';
import { loadActorReadiness } from '../actors/actor-readiness.service.js';
import { recomputeActorDerivedSnapshot } from '../actors/actor-mechanics.service.js';
import { validateSupportedCoreRulesetVersion } from '../rules/ruleset.registry.js';
import {
  applyCoreV1EncounterIntent,
  applyCoreV1EncounterActionPlan,
  calculateMovement,
  cancelCoreV1Encounter,
  confirmCoreV1EncounterCompletion,
  CORE_V1_MAX_ENCOUNTER_BATCH_ADVANCE,
  CORE_V1_MAX_ENCOUNTER_BATCH_EVENTS,
  createCoreV1EncounterActionSlots,
  createCoreV1EncounterState,
  processCoreV1EncounterBatch,
  processNextCoreV1EncounterEvent,
  resolveCoreV1DeterministicReactionOutcome,
  validateCoreV1EncounterActionIntent,
  type CoreV1EncounterBatchResult,
  type CoreV1CreateEncounterInput,
  type CoreV1EncounterParticipantInput,
  type CoreV1EncounterRuntime,
  type CoreV1EncounterState,
  type CoreV1EncounterActionDefinition,
  type CoreV1EncounterActionIntent,
  type CoreV1EncounterTargetingContext,
  type ReactionOutcomeResolver,
} from '../rules/core-v1/index.js';
import {
  loadAuthoritativeEncounterAction,
  loadCachedAuthoritativeEncounterAction,
  loadEncounterActionCatalog,
  loadEncounterActionCatalogSource,
  projectEncounterActionCatalog,
  type EncounterActionCatalog,
  type EncounterActionCatalogSource,
} from './encounter-action-loader.js';
import {
  applyBeatGuardCapabilities,
  automaticReactionResolver,
  beatComponentRejectionReason,
  deriveEncounterFleeStep,
  expireBeatGuardCapabilities,
  encounterScenePackage,
  genericEncounterAction,
  normalizeBeatComponent,
  selectNpcBeatComponent,
} from './encounter-beat.js';
import { EncounterError } from './encounter.errors.js';
import {
  publicEncounterConsequencesSummary,
  type EncounterConsequenceSummaryV1,
} from './encounter-consequence.js';
import {
  applyEncounterTerminalConsequences,
  persistEncounterTerminalConsequence,
} from './encounter-terminal-finalizer.js';
import { encounterNextRequiredAction, encounterTransitionSummary } from './encounter-response-projection.js';
import {
  applyEncounterMutations,
  assertEncounterMutationPreflight,
} from './encounter-mutation-applier.js';
import {
  absentEncounterStateHash,
  calculateEncounterRequestHash,
  createEncounterOperation,
  ENCOUNTER_TRANSACTION_OPTIONS,
  executeIdempotentEncounter,
  lockActorAuthorities,
  lockCampaign,
  lockEncounter,
  lockEncounterAuthorities,
  isRetryableEncounterTransactionError,
  encounterPostgresCode,
  encounterPostgresMessage,
  type EncounterDatabase,
  type EncounterTransaction,
} from './encounter.repository.js';
import { RecordingEncounterRollProvider } from './encounter-roll-provider.js';
import {
  adapterStateFromAuthorities,
  databaseCompletionCandidate,
  databaseStopReason,
  deriveEncounterLifecycle,
  findEncounterRecord,
  loadPersistedEncounterAuthorities,
  validateLoadedEncounter,
  type LoadedEncounter,
} from './encounter-state-loader.js';
import {
  createCoreV1EncounterSnapshotHash,
  serializeCoreV1EncounterState,
} from './encounter-state-snapshot.js';
import {
  parseEncounterDto,
  type AbandonEncounterInput,
  type CancelEncounterInput,
  type ConfirmEncounterCompletionInput,
  type ContinueEncounterInput,
  type CreateEncounterInput,
  type EncounterDto,
  type EncounterBeatComponent,
  type EncounterBeatSummaryDto,
  type EncounterBatchSummaryDto,
  type EncounterContextV1,
  type EncounterMutationReference,
  type EncounterOperationName,
  type LoadEncounterInput,
  type ResolveEncounterReactionInput,
  type ResolveEncounterBeatInput,
  type EncounterSetupSummaryDto,
  type SubmitEncounterIntentInput,
  ACTIVE_ENCOUNTER_LIFECYCLES,
} from './encounter.types.js';

const idempotencyOperation = {
  create: 'encounter.create',
  submit_intent: 'encounter.submit_intent',
  resolve_reaction: 'encounter.resolve_reaction',
  continue: 'encounter.continue',
  confirm_completion: 'encounter.confirm_completion',
  cancel: 'encounter.cancel',
  abandon: 'encounter.abandon',
  resolve_beat: 'encounter.resolve_beat',
} as const;

const operationKind = {
  create: EncounterOperationKind.CREATE,
  submit_intent: EncounterOperationKind.SUBMIT_INTENT,
  resolve_reaction: EncounterOperationKind.RESOLVE_REACTION,
  continue: EncounterOperationKind.CONTINUE,
  confirm_completion: EncounterOperationKind.CONFIRM_COMPLETION,
  cancel: EncounterOperationKind.CANCEL,
  abandon: EncounterOperationKind.CANCEL,
  resolve_beat: EncounterOperationKind.SUBMIT_INTENT,
} as const;

function persistedOperationKind(
  operation: Exclude<EncounterOperationName, 'create'>,
  lifecycleStatus: EncounterLifecycleStatus,
): EncounterOperationKind {
  if (operation === 'resolve_beat' && lifecycleStatus === EncounterLifecycleStatus.COMPLETED) {
    return EncounterOperationKind.CONFIRM_COMPLETION;
  }
  return operationKind[operation];
}

const recoverableAuthorityDrift = new Set([
  'ENCOUNTER_MECHANICS_DRIFT',
  'ENCOUNTER_RESOURCE_DRIFT',
  'ENCOUNTER_INVENTORY_DRIFT',
  'ENCOUNTER_EFFECTS_DRIFT',
  'ENCOUNTER_CAMPAIGN_TICK_DRIFT',
]);

function authorityFromDrift(code: EncounterError['code']): NonNullable<EncounterDto['recoverySummary']>['authority'] {
  switch (code) {
    case 'ENCOUNTER_MECHANICS_DRIFT': return 'mechanics';
    case 'ENCOUNTER_RESOURCE_DRIFT': return 'resources';
    case 'ENCOUNTER_INVENTORY_DRIFT': return 'inventory';
    case 'ENCOUNTER_EFFECTS_DRIFT': return 'effects';
    case 'ENCOUNTER_CAMPAIGN_TICK_DRIFT': return 'campaign_tick';
    default: throw new EncounterError('ENCOUNTER_INTERNAL');
  }
}

const refPattern = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function inputRecord(input: unknown, allowedKeys: readonly string[]): asserts input is Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input) as object | null)
    || Object.keys(input).some((key) => !allowedKeys.includes(key))) {
    throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
  }
}

function normalizeCreateInput(input: CreateEncounterInput): CreateEncounterInput {
  if (input.participants.length > 64 || Object.keys(input.participants).length !== input.participants.length
    || Object.keys(input.relations).length !== input.relations.length) {
    throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
  }
  const participants = input.participants.map((participant) => {
    if (participant?.bindingKind === 'persisted_actor') {
      inputRecord(participant, ['bindingKind', 'actorRef', 'sideRef', 'zone', 'surprised']);
      assertReference(participant.actorRef);
      assertReference(participant.sideRef);
      if (!['engaged', 'near', 'medium', 'far', 'out_of_range'].includes(participant.zone)
        || (participant.surprised !== undefined && typeof participant.surprised !== 'boolean')) {
        throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
      }
      return { ...participant, surprised: participant.surprised ?? false };
    }
    if (participant?.bindingKind !== 'ephemeral') throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
    inputRecord(participant, ['bindingKind', 'ephemeralKind', 'participant']);
    if (!['summon', 'projection', 'ephemeral_creature'].includes(participant.ephemeralKind)) {
      throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
    }
    inputRecord(participant.participant, [
      'actorRef', 'sideRef', 'actorStateVersion', 'mechanicsStateVersion', 'inventoryStateVersion',
      'effectsStateVersion', 'zone', 'combatState', 'primaryAttributes', 'resources',
      'secondaryAttributes', 'activeEffects', 'reactionCapabilities', 'equipmentContext', 'initiative',
    ]);
    assertReference(participant.participant.actorRef);
    return participant;
  }).sort((left, right) => {
    const leftRef = left.bindingKind === 'persisted_actor' ? left.actorRef : left.participant.actorRef;
    const rightRef = right.bindingKind === 'persisted_actor' ? right.actorRef : right.participant.actorRef;
    return leftRef.localeCompare(rightRef);
  });
  const relations = input.relations.map((relation) => {
    inputRecord(relation, ['leftActorRef', 'rightActorRef', 'relation']);
    assertReference(relation.leftActorRef);
    assertReference(relation.rightActorRef);
    return relation.leftActorRef <= relation.rightActorRef ? { ...relation } : {
      ...relation, leftActorRef: relation.rightActorRef, rightActorRef: relation.leftActorRef,
    };
  }).sort((left, right) => `${left.leftActorRef}\u0000${left.rightActorRef}`
    .localeCompare(`${right.leftActorRef}\u0000${right.rightActorRef}`));
  return { ...input, participants, relations };
}

function assertReference(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 160
    || !refPattern.test(value) || uuidPattern.test(value)) {
    throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
  }
}

function validateMutationReference(input: EncounterMutationReference, extra: readonly string[] = []): void {
  inputRecord(input, [
    'playerRef', 'worldRef', 'campaignRef', 'encounterRef', 'idempotencyKey',
    'expectedStateVersion', ...extra,
  ]);
  assertReference(input.encounterRef);
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200
    || !Number.isSafeInteger(input.expectedStateVersion) || input.expectedStateVersion < 1) {
    throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
  }
}

function withoutIdempotency<T extends { readonly idempotencyKey: string }>(input: T) {
  const { idempotencyKey, ...semantic } = input;
  void idempotencyKey;
  return semantic;
}

function coreValue<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T {
  if (!result.ok) throw new EncounterError('ENCOUNTER_CORE_REJECTED');
  return result.value;
}

function dto(
  operation: EncounterOperationName | 'load',
  record: { readonly encounterRef: string; readonly participants: readonly { readonly actorRef: string; readonly bindingKind: EncounterParticipantBindingKind }[] },
  state: CoreV1EncounterState,
  lifecycleStatus: EncounterLifecycleStatus,
  stopReason: string | null,
  batch?: CoreV1EncounterBatchResult,
  consequencesSummary?: EncounterConsequenceSummaryV1,
  scene?: EncounterDto['scene'],
  beatSummary?: EncounterBeatSummaryDto,
  recoverySummary?: EncounterDto['recoverySummary'],
  setupSummary?: EncounterSetupSummaryDto,
  batchSummary?: EncounterBatchSummaryDto,
): EncounterDto {
  const binding = new Map(record.participants.map((participant) => [participant.actorRef, participant.bindingKind]));
  const nextRequiredAction = encounterNextRequiredAction(state, lifecycleStatus);
  const transitionSummary = batch === undefined ? undefined : encounterTransitionSummary(batch);
  return parseEncounterDto({
    operation,
    encounterRef: record.encounterRef,
    lifecycleStatus: normalizeEnum(lifecycleStatus),
    stateVersion: state.stateVersion,
    currentTick: state.currentTick.toString(10),
    stopReason,
    completionCandidate: state.completionCandidate,
    participants: state.participants.map((participant) => ({
      actorRef: participant.actorRef,
      bindingKind: binding.get(participant.actorRef) === EncounterParticipantBindingKind.PERSISTED_ACTOR
        ? 'persisted_actor' : 'ephemeral',
      sideRef: participant.sideRef,
      combatState: participant.combatState,
      zone: participant.zone,
      resources: {
        hp: { ...participant.resources.hp },
        mana: { ...participant.resources.mana },
        sp: { ...participant.resources.sp },
      },
    })),
    nextRequiredAction,
    ...(transitionSummary === undefined ? {} : { transitionSummary }),
    ...(consequencesSummary === undefined ? {} : {
      consequencesSummary: publicEncounterConsequencesSummary(consequencesSummary),
    }),
    ...(scene === undefined ? {} : { scene }),
    ...(beatSummary === undefined ? {} : { beatSummary }),
    ...(recoverySummary === undefined ? {} : { recoverySummary }),
    ...(setupSummary === undefined ? {} : { setupSummary }),
    ...(batchSummary === undefined ? {} : { batchSummary }),
  });
}

function defaultEncounterContext(): EncounterContextV1 {
  return {
    schemaVersion: 1,
    setupMode: 'explicit',
    encounterKind: 'combat',
    objective: null,
    engagementPreference: 'explicit',
    protectedActorRefs: [],
    environment: { summary: null, tags: [] },
  };
}

async function persistRolls(
  transaction: EncounterTransaction,
  encounterId: string,
  encounterOperationId: string,
  recorder: RecordingEncounterRollProvider,
): Promise<void> {
  const kinds = {
    tie_break: EncounterRollKind.TIE_BREAK,
    hit: EncounterRollKind.HIT,
    critical: EncounterRollKind.CRITICAL,
    concentration: EncounterRollKind.CONCENTRATION,
  } as const;
  if (recorder.consumed.length === 0) return;
  await transaction.encounterRoll.createMany({
    data: recorder.consumed.map((roll) => ({
      encounterId,
      encounterOperationId,
      rollRef: roll.rollRef,
      kind: kinds[roll.kind],
      ordinal: roll.ordinal,
      ...(roll.actionRef === undefined ? {} : { actionRef: roll.actionRef }),
      sourceActorRef: roll.sourceActorRef,
      ...(roll.targetActorRef === undefined ? {} : { targetActorRef: roll.targetActorRef }),
      ...(roll.targetOrdinal === undefined ? {} : { targetOrdinal: roll.targetOrdinal }),
      inputHash: roll.inputHash,
      resultSnapshot: roll.resultSnapshot,
      resultHash: roll.resultHash,
    })),
  });
}

async function persistTransition(
  transaction: EncounterTransaction,
  loaded: LoadedEncounter,
  state: CoreV1EncounterState,
  authorities: Awaited<ReturnType<typeof loadPersistedEncounterAuthorities>>,
  operation: Exclude<EncounterOperationName, 'create'>,
  idempotencyRecordId: string,
  requestHash: string,
  recorder: RecordingEncounterRollProvider,
  stopReason: string | null,
    batch?: CoreV1EncounterBatchResult,
    beatSummary?: EncounterBeatSummaryDto,
    batchSummary?: EncounterBatchSummaryDto,
    actionCatalogSource?: EncounterActionCatalogSource,
): Promise<EncounterDto> {
  if (state.stateVersion <= loaded.state.stateVersion) throw new EncounterError('ENCOUNTER_CORE_REJECTED');
  const initialLifecycleStatus = deriveEncounterLifecycle(state, stopReason);
  const terminal = initialLifecycleStatus === EncounterLifecycleStatus.COMPLETED
    || initialLifecycleStatus === EncounterLifecycleStatus.CANCELLED
    ? await applyEncounterTerminalConsequences(transaction, loaded, state, authorities)
    : undefined;
  const persistedState = terminal?.state ?? state;
  const persistedAuthorities = terminal?.authorities ?? authorities;
  const snapshot = serializeCoreV1EncounterState(persistedState);
  const stateHash = createCoreV1EncounterSnapshotHash(snapshot);
  const lifecycleStatus = deriveEncounterLifecycle(persistedState, stopReason);
  const updated = await transaction.encounter.updateMany({
    where: {
      id: loaded.record.id,
      stateVersion: loaded.record.stateVersion,
      stateHash: loaded.record.stateHash,
    },
    data: {
      lifecycleStatus,
      stateVersion: persistedState.stateVersion,
      currentTick: persistedState.currentTick,
      stopReason: databaseStopReason(stopReason),
      completionCandidate: databaseCompletionCandidate(persistedState.completionCandidate),
      stateSnapshot: snapshot,
      stateHash,
      ...((lifecycleStatus === EncounterLifecycleStatus.COMPLETED
        || lifecycleStatus === EncounterLifecycleStatus.CANCELLED
        || lifecycleStatus === EncounterLifecycleStatus.FAILED)
        ? { closedAt: new Date() } : {}),
    },
  });
  if (updated.count !== 1) throw new EncounterError('ENCOUNTER_EXPECTED_VERSION_CONFLICT');
  const adapterState = adapterStateFromAuthorities(persistedAuthorities);
  const encounterContext = loaded.context ?? defaultEncounterContext();
  const persistedOperation = await createEncounterOperation(transaction, {
    encounterId: loaded.record.id,
    idempotencyRecordId,
    operation: persistedOperationKind(operation, lifecycleStatus),
    previousStateVersion: loaded.state.stateVersion,
    nextStateVersion: persistedState.stateVersion,
    inputHash: requestHash,
    beforeStateHash: loaded.record.stateHash,
    afterStateHash: stateHash,
    stopReason: databaseStopReason(stopReason),
    resultSummary: {
      adapterState,
      encounterContext,
      ...(terminal === undefined ? {} : { consequencesSummary: terminal.summary }),
    } as unknown as Prisma.InputJsonValue,
  });
  await persistRolls(transaction, loaded.record.id, persistedOperation.id, recorder);
  if (terminal !== undefined) {
    await persistEncounterTerminalConsequence(transaction, {
      loaded,
      encounterOperationId: persistedOperation.id,
      summary: terminal.summary,
      eventPayload: terminal.eventPayload,
      protagonistActorId: terminal.protagonistActorId,
    });
  }
  const actionCatalog = operation === 'resolve_beat'
    ? actionCatalogSource === undefined
      ? await loadEncounterActionCatalog(transaction, { state: persistedState, authorities: persistedAuthorities })
      : projectEncounterActionCatalog(
        actionCatalogSource,
        { state: persistedState, authorities: persistedAuthorities },
      )
    : undefined;
  const persistedBatchSummary = batchSummary === undefined ? undefined : {
    ...batchSummary,
    endingStateVersion: persistedState.stateVersion,
    terminalCandidate: persistedState.completionCandidate,
  };
  return dto(
    operation,
    loaded.record,
    persistedState,
    lifecycleStatus,
    stopReason,
    batch,
    terminal?.summary,
    operation === 'resolve_beat' ? encounterScenePackage(persistedState, persistedAuthorities, {
      lifecycleStatus: normalizeEnum(lifecycleStatus),
      context: encounterContext,
      ...(actionCatalog === undefined ? {} : { actionCatalog }),
    }) : undefined,
    beatSummary,
    undefined,
    undefined,
    persistedBatchSummary,
  );
}

async function lockAndLoad(
  transaction: EncounterTransaction,
  input: EncounterMutationReference,
  allowed: readonly EncounterLifecycleStatus[],
): Promise<LoadedEncounter> {
  const scope = await resolveScope(transaction, input);
  const initial = await findEncounterRecord(transaction, scope.campaign.id, input.encounterRef);
  await lockCampaign(transaction, scope.campaign.id);
  await lockEncounter(transaction, initial.id);
  const actorIds = initial.participants.flatMap((participant) => participant.actorId === null ? [] : [participant.actorId]);
  await lockEncounterAuthorities(transaction, initial.id, actorIds);
  const record = await findEncounterRecord(transaction, scope.campaign.id, input.encounterRef);
  if (record.stateVersion !== input.expectedStateVersion) {
    throw new EncounterError('ENCOUNTER_EXPECTED_VERSION_CONFLICT');
  }
  if (!allowed.includes(record.lifecycleStatus)) throw new EncounterError('ENCOUNTER_LIFECYCLE_CONFLICT');
  return validateLoadedEncounter(transaction, record);
}

function mergeReports(
  before: CoreV1EncounterState,
  reports: readonly CoreV1EncounterBatchResult[],
  stopReason: CoreV1EncounterBatchResult['stopReason'],
): CoreV1EncounterBatchResult {
  const after = reports.at(-1)?.encounterAfter ?? before;
  return {
    encounterBefore: before,
    encounterAfter: after,
    processedEvents: reports.flatMap((report) => report.processedEvents),
    resolvedActions: [...new Set(reports.flatMap((report) => report.resolvedActions))].sort(),
    effectResolutions: reports.flatMap((report) => report.effectResolutions),
    reactionResolutions: reports.flatMap((report) => report.reactionResolutions),
    movementChanges: reports.flatMap((report) => report.movementChanges),
    cooldownChanges: reports.flatMap((report) => report.cooldownChanges),
    invalidatedEvents: reports.flatMap((report) => report.invalidatedEvents),
    readyActors: [...new Set(reports.flatMap((report) => report.readyActors))].sort(),
    stopReason,
    continuationRequired: stopReason === 'reaction_required' || stopReason === 'processing_limit',
  };
}

function processUntilReactionBoundary(
  state: CoreV1EncounterState,
  runtime: CoreV1EncounterRuntime,
): CoreV1EncounterBatchResult {
  const hasReactionBoundary = state.scheduledEvents.some((event) => (
    event.type === 'reaction_resolved' || event.type === 'counter_attack_started'
  ));
  if (!hasReactionBoundary) return coreValue(processCoreV1EncounterBatch(state, runtime));
  const reports: CoreV1EncounterBatchResult[] = [];
  let current = state;
  while (reports.length < CORE_V1_MAX_ENCOUNTER_BATCH_EVENTS) {
    const next = current.scheduledEvents[0];
    if (next === undefined || next.type === 'reaction_resolved' || next.type === 'counter_attack_started') break;
    if (next.timelineEvent.tick - state.currentTick > CORE_V1_MAX_ENCOUNTER_BATCH_ADVANCE) break;
    const report = coreValue(processNextCoreV1EncounterEvent(current, runtime));
    if (report.encounterAfter.stateVersion === current.stateVersion) break;
    reports.push(report);
    current = report.encounterAfter;
    if (report.stopReason !== null) return mergeReports(state, reports, report.stopReason);
  }
  if (reports.length === 0) throw new EncounterError('ENCOUNTER_LIFECYCLE_CONFLICT');
  const next = current.scheduledEvents[0];
  const reachedReaction = next?.type === 'reaction_resolved' || next?.type === 'counter_attack_started';
  return mergeReports(state, reports, reachedReaction ? 'reaction_required' : 'processing_limit');
}

function deterministicReactionResolver(input: ResolveEncounterReactionInput): ReactionOutcomeResolver {
  return {
    resolve(request) {
      if (request.reactorActorRef !== input.reactorActorRef || request.reactionKind !== input.reactionKind) {
        throw new EncounterError('ENCOUNTER_LIFECYCLE_CONFLICT');
      }
      const reactor = request.encounter.participants.find((participant) => participant.actorRef === request.reactorActorRef);
      const capability = reactor?.reactionCapabilities.find((entry) => entry.kind === request.reactionKind);
      if (capability === undefined) throw new EncounterError('ENCOUNTER_LIFECYCLE_CONFLICT');
      return resolveCoreV1DeterministicReactionOutcome(capability);
    },
  };
}

function beatSlotRef(
  state: CoreV1EncounterState,
  actorRef: string,
  component: EncounterBeatComponent,
): string {
  const actor = state.participants.find((participant) => participant.actorRef === actorRef);
  if (actor === undefined) throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
  const preferred = component.type === 'attack' || component.type === 'cast' ? 'primary' : 'secondary';
  return actor.actionSlots.find((slot) => slot.slotRef === preferred)?.slotRef
    ?? actor.actionSlots[0]?.slotRef
    ?? (() => { throw new EncounterError('ENCOUNTER_CORE_REJECTED'); })();
}

function mechanicalBeatIntent(
  component: Extract<EncounterBeatComponent, { type: 'attack' | 'cast' | 'use_item' | 'prepare' }>,
  actorRef: string,
  intentRef: string,
  slotRef: string,
): CoreV1EncounterActionIntent {
  const targetRefs = component.targetRefs ?? [];
  return {
    intentRef,
    sourceActorRef: actorRef,
    slotRef,
    actionSource: component.type === 'attack' ? 'basic_weapon_attack'
      : component.type === 'use_item' ? 'consumable' : 'content',
    targetSelector: targetRefs.length === 0 ? 'self' : 'explicit',
    requestedTargetRefs: [...targetRefs],
    ...(component.type === 'attack' || component.type === 'use_item'
      ? { weaponEntryRef: component.inventoryEntryRef } : { contentRef: component.contentRef }),
    ...(component.type === 'attack' && component.versatileMode !== undefined
      ? { versatileMode: component.versatileMode } : {}),
    ...(component.type === 'attack'
      ? { reactionPolicy: { mode: 'allow' as const, allowCounterAttack: false } } : {}),
  };
}

async function beatAction(
  transaction: EncounterTransaction,
  loaded: LoadedEncounter,
  state: CoreV1EncounterState,
  actorRef: string,
  component: EncounterBeatComponent,
  intentRef: string,
  actionCatalogSource?: EncounterActionCatalogSource,
) {
  const slotRef = beatSlotRef(state, actorRef, component);
  if (component.type === 'attack' || component.type === 'cast' || component.type === 'use_item') {
    const intent = mechanicalBeatIntent(component, actorRef, intentRef, slotRef);
    const authoritative = actionCatalogSource === undefined
      ? await loadAuthoritativeEncounterAction(transaction, { ...loaded, state }, intent)
      : await loadCachedAuthoritativeEncounterAction(actionCatalogSource, { ...loaded, state }, intent);
    return { intent, ...authoritative };
  }
  if (component.type === 'prepare') {
    const preparedIntent = mechanicalBeatIntent(component, actorRef, `${intentRef}-prepared`, 'primary');
    if (actionCatalogSource === undefined) {
      await loadAuthoritativeEncounterAction(transaction, { ...loaded, state }, preparedIntent);
    } else {
      await loadCachedAuthoritativeEncounterAction(actionCatalogSource, { ...loaded, state }, preparedIntent);
    }
  }
  return genericEncounterAction(state, actorRef, component, intentRef, slotRef);
}

interface ExecutedBeatPlan {
  readonly state: CoreV1EncounterState;
  readonly report: CoreV1EncounterBatchResult;
  readonly results: EncounterBeatSummaryDto['componentResults'];
  readonly appliedComponents: readonly EncounterBeatComponent[];
  readonly skippedComponentIndexes: ReadonlySet<number>;
  readonly prepared: readonly { readonly index: number; readonly component: Extract<EncounterBeatComponent, { type: 'prepare' }> }[];
  readonly resolvedConsumables: readonly { readonly actionRef: string; readonly actorRef: string; readonly entryRef: string }[];
}

function componentSnapshot(component: EncounterBeatComponent): string {
  return JSON.stringify(component);
}

function rejectedComponentDetails(reason: string, index: number) {
  const code = reason === 'distance_incompatible' ? 'DISTANCE_INCOMPATIBLE'
    : reason === 'no_valid_target' ? 'NO_VALID_TARGET'
      : reason === 'resource_below_required' ? 'RESOURCE_BELOW_REQUIRED'
        : reason === 'reaction_required' ? 'REACTION_REQUIRED'
          : 'COMPONENT_NOT_RESOLVED';
  const alternative = reason === 'distance_incompatible'
    ? 'Choose an adjacent zone, or use run only for at most two transitions.'
    : reason === 'no_valid_target' ? 'Choose a target allowed by relation, range and action profile.'
      : reason === 'resource_below_required' ? 'Choose a lower-cost action or recover the required resource.'
        : 'Load the current encounter state and choose a compatible component.';
  return { code, field: `intent.components.${String(index)}`, alternative };
}

function atomicBeatIssues(results: EncounterBeatSummaryDto['componentResults']) {
  return results.map((result) => ({
    path: `intent.components.${String(result.index)}`,
    code: result.status === 'rejected' ? result.code ?? 'COMPONENT_REJECTED' : 'ATOMIC_ROLLBACK',
    message: result.status === 'rejected'
      ? `${result.reason ?? 'Component was rejected'}. ${result.alternative ?? 'Choose a compatible component.'}`
      : `Component was ${result.status} in memory but was not persisted because the beat policy required full rollback.`,
  }));
}

function evaluateBeatComponentCondition(
  state: CoreV1EncounterState,
  actorRef: string,
  component: EncounterBeatComponent,
): {
  readonly component: EncounterBeatComponent;
  readonly skipScheduling: boolean;
  readonly omitFromApplied: boolean;
  readonly modification?: {
    readonly code: 'CONDITION_FALLBACK';
    readonly reason: string;
    readonly field: 'fallback';
  };
} {
  if (component.when === undefined) return { component, skipScheduling: false, omitFromApplied: false };
  const subjectRef = component.when.actorRef ?? actorRef;
  const subject = state.participants.find((participant) => participant.actorRef === subjectRef);
  if (subject === undefined) {
    throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID', {
      issues: [{
        path: 'intent.components.when.actorRef',
        code: 'CONDITION_ACTOR_NOT_FOUND',
        message: 'The condition actor must be a participant in the current encounter.',
      }],
    });
  }
  const pool = subject.resources[component.when.resource];
  const percent = pool.maximum === 0 ? 0 : Math.floor((pool.current * 100) / pool.maximum);
  const matches = component.when.operator === 'at_or_below_percent'
    ? percent <= component.when.percent
    : percent >= component.when.percent;
  if (matches) return { component, skipScheduling: false, omitFromApplied: false };
  if (component.fallback !== 'defend') {
    return { component, skipScheduling: true, omitFromApplied: true };
  }
  return {
    component: { type: 'defend', ...(component.essential === undefined ? {} : { essential: component.essential }) },
    skipScheduling: false,
    omitFromApplied: false,
    modification: {
      code: 'CONDITION_FALLBACK',
      reason: `The resource condition was false at ${String(percent)}%; the closed defend fallback was applied.`,
      field: 'fallback',
    },
  };
}

async function executeBeatPlan(
  transaction: EncounterTransaction,
  loaded: LoadedEncounter,
  state: CoreV1EncounterState,
  actorRef: string,
  components: readonly EncounterBeatComponent[],
  prefix: string,
  recorder: RecordingEncounterRollProvider,
  actionCatalogSource?: EncounterActionCatalogSource,
): Promise<ExecutedBeatPlan> {
  const intents: CoreV1EncounterActionIntent[] = [];
  const definitions: Record<string, CoreV1EncounterActionDefinition> = {};
  const targetingContexts: Record<string, CoreV1EncounterTargetingContext> = {};
  const prepared: { index: number; component: Extract<EncounterBeatComponent, { type: 'prepare' }> }[] = [];
  const expectedActions: { index: number; actionRef: string; component: EncounterBeatComponent }[] = [];
  const evaluated = components.map((component) => evaluateBeatComponentCondition(state, actorRef, component));
  const normalized = evaluated.map(({ component }) => normalizeBeatComponent(state, actorRef, component));
  const appliedComponents = normalized.map((entry) => entry.component);
  const completedFleeIndexes = new Set(normalized.flatMap((entry, index) => (
    entry.completedFlee === true ? [index] : []
  )));
  const conditionalComponentIndexes = new Set(appliedComponents.flatMap((_, index) => (
    evaluated[index]?.skipScheduling === true ? [index] : []
  )));
  const scheduledComponentIndexes = new Set(appliedComponents.flatMap((_, index) => (
    conditionalComponentIndexes.has(index) || completedFleeIndexes.has(index) ? [] : [index]
  )));
  if (scheduledComponentIndexes.size === 0) {
    throw new EncounterError('ENCOUNTER_CORE_REJECTED', {
      issues: [{
        path: 'intent.components',
        code: 'NO_EXECUTABLE_COMPONENT',
        message: 'Every resource condition was false or waiting for a trigger. Add an unconditional step or a defend fallback.',
      }],
    });
  }
  let sequence = state.actionSequence;
  for (const [index, component] of appliedComponents.entries()) {
    if (evaluated[index]?.skipScheduling === true || completedFleeIndexes.has(index)) continue;
    const intentRef = `beat-${prefix}-${index}`;
    const action = await beatAction(transaction, loaded, state, actorRef, component, intentRef, actionCatalogSource);
    if (scheduledComponentIndexes.has(index)) {
      intents.push(action.intent);
      definitions[intentRef] = action.definition;
      targetingContexts[intentRef] = action.targetingContext;
      expectedActions.push({ index, actionRef: `${state.encounterRef}-action-${sequence}`, component });
      sequence += 1;
    }
    if (component.type === 'prepare') prepared.push({ index, component });
  }
  const report = coreValue(applyCoreV1EncounterActionPlan({
    encounter: state,
    plan: {
      planRef: `beat-plan-${prefix}`,
      actorRef,
      expectedStateVersion: state.stateVersion,
      intents,
      stopConditions: ['actorIncapacitated', 'reactionRequired', 'processingLimit', 'noValidTarget'],
    },
    definitions,
    targetingContexts,
    runtime: { rolls: recorder, reactionOutcomes: automaticReactionResolver() },
  }));
  const resolved = new Set(report.resolvedActions);
  const expectedByIndex = new Map(expectedActions.map((entry) => [entry.index, entry]));
  const results = components.map((requestedComponent, index) => {
    const component = appliedComponents[index] ?? requestedComponent;
    const modification = evaluated[index]?.modification ?? normalized[index]?.modification;
    const expected = expectedByIndex.get(index);
    if (completedFleeIndexes.has(index) && modification !== undefined) return {
      index,
      type: requestedComponent.type,
      status: 'modified' as const,
      code: modification.code,
      reason: modification.reason,
      field: `intent.components.${String(index)}.${modification.field}`,
      requested: componentSnapshot(requestedComponent),
      applied: componentSnapshot(component),
    };
    if (evaluated[index]?.skipScheduling === true && evaluated[index]?.modification !== undefined) return {
      index,
      type: component.type,
      status: 'modified' as const,
      code: evaluated[index].modification.code,
      reason: evaluated[index].modification.reason,
      field: `intent.components.${String(index)}.fallback`,
      requested: componentSnapshot(requestedComponent),
      applied: componentSnapshot(component),
    };
    if (evaluated[index]?.skipScheduling === true) return {
      index,
      type: requestedComponent.type,
      status: 'conditional' as const,
      code: 'CONDITION_NOT_MET',
      reason: 'The bounded resource condition was false at the start of this authoritative beat.',
      field: `intent.components.${String(index)}.when`,
      alternative: 'Continue with a later checkpoint, or provide the closed defend fallback.',
    };
    if (expected === undefined) return {
      index,
      type: requestedComponent.type,
      status: 'conditional' as const,
      code: 'TRIGGER_PENDING',
      reason: 'The conditional component was stored but its trigger has not fired.',
      field: `intent.components.${String(index)}`,
      alternative: 'Continue from this checkpoint; the backend will fire it only when its trigger occurs.',
    };
    const wasResolved = resolved.has(expected.actionRef);
    const rejectedReason = beatComponentRejectionReason(
      state,
      actorRef,
      component,
      report.stopReason ?? 'component_not_resolved',
    );
    const status = !wasResolved ? 'rejected' as const
      : conditionalComponentIndexes.has(index) ? 'conditional' as const
        : modification === undefined ? 'accepted' as const : 'modified' as const;
    return {
      index,
      type: requestedComponent.type === 'flee' ? 'flee' : component.type,
      status,
      ...(status === 'accepted' && ['defend', 'protect', 'intercept'].includes(component.type) ? {
        code: 'GUARD_PREPARED',
        reason: 'The authoritative guard capability was prepared for this beat; a reaction is reported only if it is actually resolved.',
      } : {}),
      ...(!wasResolved ? {
        ...rejectedComponentDetails(rejectedReason, index),
        reason: rejectedReason,
      } : status === 'modified' && modification !== undefined ? {
        code: modification.code,
        reason: modification.reason,
        field: `intent.components.${String(index)}.${modification.field}`,
        requested: componentSnapshot(requestedComponent),
        applied: componentSnapshot(component),
      } : status === 'conditional' ? {
        code: 'TRIGGER_PENDING',
        reason: 'The conditional component was stored but its trigger has not fired.',
        field: `intent.components.${String(index)}`,
        alternative: 'Continue from this checkpoint; the backend will fire it only when its trigger occurs.',
      } : {}),
    };
  });
  return {
    state: report.encounterAfter,
    report,
    results,
    appliedComponents,
    skippedComponentIndexes: new Set([
      ...evaluated.flatMap((entry, index) => entry.omitFromApplied ? [index] : []),
      ...completedFleeIndexes,
    ]),
    prepared: prepared.filter(({ index }) => results[index]?.status !== 'rejected'),
    resolvedConsumables: expectedActions.flatMap(({ actionRef, component }) => (
      component.type === 'use_item' && resolved.has(actionRef)
        ? [{ actionRef, actorRef, entryRef: component.inventoryEntryRef }] : []
    )),
  };
}

function storePreparedPlans(
  state: CoreV1EncounterState,
  actorRef: string,
  prepared: ExecutedBeatPlan['prepared'],
  prefix: string,
): CoreV1EncounterState {
  if (prepared.length === 0) return state;
  const additions = prepared.map(({ index, component }) => {
    const trigger = component.trigger.replaceAll('_', '-');
    return {
      planRef: `prepared-${trigger}-${prefix}-${index}`,
      actorRef,
      expectedStateVersion: state.stateVersion + 1,
      intents: [mechanicalBeatIntent(component, actorRef, `prepared-intent-${prefix}-${index}`, 'primary')],
      stopConditions: ['actorIncapacitated', 'reactionRequired', 'processingLimit', 'noValidTarget'] as const,
    };
  });
  if (state.actionPlans.length + additions.length > 5) throw new EncounterError('ENCOUNTER_CORE_REJECTED');
  return {
    ...state,
    stateVersion: state.stateVersion + 1,
    actionPlans: [...state.actionPlans, ...additions].sort((left, right) => left.planRef.localeCompare(right.planRef)),
  };
}

function preparedTriggerMatches(planRef: string, npcActions: EncounterBeatSummaryDto['npcActions']): boolean {
  if (planRef.startsWith('prepared-enemy-advances-')) return npcActions.some((action) => action.actionType === 'move');
  if (planRef.startsWith('prepared-enemy-attacks-')) return npcActions.some((action) => action.actionType === 'attack' || action.actionType === 'cast');
  if (planRef.startsWith('prepared-ally-attacked-')) return npcActions.some((action) => action.actionType === 'attack' || action.actionType === 'cast');
  return false;
}

async function executeTriggeredPreparedPlans(
  transaction: EncounterTransaction,
  loaded: LoadedEncounter,
  state: CoreV1EncounterState,
  npcActions: EncounterBeatSummaryDto['npcActions'],
  recorder: RecordingEncounterRollProvider,
  actionCatalogSource?: EncounterActionCatalogSource,
): Promise<{ readonly state: CoreV1EncounterState; readonly reports: readonly CoreV1EncounterBatchResult[] }> {
  let current = state;
  const reports: CoreV1EncounterBatchResult[] = [];
  for (const stored of state.actionPlans.filter((plan) => preparedTriggerMatches(plan.planRef, npcActions))) {
    const intent = stored.intents[0];
    if (intent === undefined) continue;
    const authoritative = actionCatalogSource === undefined
      ? await loadAuthoritativeEncounterAction(transaction, { ...loaded, state: current }, intent)
      : await loadCachedAuthoritativeEncounterAction(actionCatalogSource, { ...loaded, state: current }, intent);
    const report = coreValue(applyCoreV1EncounterActionPlan({
      encounter: current,
      plan: { ...stored, expectedStateVersion: current.stateVersion },
      definitions: { [intent.intentRef]: authoritative.definition },
      targetingContexts: { [intent.intentRef]: authoritative.targetingContext },
      runtime: { rolls: recorder, reactionOutcomes: automaticReactionResolver() },
    }));
    reports.push(report);
    current = report.encounterAfter;
  }
  return { state: current, reports };
}

async function executeOneResolvedBeat(
  transaction: EncounterTransaction,
  loaded: LoadedEncounter,
  startingState: CoreV1EncounterState,
  intent: NonNullable<ResolveEncounterBeatInput['intent']>,
  npcDirectives: readonly import('./encounter.types.js').EncounterNpcDirective[],
  prefix: string,
  recorder: RecordingEncounterRollProvider,
  actionCatalogSource?: EncounterActionCatalogSource,
): Promise<{
  readonly state: CoreV1EncounterState;
  readonly reports: readonly CoreV1EncounterBatchResult[];
  readonly beatSummary: EncounterBeatSummaryDto;
  readonly resolvedConsumables: ExecutedBeatPlan['resolvedConsumables'];
}> {
  const reports: CoreV1EncounterBatchResult[] = [];
  const mainActor = startingState.participants.find((participant) => participant.actorRef === intent.actorRef);
  if (mainActor === undefined || mainActor.combatState === 'removed' || mainActor.resources.hp.current === 0) {
    throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
  }
  const main = await executeBeatPlan(
    transaction, loaded, startingState, intent.actorRef, intent.components, prefix, recorder, actionCatalogSource,
  );
  const rejectedResults = main.results.filter((result) => result.status === 'rejected');
  const essentialRejected = rejectedResults.some((result) => intent.components[result.index]?.essential === true);
  if (rejectedResults.length > 0 && (
    intent.resolutionPolicy === 'atomic'
    || essentialRejected
    || rejectedResults.length === main.results.length
  )) {
    throw new EncounterError('ENCOUNTER_BEAT_ATOMIC_REJECTED', { issues: atomicBeatIssues(main.results) });
  }
  const resolvedMainComponents = main.appliedComponents.filter((_, index) => (
    main.results[index]?.status !== 'rejected' && !main.skippedComponentIndexes.has(index)
  ));
  let current = applyBeatGuardCapabilities(main.state, intent.actorRef, resolvedMainComponents, prefix);
  current = storePreparedPlans(current, intent.actorRef, main.prepared, prefix);
  reports.push(main.report);
  const actorsActed = new Set<string>(main.report.resolvedActions.length === 0 ? [] : [intent.actorRef]);
  const npcActions: EncounterBeatSummaryDto['npcActions'][number][] = [];
  const npcResults: EncounterBeatSummaryDto['npcResults'][number][] = [];
  const directiveByActor = new Map(npcDirectives.map((directive) => [directive.actorRef, directive]));
  const eligibleNpcRefs = current.participants.filter((participant) => (
    participant.actorRef !== intent.actorRef
    && participant.combatState !== 'removed'
    && participant.resources.hp.current > 0
    && participant.actionSlots.some((slot) => slot.nextActionAtTick <= current.currentTick)
  )).map((participant) => participant.actorRef).sort();
  const npcOffset = eligibleNpcRefs.length <= 4 ? 0 : startingState.stateVersion % eligibleNpcRefs.length;
  const selectedNpcRefs = eligibleNpcRefs.length <= 4 ? eligibleNpcRefs : Array.from(
    { length: 4 },
    (_, index) => eligibleNpcRefs[(npcOffset + index) % eligibleNpcRefs.length] as string,
  );
  const selectedNpcSet = new Set(selectedNpcRefs);
  const deferredNpcActorRefs = eligibleNpcRefs.filter((actorRef) => !selectedNpcSet.has(actorRef));
  for (const [npcIndex, actorRef] of selectedNpcRefs.entries()) {
    const selected = selectNpcBeatComponent(
      current, actorRef, intent.actorRef, loaded.authorities.get(actorRef), directiveByActor.get(actorRef),
    );
    const npc = await executeBeatPlan(
      transaction, loaded, current, actorRef, [selected.component], `${prefix}-npc-${npcIndex}`, recorder, actionCatalogSource,
    );
    const npcResolved = npc.report.resolvedActions.length > 0;
    current = applyBeatGuardCapabilities(
      npc.state, actorRef, npcResolved ? [selected.component] : [], `${prefix}-npc-${npcIndex}`,
    );
    reports.push(npc.report);
    if (npcResolved) {
      actorsActed.add(actorRef);
      npcResults.push({ actorRef, status: 'acted' });
      npcActions.push({
        actorRef,
        strategy: selected.strategy,
        actionType: selected.component.type,
        ...(selected.targetRef === undefined ? {} : { targetRef: selected.targetRef }),
      });
    } else {
      npcResults.push({
        actorRef,
        status: 'rejected',
        reason: npc.results[0]?.reason ?? 'npc_component_not_resolved',
      });
    }
  }
  const triggered = await executeTriggeredPreparedPlans(
    transaction, loaded, current, npcActions, recorder, actionCatalogSource,
  );
  current = triggered.state;
  reports.push(...triggered.reports);
  current = expireBeatGuardCapabilities(current);
  const terminal = current.completionCandidate !== null;
  if (terminal) current = coreValue(confirmCoreV1EncounterCompletion(current));
  return {
    state: current,
    reports,
    beatSummary: {
      externalTransitions: 1,
      resolutionPolicy: intent.resolutionPolicy,
      partialResolutionApplied: rejectedResults.length > 0,
      actorsActed: [...actorsActed].sort(),
      componentResults: main.results,
      npcActions,
      npcResults,
      ...(deferredNpcActorRefs.length === 0 ? {} : { deferredNpcActorRefs }),
      requiresPlayerDecision: !terminal,
    },
    resolvedConsumables: main.resolvedConsumables,
  };
}

function percentAtOrBelow(current: number, maximum: number, threshold: number): boolean {
  return maximum > 0 && current * 100 <= maximum * threshold;
}

function automaticPolicyStop(
  state: CoreV1EncounterState,
  policy: NonNullable<ResolveEncounterBeatInput['policy']>,
): { readonly reason: string; readonly alternatives: readonly string[] } | undefined {
  const actor = state.participants.find((participant) => participant.actorRef === policy.actorRef);
  if (actor === undefined || actor.combatState === 'removed' || actor.resources.hp.current === 0) {
    return { reason: 'primary_actor_incapacitated', alternatives: ['Choose another active actor or end the encounter.'] };
  }
  if (policy.strategy === 'escape' && policy.resourcePolicy.allowFlee) {
    const flee = deriveEncounterFleeStep(actor.zone, 'out_of_range');
    if (flee.status === 'completed') return { reason: 'flee_completed', alternatives: [] };
    const movement = calculateMovement(actor.zone, flee.to, flee.movementKind, 'normal');
    if (actor.resources.sp.current < movement.conceptualSpCost) {
      return {
        reason: 'flee_blocked_insufficient_sp',
        alternatives: ['Recover enough SP for the next run step.', 'Choose a different explicit action.'],
      };
    }
  }
  if (percentAtOrBelow(actor.resources.hp.current, actor.resources.hp.maximum, policy.resourcePolicy.stopBelowHpPercent)) {
    return { reason: 'hp_policy_threshold', alternatives: ['Choose a safer plan, healing action, or explicit continuation.'] };
  }
  for (const protectedRef of policy.protectedActorRefs) {
    const protectedActor = state.participants.find((participant) => participant.actorRef === protectedRef);
    if (protectedActor !== undefined && percentAtOrBelow(
      protectedActor.resources.hp.current,
      protectedActor.resources.hp.maximum,
      policy.resourcePolicy.stopIfProtectedActorBelowHpPercent,
    )) {
      return {
        reason: 'protected_actor_at_risk',
        alternatives: ['Protect or heal the threatened actor.', 'Continue explicitly with a revised threshold.'],
      };
    }
  }
  return undefined;
}

function selectAutomaticComponent(
  state: CoreV1EncounterState,
  policy: NonNullable<ResolveEncounterBeatInput['policy']>,
  actions: EncounterActionCatalog | undefined,
):
  | { readonly component: EncounterBeatComponent }
  | { readonly stopReason: string; readonly alternatives: readonly string[] } {
  const actor = state.participants.find((participant) => participant.actorRef === policy.actorRef);
  if (actor === undefined) {
    return { stopReason: 'no_valid_action', alternatives: ['Choose another active participant.'] };
  }
  if (policy.strategy === 'escape') {
    return policy.resourcePolicy.allowFlee
      ? { component: { type: 'flee', destination: 'out_of_range' } }
      : { stopReason: 'flee_requires_authorization', alternatives: ['Authorize fleeing or choose another strategy.'] };
  }
  if (actions === undefined) {
    return { stopReason: 'no_valid_action', alternatives: ['Choose another active participant.'] };
  }
  const relationTo = (targetRef: string) => state.relations.find((relation) => (
    relation.leftActorRef === policy.actorRef && relation.rightActorRef === targetRef
  ) || (
    relation.rightActorRef === policy.actorRef && relation.leftActorRef === targetRef
  ))?.relation ?? 'neutral';
  const hostiles = state.participants.filter((participant) => relationTo(participant.actorRef) === 'hostile'
    && participant.combatState !== 'removed' && participant.resources.hp.current > 0);
  const orderedTargets = policy.targetPriority === 'explicit'
    ? (policy.targetRefs ?? []).flatMap((ref) => hostiles.filter((target) => target.actorRef === ref))
    : policy.targetPriority === 'lowest_hp_hostile'
      ? [...hostiles].sort((left, right) => (
        left.resources.hp.current * right.resources.hp.maximum
        - right.resources.hp.current * left.resources.hp.maximum
        || left.actorRef.localeCompare(right.actorRef)
      ))
      : hostiles;
  const targetRefs = orderedTargets.map((target) => target.actorRef);
  const chooseTarget = (validTargetRefs: readonly string[]) => targetRefs.find((ref) => validTargetRefs.includes(ref));
  const attacks = actions.attacks.filter((action) => action.canUse);
  for (const attack of attacks) {
    const targetRef = chooseTarget(attack.validTargetRefs);
    if (targetRef !== undefined && attack.inventoryEntryRef !== undefined) {
      return {
        component: {
          type: 'attack',
          inventoryEntryRef: attack.inventoryEntryRef,
          targetRefs: [targetRef],
          ...(attack.compatibleModes?.includes('one_handed') === true ? { versatileMode: 'one_handed' as const } : {}),
        },
      };
    }
  }
  const abilities = actions.abilities.filter((action) => {
    if (!action.canUse || action.contentRef === undefined) return false;
    if (!policy.resourcePolicy.allowLimitedAbilities
      && ['rare', 'epic', 'legendary', 'mythic'].includes(action.rarity ?? 'common')) {
      return false;
    }
    if (action.cost.type === 'mana') {
      return (actor.resources.mana.current - action.cost.amount) * 100
        >= actor.resources.mana.maximum * policy.resourcePolicy.preserveManaPercent;
    }
    if (action.cost.type === 'sp') {
      return (actor.resources.sp.current - action.cost.amount) * 100
        >= actor.resources.sp.maximum * policy.resourcePolicy.preserveSpPercent;
    }
    if (action.cost.type === 'hybrid') {
      return (actor.resources.mana.current - action.cost.mana) * 100
        >= actor.resources.mana.maximum * policy.resourcePolicy.preserveManaPercent
        && (actor.resources.sp.current - action.cost.sp) * 100
        >= actor.resources.sp.maximum * policy.resourcePolicy.preserveSpPercent;
    }
    return action.cost.type === 'none';
  });
  for (const ability of abilities) {
    const targetRef = chooseTarget(ability.validTargetRefs) ?? (
      ability.validTargetRefs.includes(policy.actorRef) ? policy.actorRef : undefined
    );
    if (targetRef !== undefined && ability.contentRef !== undefined) {
      return {
        component: {
          type: 'cast',
          contentRef: {
            ...ability.contentRef,
            contentType: ability.contentRef.contentType as import('../rules/core-v1/index.js').CoreV1ContentKind,
          },
          targetRefs: [targetRef],
        },
      };
    }
  }
  const allowedItems = actions.items.filter((action) => action.canUse && (
    ['common', 'uncommon'].includes(action.rarity ?? 'common')
      ? policy.resourcePolicy.allowCommonConsumables
      : policy.resourcePolicy.allowRareConsumables
  ));
  for (const item of allowedItems) {
    const targetRef = item.validTargetRefs.includes(policy.actorRef)
      ? policy.actorRef : chooseTarget(item.validTargetRefs);
    if (targetRef !== undefined && item.inventoryEntryRef !== undefined) {
      return {
        component: {
          type: 'use_item',
          inventoryEntryRef: item.inventoryEntryRef,
          targetRefs: [targetRef],
        },
      };
    }
  }
  if (policy.strategy === 'protect_target') {
    const protectedRef = policy.protectedActorRefs.find((ref) => state.participants.some((actorValue) => actorValue.actorRef === ref));
    if (protectedRef !== undefined) return { component: { type: 'protect', targetRef: protectedRef } };
  }
  if (policy.strategy === 'defensive' || policy.strategy === 'support') return { component: { type: 'defend' } };
  const zoneOrder = ['engaged', 'near', 'medium', 'far', 'out_of_range'] as const;
  const currentIndex = zoneOrder.indexOf(actor.zone);
  if (currentIndex > 0) {
    return { component: { type: 'move', destination: zoneOrder[currentIndex - 1] as typeof actor.zone } };
  }
  const forbiddenItems = actions.items.filter((action) => action.canUse);
  if (forbiddenItems.some((action) => !['common', 'uncommon'].includes(action.rarity ?? 'common'))) {
    return { stopReason: 'rare_consumable_required', alternatives: ['Authorize the rare consumable.', 'Choose a different manual action.'] };
  }
  return { stopReason: 'no_valid_action', alternatives: ['Choose a manual action or change the automatic policy.'] };
}

function translate(error: unknown): never {
  if (error instanceof EncounterError) throw error;
  if (error instanceof NotFoundError) throw error;
  const postgresMessage = encounterPostgresMessage(error) ?? '';
  if (postgresMessage.includes('ENCOUNTER effects require an origin Encounter')
    || postgresMessage.includes('Only ENCOUNTER effects may reference an origin Encounter')) {
    throw new EncounterError('ENCOUNTER_EFFECT_ORIGIN_REQUIRED', { cause: error });
  }
  if (postgresMessage.includes('ActiveEffect Encounter ownership')) {
    throw new EncounterError('ENCOUNTER_EFFECT_OWNERSHIP_CONFLICT', { cause: error });
  }
  if (postgresMessage.includes('Terminal Encounter requires an EncounterConsequence')
    || postgresMessage.includes('Encounter consequence')) {
    throw new EncounterError('ENCOUNTER_DENORMALIZED_DRIFT', {
      cause: error,
      mismatchCategories: ['lifecycle', 'completionCandidate', 'operation'],
    });
  }
  if (isRetryableEncounterTransactionError(error)) {
    throw new EncounterError('ENCOUNTER_TRANSACTION_RETRYABLE', { retryable: true, cause: error });
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') throw new EncounterError('ENCOUNTER_CONSTRAINT_CONFLICT', { cause: error });
    if (error.code === 'P2003' || error.code === 'P2004') {
      throw new EncounterError('ENCOUNTER_CONSTRAINT_CONFLICT', { cause: error });
    }
  }
  if (['23503', '23505', '23514', 'P0001'].includes(encounterPostgresCode(error) ?? '')) {
    throw new EncounterError('ENCOUNTER_CONSTRAINT_CONFLICT', { cause: error });
  }
  throw new EncounterError('ENCOUNTER_INTERNAL', { cause: error });
}

export function createEncounterService(
  database: EncounterDatabase = prisma,
  rollRecorderFactory: (executionRef: string) => RecordingEncounterRollProvider
    = (executionRef) => new RecordingEncounterRollProvider(undefined, executionRef),
) {
  const mutate = async <T extends EncounterMutationReference>(
    operation: Exclude<EncounterOperationName, 'create'>,
    input: T,
    allowed: readonly EncounterLifecycleStatus[],
    execute: (
      transaction: EncounterTransaction,
      loaded: LoadedEncounter,
      recorder: RecordingEncounterRollProvider,
    ) => Promise<{
      readonly state: CoreV1EncounterState;
      readonly batch?: CoreV1EncounterBatchResult;
      readonly stopReason: string | null;
      readonly beatSummary?: EncounterBeatSummaryDto;
      readonly batchSummary?: EncounterBatchSummaryDto;
      readonly resolvedConsumables?: readonly { readonly actionRef: string; readonly actorRef: string; readonly entryRef: string }[];
      readonly actionCatalogSource?: EncounterActionCatalogSource;
    }> | {
      readonly state: CoreV1EncounterState;
      readonly batch?: CoreV1EncounterBatchResult;
      readonly stopReason: string | null;
      readonly beatSummary?: EncounterBeatSummaryDto;
      readonly batchSummary?: EncounterBatchSummaryDto;
      readonly resolvedConsumables?: readonly { readonly actionRef: string; readonly actorRef: string; readonly entryRef: string }[];
      readonly actionCatalogSource?: EncounterActionCatalogSource;
    },
  ): Promise<EncounterDto> => {
    try {
      return await executeIdempotentEncounter(
        database,
        input.idempotencyKey,
        idempotencyOperation[operation],
        withoutIdempotency(input),
        async (transaction, idempotencyRecordId, requestHash) => {
          const loaded = await lockAndLoad(transaction, input, allowed);
          assertEncounterMutationPreflight(loaded);
          const recorder = rollRecorderFactory(requestHash);
          const executed = await execute(transaction, loaded, recorder);
          const applied = await applyEncounterMutations(
            transaction, loaded, executed.state, executed.batch, executed.resolvedConsumables,
          );
          return persistTransition(
            transaction,
            loaded,
            applied.state,
            applied.authorities,
            operation,
            idempotencyRecordId,
            requestHash,
            recorder,
            executed.stopReason,
            executed.batch,
            executed.beatSummary,
            executed.batchSummary,
            executed.actionCatalogSource,
          );
        },
      );
    } catch (error) {
      return translate(error);
    }
  };

  return {
    async create(input: CreateEncounterInput): Promise<EncounterDto> {
      try {
        inputRecord(input, [
          'playerRef', 'worldRef', 'campaignRef', 'idempotencyKey', 'encounterRef',
          'setupMode', 'partySideRef', 'participants', 'relations', 'context', 'setupSummary',
        ]);
        assertReference(input.encounterRef);
        if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length < 8
          || input.idempotencyKey.length > 200
          || !Array.isArray(input.participants) || !Array.isArray(input.relations)) {
          throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
        }
        const normalizedInput = normalizeCreateInput(input);
        return await executeIdempotentEncounter(
          database,
          normalizedInput.idempotencyKey,
          idempotencyOperation.create,
          withoutIdempotency(normalizedInput),
          async (transaction, idempotencyRecordId, requestHash) => {
            let scope = await resolveScope(transaction, normalizedInput);
            await lockCampaign(transaction, scope.campaign.id);
            const lockedScope = await resolveScope(transaction, normalizedInput);
            if (lockedScope.campaign.id !== scope.campaign.id) {
              throw new EncounterError('ENCOUNTER_CAMPAIGN_TICK_DRIFT');
            }
            scope = lockedScope;
            const rulesetVersion = await transaction.rulesetVersion.findUnique({
              where: { id: scope.campaign.rulesetVersionId },
              select: {
                id: true, rulesetId: true, code: true, revision: true, schemaVersion: true,
                configHash: true, configSnapshot: true, ruleset: { select: { code: true } },
              },
            });
            if (rulesetVersion === null) throw new EncounterError('ENCOUNTER_MECHANICS_DRIFT');
            try {
              validateSupportedCoreRulesetVersion(rulesetVersion);
            } catch (error) {
              throw new EncounterError('ENCOUNTER_MECHANICS_DRIFT', { cause: error });
            }
            const existing = await transaction.encounter.findFirst({
              where: { campaignId: scope.campaign.id, lifecycleStatus: { in: [...ACTIVE_ENCOUNTER_LIFECYCLES] } },
              select: { id: true },
            });
            if (existing !== null) throw new EncounterError('ENCOUNTER_ALREADY_OPEN');
            const refs = normalizedInput.participants.map((participant) => participant.bindingKind === 'persisted_actor'
              ? participant.actorRef : participant.participant.actorRef);
            if (new Set(refs).size !== refs.length) throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
            const persistedInputs = normalizedInput.participants.filter((participant) => participant.bindingKind === 'persisted_actor');
            const actors = await transaction.actor.findMany({
              where: { campaignId: scope.campaign.id, code: { in: persistedInputs.map((participant) => participant.actorRef) } },
              select: { id: true, code: true },
              orderBy: { id: 'asc' },
            });
            if (actors.length !== persistedInputs.length) throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
            await lockActorAuthorities(transaction, actors.map((actor) => actor.id));
            const protagonist = actors.find((actor) => actor.code === normalizedInput.playerRef);
            if (protagonist !== undefined) {
              const readiness = await loadActorReadiness(transaction, protagonist.id);
              if (!readiness.canStartEncounter) {
                throw new EncounterError('ENCOUNTER_PARTICIPANT_NOT_READY', {
                  issues: readiness.blockingReasons.map((reason) => ({
                    path: `participants.${protagonist.code}`,
                    code: reason.toUpperCase(),
                    message: `Complete protagonist setup: ${reason}`,
                  })),
                });
              }
            }
            const authorities = await loadPersistedEncounterAuthorities(
              transaction,
              actors.map((actor) => actor.id),
              scope.campaign.engineTick,
            );
            const participants: CoreV1EncounterParticipantInput[] = [];
            for (const participant of normalizedInput.participants) {
              if (participant.bindingKind === 'ephemeral') {
                participants.push({
                  ...participant.participant,
                  actionSlots: createCoreV1EncounterActionSlots(scope.campaign.engineTick),
                });
                continue;
              }
              const authority = authorities.get(participant.actorRef);
              if (authority === undefined || authority.actor.campaignId !== scope.campaign.id) {
                throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
              }
              if (authority.actor.status !== ActorStatus.ACTIVE || authority.sheet.resources.hp.current === 0) {
                throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
              }
              const known = await transaction.actorContent.findMany({
                where: { actorId: authority.actor.id },
                include: { contentDefinition: true },
                orderBy: { contentDefinition: { code: 'asc' } },
              });
              participants.push({
                actorRef: participant.actorRef,
                sideRef: participant.sideRef,
                actorStateVersion: authority.actor.mechanicsStateVersion,
                mechanicsStateVersion: authority.actor.mechanicsStateVersion,
                inventoryStateVersion: authority.actor.inventoryStateVersion,
                effectsStateVersion: authority.actor.effectsStateVersion,
                zone: participant.zone,
                combatState: 'ready',
                primaryAttributes: authority.sheet.primaryAttributes,
                resources: {
                  hp: { current: authority.sheet.resources.hp.current, maximum: authority.sheet.resources.hp.max },
                  mana: { current: authority.sheet.resources.mana.current, maximum: authority.sheet.resources.mana.max },
                  sp: { current: authority.sheet.resources.sp.current, maximum: authority.sheet.resources.sp.max },
                  customResources: [],
                },
                secondaryAttributes: {
                  ...authority.sheet.secondaryAttributes,
                  elementalResistanceBps: authority.sheet.secondaryAttributes.elementalResistanceBps.default ?? 0,
                },
                activeEffects: authority.effects.activeEffects,
                actionSlots: createCoreV1EncounterActionSlots(scope.campaign.engineTick),
                reactionCapabilities: [],
                equipmentContext: {
                  inventory: authority.inventory.inventory,
                  loadout: authority.inventory.loadout,
                  requirements: {
                    level: authority.actor.level,
                    primaryAttributes: authority.sheet.primaryAttributes,
                    knownContentRefs: known.map((link) => ({
                      contentKind: normalizeEnum(link.contentDefinition.contentType) as import('../rules/core-v1/index.js').CoreV1ContentKind,
                      code: link.contentDefinition.code,
                    })),
                    equippedWeaponTags: [],
                    equippedEquipmentTags: [],
                    rulesetCode: 'core-v1',
                  },
                },
                initiative: {
                  tieBreak: 1,
                  surprised: participant.surprised ?? false,
                },
              });
            }
            const coreInput: CoreV1CreateEncounterInput = {
              encounterRef: normalizedInput.encounterRef,
              ...(normalizedInput.partySideRef === undefined ? {} : { partySideRef: normalizedInput.partySideRef }),
              currentTick: scope.campaign.engineTick,
              status: 'active',
              participants,
              relations: normalizedInput.relations,
            };
            coreValue(createCoreV1EncounterState(coreInput));
            const recorder = rollRecorderFactory(requestHash);
            const state = coreValue(createCoreV1EncounterState(coreInput, recorder));
            const encounterContext = normalizedInput.context ?? defaultEncounterContext();
            const actionCatalog = await loadEncounterActionCatalog(transaction, { state, authorities });
            const assistedSetup = normalizedInput.setupMode === 'assisted' && normalizedInput.setupSummary !== undefined
              ? (() => {
                const partyActors = new Set(state.participants
                  .filter((participant) => participant.sideRef === normalizedInput.partySideRef)
                  .map((participant) => participant.actorRef));
                const firstAvailableActions = [...actionCatalog].flatMap(([actorRef, catalog]) => {
                  if (!partyActors.has(actorRef)) return [];
                  return [...catalog.attacks, ...catalog.abilities, ...catalog.items]
                    .filter((action) => action.canUse)
                    .map((action) => ({
                      actorRef,
                      actionType: action.actionType,
                      targetRefs: [...action.validTargetRefs],
                    }));
                });
                const canApproach = state.participants.some((participant) => partyActors.has(participant.actorRef)
                  && participant.zone !== 'engaged' && participant.combatState === 'ready');
                if (firstAvailableActions.length === 0 && !canApproach) {
                  throw new EncounterError('ENCOUNTER_PARTICIPANT_NOT_READY', {
                    issues: [{
                      path: 'engagementPreference',
                      code: 'ASSISTED_SETUP_IMPOSSIBLE',
                      message: 'No party actor has an immediately usable action or a valid approach path.',
                    }],
                  });
                }
                return {
                  ...normalizedInput.setupSummary,
                  warnings: [
                    ...normalizedInput.setupSummary.warnings,
                    ...(firstAvailableActions.length === 0 ? ['approach_required_before_first_attack'] : []),
                  ],
                  firstAvailableActions,
                };
              })()
              : undefined;
            const snapshot = serializeCoreV1EncounterState(state);
            const stateHash = createCoreV1EncounterSnapshotHash(snapshot);
            const lifecycleStatus = deriveEncounterLifecycle(state, null);
            const encounter = await transaction.encounter.create({
              data: {
                campaignId: scope.campaign.id,
                rulesetVersionId: scope.campaign.rulesetVersionId,
                encounterRef: normalizedInput.encounterRef,
                lifecycleStatus,
                stateVersion: 1,
                currentTick: state.currentTick,
                snapshotSchemaVersion: 1,
                stateSnapshot: snapshot,
                stateHash,
              },
            });
            await transaction.encounterParticipant.createMany({
              data: normalizedInput.participants.map((participant) => {
                if (participant.bindingKind === 'ephemeral') return {
                  encounterId: encounter.id,
                  actorRef: participant.participant.actorRef,
                  bindingKind: EncounterParticipantBindingKind.EPHEMERAL,
                  ephemeralKind: {
                    summon: EncounterEphemeralKind.SUMMON,
                    projection: EncounterEphemeralKind.PROJECTION,
                    ephemeral_creature: EncounterEphemeralKind.EPHEMERAL_CREATURE,
                  }[participant.ephemeralKind],
                };
                const authority = authorities.get(participant.actorRef);
                if (authority === undefined) throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
                return {
                  encounterId: encounter.id,
                  actorId: authority.actor.id,
                  actorRef: participant.actorRef,
                  bindingKind: EncounterParticipantBindingKind.PERSISTED_ACTOR,
                  initialMechanicsStateVersion: authority.actor.mechanicsStateVersion,
                  initialInventoryStateVersion: authority.actor.inventoryStateVersion,
                  initialEffectsStateVersion: authority.actor.effectsStateVersion,
                };
              }),
            });
            const adapterState = adapterStateFromAuthorities(authorities);
            const createdOperation = await createEncounterOperation(transaction, {
              encounterId: encounter.id,
              idempotencyRecordId,
              operation: EncounterOperationKind.CREATE,
              previousStateVersion: 0,
              nextStateVersion: 1,
              inputHash: requestHash,
              beforeStateHash: absentEncounterStateHash(),
              afterStateHash: stateHash,
              stopReason: null,
              resultSummary: { adapterState, encounterContext } as unknown as Prisma.InputJsonValue,
            });
            await persistRolls(transaction, encounter.id, createdOperation.id, recorder);
            const participantRows = normalizedInput.participants.map((participant) => ({
              actorRef: participant.bindingKind === 'ephemeral' ? participant.participant.actorRef : participant.actorRef,
              bindingKind: participant.bindingKind === 'ephemeral'
                ? EncounterParticipantBindingKind.EPHEMERAL : EncounterParticipantBindingKind.PERSISTED_ACTOR,
            }));
            return dto(
              'create',
              { encounterRef: encounter.encounterRef, participants: participantRows },
              state,
              lifecycleStatus,
              null,
              undefined,
              undefined,
              encounterScenePackage(state, authorities, {
                lifecycleStatus: normalizeEnum(lifecycleStatus),
                context: encounterContext,
                actionCatalog,
              }),
              undefined,
              undefined,
              assistedSetup,
            );
          },
        );
      } catch (error) {
        if (error instanceof EncounterError && error.code === 'ENCOUNTER_CONSTRAINT_CONFLICT') throw error;
        if (isExpectedUniqueConflict(error, {
          modelName: 'Encounter', fields: ['campaignId'], index: 'Encounter_one_open_per_campaign_key',
        })) {
          throw new EncounterError('ENCOUNTER_ALREADY_OPEN', { cause: error });
        }
        return translate(error);
      }
    },

    async load(input: LoadEncounterInput): Promise<EncounterDto> {
      try {
        inputRecord(input, ['playerRef', 'worldRef', 'campaignRef', 'encounterRef']);
        assertReference(input.encounterRef);
        return await database.$transaction(async (transaction) => {
          const scope = await resolveScope(transaction, input);
          const loaded = await validateLoadedEncounter(
            transaction,
            await findEncounterRecord(transaction, scope.campaign.id, input.encounterRef),
          );
          const actionCatalog = await loadEncounterActionCatalog(transaction, loaded);
          return dto(
            'load',
            loaded.record,
            loaded.state,
            loaded.record.lifecycleStatus,
            loaded.record.stopReason === null ? null : normalizeEnum(loaded.record.stopReason),
            undefined,
            loaded.consequencesSummary,
            encounterScenePackage(loaded.state, loaded.authorities, {
              lifecycleStatus: normalizeEnum(loaded.record.lifecycleStatus),
              context: loaded.context ?? defaultEncounterContext(),
              actionCatalog,
            }),
          );
        }, {
          ...ENCOUNTER_TRANSACTION_OPTIONS,
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async submitIntent(input: SubmitEncounterIntentInput): Promise<EncounterDto> {
      validateMutationReference(input, ['intent']);
      const intent = coreValue(validateCoreV1EncounterActionIntent(input.intent));
      const normalizedInput = { ...input, intent };
      return mutate('submit_intent', normalizedInput, [EncounterLifecycleStatus.AWAITING_INTENT], async (transaction, loaded, recorder) => {
        const action = await loadAuthoritativeEncounterAction(transaction, loaded, intent);
        const batch = coreValue(applyCoreV1EncounterIntent({
          encounter: loaded.state,
          intent,
          ...action,
          runtime: { rolls: recorder },
        }));
        return { state: batch.encounterAfter, batch, stopReason: null };
      });
    },

    async resolveReaction(input: ResolveEncounterReactionInput): Promise<EncounterDto> {
      validateMutationReference(input, ['reactorActorRef', 'reactionKind']);
      assertReference(input.reactorActorRef);
      if (!['block', 'active_dodge', 'interrupt', 'counter_attack'].includes(input.reactionKind)) {
        throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
      }
      return mutate('resolve_reaction', input, [EncounterLifecycleStatus.AWAITING_REACTION], (_transaction, loaded, recorder) => {
        const event = loaded.state.scheduledEvents[0];
        if (event === undefined || !['reaction_resolved', 'counter_attack_started'].includes(event.type)
          || (event.targetRef ?? event.timelineEvent.actorRef) !== input.reactorActorRef
          || event.reactionKind !== input.reactionKind) {
          throw new EncounterError('ENCOUNTER_LIFECYCLE_CONFLICT');
        }
        const batch = coreValue(processNextCoreV1EncounterEvent(loaded.state, {
          rolls: recorder,
          reactionOutcomes: deterministicReactionResolver(input),
        }));
        return { state: batch.encounterAfter, batch, stopReason: batch.stopReason };
      });
    },

    async continue(input: ContinueEncounterInput): Promise<EncounterDto> {
      validateMutationReference(input);
      return mutate('continue', input, [EncounterLifecycleStatus.PROCESSING_PAUSED], (_transaction, loaded, recorder) => {
        const batch = processUntilReactionBoundary(loaded.state, { rolls: recorder });
        return { state: batch.encounterAfter, batch, stopReason: batch.stopReason };
      });
    },

    async resolveBeat(input: ResolveEncounterBeatInput): Promise<EncounterDto> {
      validateMutationReference(input, ['intent', 'npcDirectives', 'policy']);
      if ((input.intent === undefined) === (input.policy === undefined)) {
        throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
      }
      if (input.intent !== undefined) {
        inputRecord(input.intent, ['actorRef', 'objective', 'narrative', 'resolutionPolicy', 'components']);
        assertReference(input.intent.actorRef);
        if (typeof input.intent.objective !== 'string' || input.intent.objective.length < 1 || input.intent.objective.length > 120
          || typeof input.intent.narrative !== 'string' || input.intent.narrative.length < 1 || input.intent.narrative.length > 1_000
          || !['atomic', 'allow_partial'].includes(input.intent.resolutionPolicy)
          || !Array.isArray(input.intent.components) || input.intent.components.length < 1 || input.intent.components.length > 3
          || !Array.isArray(input.npcDirectives ?? []) || (input.npcDirectives ?? []).length > 16) {
          throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
        }
      } else if (input.policy !== undefined) {
        inputRecord(input.policy, [
          'actorRef', 'mode', 'strategy', 'objective', 'targetPriority', 'targetRefs',
          'protectedActorRefs', 'maximumBeats', 'resourcePolicy',
        ]);
        assertReference(input.policy.actorRef);
        if (!['until_decision', 'until_terminal', 'bounded'].includes(input.policy.mode)
          || !['aggressive', 'balanced', 'defensive', 'support', 'protect_target', 'escape'].includes(input.policy.strategy)
          || typeof input.policy.objective !== 'string' || input.policy.objective.length < 1 || input.policy.objective.length > 120
          || !['nearest_hostile', 'lowest_hp_hostile', 'explicit'].includes(input.policy.targetPriority)
          || !Number.isSafeInteger(input.policy.maximumBeats) || input.policy.maximumBeats < 1 || input.policy.maximumBeats > 12
          || !Array.isArray(input.policy.protectedActorRefs)) {
          throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
        }
      }
      const prefix = calculateEncounterRequestHash(withoutIdempotency(input)).slice(0, 20);
      return mutate('resolve_beat', input, [
        EncounterLifecycleStatus.AWAITING_INTENT,
        EncounterLifecycleStatus.AWAITING_REACTION,
        EncounterLifecycleStatus.PROCESSING_PAUSED,
      ], async (transaction, loaded, recorder) => {
        let current = loaded.state;
        const reports: CoreV1EncounterBatchResult[] = [];
        if (loaded.record.lifecycleStatus !== EncounterLifecycleStatus.AWAITING_INTENT) {
          const resumed = coreValue(processCoreV1EncounterBatch(current, {
            rolls: recorder, reactionOutcomes: automaticReactionResolver(),
          }));
          reports.push(resumed);
          current = resumed.encounterAfter;
        }
        let beatSummary: EncounterBeatSummaryDto | undefined;
        const resolvedConsumables: {
          readonly actionRef: string;
          readonly actorRef: string;
          readonly entryRef: string;
        }[] = [];
        let beatsProcessed = 0;
        let stopCategory: EncounterBatchSummaryDto['stopCategory'] = 'decision';
        let decisionReason: string | null = null;
        let availableAlternatives: readonly string[] = [];
        let actionCatalogSource: EncounterActionCatalogSource | undefined;

        if (input.intent !== undefined) {
          const normalizedComponents = input.intent.components.map((component) => (
            normalizeBeatComponent(current, input.intent?.actorRef ?? '', component)
          ));
          const fleeAlreadyComplete = normalizedComponents.length > 0
            && input.intent.components.every((component) => component.type === 'flee' && component.when === undefined)
            && normalizedComponents.every((component) => component.completedFlee === true);
          if (fleeAlreadyComplete) {
            current = { ...current, stateVersion: current.stateVersion + 1 };
            beatSummary = {
              externalTransitions: 1,
              resolutionPolicy: input.intent.resolutionPolicy,
              partialResolutionApplied: false,
              actorsActed: [],
              componentResults: input.intent.components.map((component, index) => {
                const normalized = normalizedComponents[index];
                if (normalized?.modification === undefined) {
                  throw new EncounterError('ENCOUNTER_INTERNAL');
                }
                return {
                  index,
                  type: component.type,
                  status: 'modified' as const,
                  code: normalized.modification.code,
                  reason: normalized.modification.reason,
                  field: `intent.components.${String(index)}.${normalized.modification.field}`,
                  requested: componentSnapshot(component),
                  applied: componentSnapshot(normalized.component),
                };
              }),
              npcActions: [],
              npcResults: [],
              requiresPlayerDecision: true,
            };
            decisionReason = 'flee_completed';
          } else {
            const one = await executeOneResolvedBeat(
              transaction, loaded, current, input.intent, input.npcDirectives ?? [], prefix, recorder,
            );
            current = one.state;
            reports.push(...one.reports);
            resolvedConsumables.push(...one.resolvedConsumables);
            beatSummary = one.beatSummary;
            beatsProcessed = 1;
            stopCategory = current.status === 'completed' ? 'terminal' : 'decision';
            decisionReason = current.status === 'completed' ? null : 'plan_completed';
          }
        } else if (input.policy !== undefined) {
          actionCatalogSource = await loadEncounterActionCatalogSource(transaction, loaded);
          const automaticActorRefs = new Set([input.policy.actorRef]);
          const consumedEntryCounts = new Map<string, number>();
          let automaticActorCatalog = projectEncounterActionCatalog(
            actionCatalogSource,
            { state: current, authorities: loaded.authorities },
            { actorRefs: automaticActorRefs, consumedEntryCounts },
          ).get(input.policy.actorRef);
          for (let beatIndex = 0; beatIndex < input.policy.maximumBeats; beatIndex += 1) {
            const policyStop = automaticPolicyStop(current, input.policy);
            if (policyStop !== undefined) {
              decisionReason = policyStop.reason;
              availableAlternatives = policyStop.alternatives;
              break;
            }
            const selected = selectAutomaticComponent(current, input.policy, automaticActorCatalog);
            if ('stopReason' in selected) {
              decisionReason = selected.stopReason;
              availableAlternatives = selected.alternatives;
              break;
            }
            const one = await executeOneResolvedBeat(
              transaction,
              loaded,
              current,
              {
                actorRef: input.policy.actorRef,
                objective: input.policy.objective,
                narrative: 'Automatic policy selected an authoritative available action.',
                resolutionPolicy: 'atomic',
                components: [selected.component],
              },
              [],
              `${prefix}-auto-${beatIndex}`,
              recorder,
              actionCatalogSource,
            );
            current = one.state;
            reports.push(...one.reports);
            resolvedConsumables.push(...one.resolvedConsumables);
            for (const consumed of one.resolvedConsumables) {
              const key = `${consumed.actorRef}:${consumed.entryRef}`;
              consumedEntryCounts.set(key, (consumedEntryCounts.get(key) ?? 0) + 1);
            }
            beatSummary = one.beatSummary;
            beatsProcessed += 1;
            if (current.status === 'completed') {
              stopCategory = 'terminal';
              break;
            }
            const afterStop = automaticPolicyStop(current, input.policy);
            if (afterStop !== undefined) {
              decisionReason = afterStop.reason;
              availableAlternatives = afterStop.alternatives;
              break;
            }
            automaticActorCatalog = projectEncounterActionCatalog(
              actionCatalogSource,
              { state: current, authorities: loaded.authorities },
              { actorRefs: automaticActorRefs, consumedEntryCounts },
            ).get(input.policy.actorRef);
            if (beatIndex + 1 === input.policy.maximumBeats) stopCategory = 'technical';
          }
          if (beatsProcessed === 0) current = { ...current, stateVersion: current.stateVersion + 1 };
          if (current.status !== 'completed' && decisionReason === null) stopCategory = 'technical';
        }
        const terminal = current.status === 'completed';
        const finalStopReason = terminal ? 'encounter_completed'
          : stopCategory === 'technical' ? 'processing_limit' : 'new_intent_required';
        const merged = reports.length === 0 ? undefined : mergeReports(loaded.state, reports, finalStopReason);
        const batch = merged === undefined ? undefined : { ...merged, encounterAfter: current };
        if (beatSummary !== undefined) {
          beatSummary = {
            ...beatSummary,
            requiresPlayerDecision: stopCategory === 'decision',
          };
        }
        const actionsResolved = reports.reduce((total, report) => total + report.resolvedActions.length, 0);
        const actorsActed = [...new Set(reports.flatMap((report) => report.processedEvents
          .map((event) => event.timelineEvent.actorRef)))].sort();
        const processedEventCount = reports.reduce((total, report) => total + report.processedEvents.length, 0);
        const batchSummary: EncounterBatchSummaryDto = {
          mode: input.policy === undefined ? 'plan' : 'automatic',
          startingStateVersion: loaded.state.stateVersion,
          endingStateVersion: current.stateVersion,
          beatsProcessed,
          actionsResolved,
          actorsActed,
          stopReason: decisionReason ?? finalStopReason,
          stopCategory,
          requiresPlayerDecision: stopCategory === 'decision',
          decisionReason,
          availableAlternatives,
          terminalCandidate: current.completionCandidate,
          narrativeFacts: [
            `${String(beatsProcessed)} beat${beatsProcessed === 1 ? '' : 's'} processed.`,
            `${String(actionsResolved)} authoritative action${actionsResolved === 1 ? '' : 's'} resolved.`,
            `${String(processedEventCount)} timeline event${processedEventCount === 1 ? '' : 's'} processed; the public timeline exposes at most 32 while deltas remain complete.`,
            ...(current.completionCandidate === null ? [] : [`Terminal candidate: ${current.completionCandidate}.`]),
          ],
        };
        return {
          state: current,
          ...(batch === undefined ? {} : { batch }),
          stopReason: finalStopReason,
          ...(beatSummary === undefined ? {} : { beatSummary }),
          batchSummary,
          resolvedConsumables,
          ...(actionCatalogSource === undefined ? {} : { actionCatalogSource }),
        };
      });
    },

    async confirmCompletion(input: ConfirmEncounterCompletionInput): Promise<EncounterDto> {
      validateMutationReference(input);
      return mutate('confirm_completion', input, [EncounterLifecycleStatus.COMPLETION_PENDING], (_transaction, loaded) => ({
        state: coreValue(confirmCoreV1EncounterCompletion(loaded.state)),
        stopReason: 'encounter_completed',
      }));
    },

    async cancel(input: CancelEncounterInput): Promise<EncounterDto> {
      validateMutationReference(input);
      return mutate('cancel', input, ACTIVE_ENCOUNTER_LIFECYCLES, (_transaction, loaded) => ({
        state: coreValue(cancelCoreV1Encounter(loaded.state)),
        stopReason: null,
      }));
    },

    async abandon(input: AbandonEncounterInput): Promise<EncounterDto> {
      validateMutationReference(input, ['confirmAuthorityDrift']);
      if (input.confirmAuthorityDrift !== true) throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
      try {
        return await executeIdempotentEncounter(
          database,
          input.idempotencyKey,
          idempotencyOperation.abandon,
          withoutIdempotency(input),
          async (transaction, idempotencyRecordId, requestHash) => {
            const scope = await resolveScope(transaction, input);
            const initial = await findEncounterRecord(transaction, scope.campaign.id, input.encounterRef);
            await lockCampaign(transaction, scope.campaign.id);
            await lockEncounter(transaction, initial.id);
            const actorIds = initial.participants.flatMap((participant) => participant.actorId === null ? [] : [participant.actorId]);
            await lockEncounterAuthorities(transaction, initial.id, actorIds);
            const record = await findEncounterRecord(transaction, scope.campaign.id, input.encounterRef);
            if (record.stateVersion !== input.expectedStateVersion) {
              throw new EncounterError('ENCOUNTER_EXPECTED_VERSION_CONFLICT');
            }
            if (!ACTIVE_ENCOUNTER_LIFECYCLES.includes(record.lifecycleStatus as typeof ACTIVE_ENCOUNTER_LIFECYCLES[number])) {
              throw new EncounterError('ENCOUNTER_LIFECYCLE_CONFLICT');
            }
            let drift: EncounterError | undefined;
            try {
              await validateLoadedEncounter(transaction, record);
            } catch (error) {
              if (!(error instanceof EncounterError) || !recoverableAuthorityDrift.has(error.code)) throw error;
              drift = error;
            }
            if (drift === undefined) throw new EncounterError('ENCOUNTER_LIFECYCLE_CONFLICT');
            const loaded = await validateLoadedEncounter(transaction, record, { skipCurrentAuthorities: true });
            const participantIds = new Set(actorIds);
            const ownedEffects = await transaction.activeEffect.findMany({
              where: { originEncounterId: record.id },
              select: { id: true, targetActorId: true, durationType: true },
            });
            if (ownedEffects.some((effect) => effect.durationType !== ActiveEffectDurationType.ENCOUNTER
              || !participantIds.has(effect.targetActorId))) {
              throw new EncounterError('ENCOUNTER_EFFECT_OWNERSHIP_CONFLICT');
            }
            if (ownedEffects.length > 0) {
              await transaction.activeEffect.deleteMany({ where: { id: { in: ownedEffects.map((effect) => effect.id) } } });
              for (const actorId of [...new Set(ownedEffects.map((effect) => effect.targetActorId))].sort()) {
                await transaction.actor.update({
                  where: { id: actorId },
                  data: { effectsStateVersion: { increment: 1 }, mechanicsStateVersion: { increment: 1 } },
                });
                await recomputeActorDerivedSnapshot(transaction, actorId);
              }
            }
            const failedState: CoreV1EncounterState = {
              ...loaded.state,
              status: 'failed',
              stateVersion: loaded.state.stateVersion + 1,
              completionCandidate: null,
            };
            const snapshot = serializeCoreV1EncounterState(failedState);
            const stateHash = createCoreV1EncounterSnapshotHash(snapshot);
            const stopReason = databaseStopReason('encounter_failed');
            const updated = await transaction.encounter.updateMany({
              where: { id: record.id, stateVersion: record.stateVersion, stateHash: record.stateHash },
              data: {
                lifecycleStatus: EncounterLifecycleStatus.FAILED,
                stateVersion: failedState.stateVersion,
                completionCandidate: null,
                stopReason,
                stateSnapshot: snapshot,
                stateHash,
                closedAt: new Date(),
              },
            });
            if (updated.count !== 1) throw new EncounterError('ENCOUNTER_EXPECTED_VERSION_CONFLICT');
            await createEncounterOperation(transaction, {
              encounterId: record.id,
              idempotencyRecordId,
              operation: EncounterOperationKind.CANCEL,
              previousStateVersion: loaded.state.stateVersion,
              nextStateVersion: failedState.stateVersion,
              inputHash: requestHash,
              beforeStateHash: record.stateHash,
              afterStateHash: stateHash,
              stopReason,
              resultSummary: { adapterState: loaded.adapterState } as unknown as Prisma.InputJsonValue,
            });
            return dto(
              'abandon', record, failedState, EncounterLifecycleStatus.FAILED, 'encounter_failed',
              undefined, undefined, undefined, undefined, {
                reason: 'authority_drift',
                authority: authorityFromDrift(drift.code),
                actionResolved: false,
                damageApplied: false,
                costApplied: false,
                rewardsGranted: false,
                campaignReleased: true,
              },
            );
          },
        );
      } catch (error) {
        return translate(error);
      }
    },
  };
}

export const encounterService = createEncounterService();

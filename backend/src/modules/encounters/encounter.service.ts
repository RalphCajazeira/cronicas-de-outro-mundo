import {
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
import { validateCoreV1RulesetVersion } from '../rules/ruleset.registry.js';
import {
  applyCoreV1EncounterIntent,
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
  type ReactionOutcomeResolver,
} from '../rules/core-v1/index.js';
import { loadAuthoritativeEncounterAction } from './encounter-action-loader.js';
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
  type CancelEncounterInput,
  type ConfirmEncounterCompletionInput,
  type ContinueEncounterInput,
  type CreateEncounterInput,
  type EncounterDto,
  type EncounterMutationReference,
  type EncounterOperationName,
  type LoadEncounterInput,
  type ResolveEncounterReactionInput,
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
} as const;

const operationKind = {
  create: EncounterOperationKind.CREATE,
  submit_intent: EncounterOperationKind.SUBMIT_INTENT,
  resolve_reaction: EncounterOperationKind.RESOLVE_REACTION,
  continue: EncounterOperationKind.CONTINUE,
  confirm_completion: EncounterOperationKind.CONFIRM_COMPLETION,
  cancel: EncounterOperationKind.CANCEL,
} as const;

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
  });
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
  const persistedOperation = await createEncounterOperation(transaction, {
    encounterId: loaded.record.id,
    idempotencyRecordId,
    operation: operationKind[operation],
    previousStateVersion: loaded.state.stateVersion,
    nextStateVersion: persistedState.stateVersion,
    inputHash: requestHash,
    beforeStateHash: loaded.record.stateHash,
    afterStateHash: stateHash,
    stopReason: databaseStopReason(stopReason),
    resultSummary: {
      adapterState,
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
  return dto(operation, loaded.record, persistedState, lifecycleStatus, stopReason, batch, terminal?.summary);
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
    throw new EncounterError('ENCOUNTER_DENORMALIZED_DRIFT', { cause: error });
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
    ) => Promise<{ readonly state: CoreV1EncounterState; readonly batch?: CoreV1EncounterBatchResult; readonly stopReason: string | null }>
      | { readonly state: CoreV1EncounterState; readonly batch?: CoreV1EncounterBatchResult; readonly stopReason: string | null },
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
          const applied = await applyEncounterMutations(transaction, loaded, executed.state, executed.batch);
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
          'partySideRef', 'participants', 'relations',
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
              validateCoreV1RulesetVersion(rulesetVersion);
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
              resultSummary: { adapterState } as unknown as Prisma.InputJsonValue,
            });
            await persistRolls(transaction, encounter.id, createdOperation.id, recorder);
            const participantRows = normalizedInput.participants.map((participant) => ({
              actorRef: participant.bindingKind === 'ephemeral' ? participant.participant.actorRef : participant.actorRef,
              bindingKind: participant.bindingKind === 'ephemeral'
                ? EncounterParticipantBindingKind.EPHEMERAL : EncounterParticipantBindingKind.PERSISTED_ACTOR,
            }));
            return dto('create', { encounterRef: encounter.encounterRef, participants: participantRows }, state, lifecycleStatus, null);
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
          return dto(
            'load',
            loaded.record,
            loaded.state,
            loaded.record.lifecycleStatus,
            loaded.record.stopReason === null ? null : normalizeEnum(loaded.record.stopReason),
            undefined,
            loaded.consequencesSummary,
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
  };
}

export const encounterService = createEncounterService();

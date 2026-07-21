import {
  ActiveEffectDurationType,
  ActorStatus,
  ActorType,
  type Prisma,
} from '../../generated/prisma/client.js';
import { normalizeEnum } from '../../shared/http/normalize-enum.js';
import { recomputeActorDerivedSnapshot } from '../actors/actor-mechanics.service.js';
import type { CoreV1EncounterState } from '../rules/core-v1/index.js';
import {
  databaseEncounterOutcome,
  encounterTerminalEventIdempotencyKey,
  parseEncounterConsequenceSummary,
  parseEncounterTerminalEventPayload,
  type EncounterActorStatusValue,
  type EncounterConsequenceActorState,
  type EncounterConsequenceSummaryV1,
  type EncounterOutcomeValue,
  type EncounterTerminalEventPayloadV1,
  type EncounterTerminalEventType,
} from './encounter-consequence.js';
import { EncounterError } from './encounter.errors.js';
import { reconcileEncounterParticipant } from './encounter-mutation-applier.js';
import type { EncounterTransaction } from './encounter.repository.js';
import {
  loadPersistedEncounterAuthorities,
  type LoadedEncounter,
  type PersistedEncounterAuthority,
} from './encounter-state-loader.js';

const eventByOutcome: Readonly<Record<EncounterOutcomeValue, EncounterTerminalEventType>> = {
  party_victory: 'encounter-completed',
  party_defeat: 'encounter-defeated',
  stalemate: 'encounter-stalemate',
  cancelled: 'encounter-cancelled',
};

const titleByOutcome: Readonly<Record<EncounterOutcomeValue, string>> = {
  party_victory: 'Encounter completed',
  party_defeat: 'Party defeated',
  stalemate: 'Encounter ended in stalemate',
  cancelled: 'Encounter cancelled',
};

export function encounterTerminalActorStatus(
  status: ActorStatus,
  hp: number,
  persisted: boolean,
): ActorStatus {
  return persisted && status === ActorStatus.ACTIVE && hp === 0 ? ActorStatus.DEFEATED : status;
}

export function encounterOutcomeFromCandidate(
  candidate: CoreV1EncounterState['completionCandidate'],
): EncounterOutcomeValue {
  const outcome = candidate === null ? undefined : {
    party_victory_candidate: 'party_victory' as const,
    hostile_victory_candidate: 'party_defeat' as const,
    stalemate_candidate: 'stalemate' as const,
    cancelled: 'cancelled' as const,
  }[candidate];
  if (outcome === undefined) throw new EncounterError('ENCOUNTER_DENORMALIZED_DRIFT');
  return outcome;
}

function resourceState(authority: PersistedEncounterAuthority, key: 'hp' | 'mana' | 'sp') {
  const resource = authority.sheet.resources[key];
  return { current: resource.current, maximum: resource.max, stateVersion: resource.stateVersion };
}

function actorAuditState(
  before: PersistedEncounterAuthority,
  after: PersistedEncounterAuthority,
): EncounterConsequenceActorState {
  const transition = (key: 'hp' | 'mana' | 'sp') => ({
    before: resourceState(before, key),
    after: resourceState(after, key),
  });
  return {
    actorRef: before.actor.code,
    statusBefore: normalizeEnum(before.actor.status) as EncounterActorStatusValue,
    statusAfter: normalizeEnum(after.actor.status) as EncounterActorStatusValue,
    mechanicsStateVersion: {
      before: before.actor.mechanicsStateVersion,
      after: after.actor.mechanicsStateVersion,
    },
    inventoryStateVersion: {
      before: before.actor.inventoryStateVersion,
      after: after.actor.inventoryStateVersion,
    },
    effectsStateVersion: {
      before: before.actor.effectsStateVersion,
      after: after.actor.effectsStateVersion,
    },
    resources: { hp: transition('hp'), mana: transition('mana'), sp: transition('sp') },
  };
}

export interface AppliedTerminalConsequences {
  readonly state: CoreV1EncounterState;
  readonly authorities: ReadonlyMap<string, PersistedEncounterAuthority>;
  readonly summary: EncounterConsequenceSummaryV1;
  readonly eventPayload: EncounterTerminalEventPayloadV1;
  readonly protagonistActorId: string | null;
}

export async function applyEncounterTerminalConsequences(
  transaction: EncounterTransaction,
  loaded: LoadedEncounter,
  state: CoreV1EncounterState,
  authoritiesBefore: ReadonlyMap<string, PersistedEncounterAuthority>,
): Promise<AppliedTerminalConsequences> {
  const outcome = encounterOutcomeFromCandidate(state.completionCandidate);
  const persisted = loaded.record.participants.filter((participant) => participant.actorId !== null);
  const actorIds = persisted.map((participant) => participant.actorId as string);
  const actorRefById = new Map(persisted.map((participant) => [participant.actorId as string, participant.actorRef]));
  const removable = await transaction.activeEffect.findMany({
    where: {
      originEncounterId: loaded.record.id,
      durationType: ActiveEffectDurationType.ENCOUNTER,
      targetActorId: { in: actorIds },
    },
    select: { id: true, targetActorId: true, effectRef: true },
    orderBy: [{ targetActorId: 'asc' }, { effectRef: 'asc' }],
  });
  const removedByActor = new Map<string, string[]>();
  const changedActorRefs: string[] = [];
  for (const effect of removable) {
    const actorRef = actorRefById.get(effect.targetActorId);
    if (actorRef === undefined) throw new EncounterError('ENCOUNTER_EFFECT_OWNERSHIP_CONFLICT');
    const refs = removedByActor.get(actorRef) ?? [];
    refs.push(effect.effectRef);
    removedByActor.set(actorRef, refs);
  }
  if (removable.length > 0) {
    const deleted = await transaction.activeEffect.deleteMany({ where: { id: { in: removable.map((effect) => effect.id) } } });
    if (deleted.count !== removable.length) throw new EncounterError('ENCOUNTER_EFFECT_OWNERSHIP_CONFLICT');
  }

  for (const participant of persisted) {
    const authority = authoritiesBefore.get(participant.actorRef);
    const projected = state.participants.find((candidate) => candidate.actorRef === participant.actorRef);
    if (authority === undefined || projected === undefined) throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
    const removeEffects = removedByActor.has(participant.actorRef);
    const nextStatus = encounterTerminalActorStatus(authority.actor.status, projected.resources.hp.current, true);
    const defeat = nextStatus !== authority.actor.status;
    if (!removeEffects && !defeat) continue;
    const updated = await transaction.actor.updateMany({
      where: {
        id: authority.actor.id,
        status: authority.actor.status,
        mechanicsStateVersion: authority.actor.mechanicsStateVersion,
        effectsStateVersion: authority.actor.effectsStateVersion,
      },
      data: {
        ...(defeat ? { status: nextStatus } : {}),
        ...(removeEffects ? {
          effectsStateVersion: { increment: 1 },
          mechanicsStateVersion: { increment: 1 },
        } : {}),
      },
    });
    if (updated.count !== 1) throw new EncounterError('ENCOUNTER_MECHANICS_DRIFT');
    if (removeEffects) await recomputeActorDerivedSnapshot(transaction, authority.actor.id);
    changedActorRefs.push(participant.actorRef);
  }

  let authorities = authoritiesBefore;
  if (changedActorRefs.length > 0) {
    const changedActorIds = changedActorRefs.map((actorRef) => {
      const authority = authoritiesBefore.get(actorRef);
      if (authority === undefined) throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
      return authority.actor.id;
    });
    const reloadedAuthorities = await loadPersistedEncounterAuthorities(
      transaction,
      changedActorIds,
      state.currentTick,
    );
    const mergedAuthorities = new Map(authoritiesBefore);
    for (const actorRef of changedActorRefs) {
      const authority = reloadedAuthorities.get(actorRef);
      if (authority === undefined) throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
      mergedAuthorities.set(actorRef, authority);
    }
    authorities = mergedAuthorities;
  }
  const actors = [...authoritiesBefore.keys()].sort().map((actorRef) => {
    const before = authoritiesBefore.get(actorRef);
    const after = authorities.get(actorRef);
    if (before === undefined || after === undefined) throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
    return actorAuditState(before, after);
  });
  const world = await transaction.world.findUnique({
    where: { id: loaded.record.campaign.worldId },
    select: { player: { select: { slug: true } } },
  });
  if (world === null) throw new EncounterError('ENCOUNTER_DENORMALIZED_DRIFT');
  const protagonist = await transaction.actor.findFirst({
    where: {
      id: { in: actorIds }, campaignId: loaded.record.campaignId,
      code: world.player.slug, actorType: ActorType.CHARACTER,
    },
    select: { id: true, code: true },
  });
  const eventType = eventByOutcome[outcome];
  const summary = parseEncounterConsequenceSummary({
    schemaVersion: 1,
    outcome,
    actors,
    removedEncounterEffects: [...removedByActor]
      .map(([actorRef, effectRefs]) => ({ actorRef, effectRefs: [...effectRefs].sort() }))
      .sort((left, right) => left.actorRef.localeCompare(right.actorRef)),
    event: { eventType, actorRef: protagonist?.code ?? null },
  });
  const eventPayload = parseEncounterTerminalEventPayload({
    schemaVersion: 1,
    encounterRef: loaded.record.encounterRef,
    outcome,
    affectedActorRefs: actors.map((actor) => actor.actorRef),
    defeatedActorRefs: actors
      .filter((actor) => actor.statusAfter === 'defeated')
      .map((actor) => actor.actorRef),
    removedEncounterEffectCount: removable.length,
  });
  return {
    state: {
      ...state,
      participants: state.participants.map((participant) => {
        const authority = authorities.get(participant.actorRef);
        return authority === undefined ? participant : reconcileEncounterParticipant(participant, authority);
      }),
    },
    authorities,
    summary,
    eventPayload,
    protagonistActorId: protagonist?.id ?? null,
  };
}

export async function persistEncounterTerminalConsequence(
  transaction: EncounterTransaction,
  input: {
    readonly loaded: LoadedEncounter;
    readonly encounterOperationId: string;
    readonly summary: EncounterConsequenceSummaryV1;
    readonly eventPayload: EncounterTerminalEventPayloadV1;
    readonly protagonistActorId: string | null;
  },
): Promise<void> {
  const gameEvent = await transaction.gameEvent.create({
    data: {
      campaignId: input.loaded.record.campaignId,
      actorId: input.protagonistActorId,
      eventType: input.summary.event.eventType,
      title: titleByOutcome[input.summary.outcome],
      payload: input.eventPayload as unknown as Prisma.InputJsonValue,
      idempotencyKey: encounterTerminalEventIdempotencyKey(input.loaded.record.id),
    },
    select: { id: true },
  });
  await transaction.encounterConsequence.create({
    data: {
      encounterId: input.loaded.record.id,
      encounterOperationId: input.encounterOperationId,
      gameEventId: gameEvent.id,
      consequenceSchemaVersion: 1,
      rewardPolicyVersion: null,
      outcome: databaseEncounterOutcome(input.summary.outcome),
      resultSummary: input.summary as unknown as Prisma.InputJsonValue,
    },
  });
}

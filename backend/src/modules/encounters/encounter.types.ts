import type { CampaignReference } from '../../shared/database/game-scope.js';
import { EncounterLifecycleStatus } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors/app-error.js';
import { normalizeEnum } from '../../shared/http/normalize-enum.js';
import type {
  CombatZone,
  CoreV1EncounterActionIntent,
  CoreV1EncounterParticipantInput,
  CoreV1EncounterParticipantRelation,
} from '../rules/core-v1/index.js';
import {
  parseEncounterPublicConsequencesSummary,
  type EncounterPublicConsequencesSummaryV1,
} from './encounter-consequence.js';

export const ACTIVE_ENCOUNTER_LIFECYCLES = [
  EncounterLifecycleStatus.AWAITING_INTENT,
  EncounterLifecycleStatus.AWAITING_REACTION,
  EncounterLifecycleStatus.PROCESSING_PAUSED,
  EncounterLifecycleStatus.COMPLETION_PENDING,
] as const;

export interface ActiveEncounterRecord {
  readonly encounterRef: string;
  readonly lifecycleStatus: EncounterLifecycleStatus;
  readonly stateVersion: number;
}

export function activeEncounterSummary(
  records: readonly ActiveEncounterRecord[],
  integrityStatus: 'validated' | 'authority_drift' | 'unverified' = 'unverified',
) {
  if (records.length === 0) return null;
  if (records.length > 1) {
    throw new AppError(500, 'ACTIVE_ENCOUNTER_INTEGRITY_ERROR', 'Campaign has multiple active encounters', {
      retryable: false,
      recoveryAction: 'stop_encounter_flow',
      auditCode: 'MULTIPLE_ACTIVE_ENCOUNTERS',
      issues: [{
        path: 'activeEncounter',
        code: 'MULTIPLE_ACTIVE_ENCOUNTERS',
        message: 'Do not choose an encounter automatically; request administrative repair.',
      }],
    });
  }
  const encounter = records[0];
  if (encounter === undefined) throw new TypeError('Active encounter lookup returned an invalid result');
  return {
    encounterRef: encounter.encounterRef,
    lifecycleStatus: normalizeEnum(encounter.lifecycleStatus),
    stateVersion: encounter.stateVersion,
    canContinue: integrityStatus === 'validated',
    canCancel: integrityStatus === 'validated',
    canAbandon: integrityStatus === 'authority_drift',
    integrityStatus,
    recoveryAction: integrityStatus === 'validated' ? 'load_encounter'
      : integrityStatus === 'authority_drift' ? 'abandon_encounter' : 'stop_encounter_flow',
  };
}

export type EncounterOperationName =
  | 'create' | 'submit_intent' | 'resolve_reaction' | 'continue'
  | 'confirm_completion' | 'cancel' | 'abandon' | 'resolve_beat';

export interface EncounterPersistedParticipantInput {
  readonly bindingKind: 'persisted_actor';
  readonly actorRef: string;
  readonly sideRef: string;
  readonly zone: CombatZone;
  readonly surprised?: boolean;
}

export interface EncounterEphemeralParticipantInput {
  readonly bindingKind: 'ephemeral';
  readonly ephemeralKind: 'summon' | 'projection' | 'ephemeral_creature';
  readonly participant: Omit<CoreV1EncounterParticipantInput, 'actionSlots'>;
}

export interface CreateEncounterInput extends CampaignReference {
  readonly idempotencyKey: string;
  readonly encounterRef: string;
  readonly partySideRef?: string;
  readonly participants: readonly (EncounterPersistedParticipantInput | EncounterEphemeralParticipantInput)[];
  readonly relations: readonly CoreV1EncounterParticipantRelation[];
}

export interface EncounterReference extends CampaignReference {
  readonly encounterRef: string;
}

export interface EncounterMutationReference extends EncounterReference {
  readonly idempotencyKey: string;
  readonly expectedStateVersion: number;
}

export interface SubmitEncounterIntentInput extends EncounterMutationReference {
  readonly intent: CoreV1EncounterActionIntent;
}

export interface ResolveEncounterReactionInput extends EncounterMutationReference {
  readonly reactorActorRef: string;
  readonly reactionKind: 'block' | 'active_dodge' | 'interrupt' | 'counter_attack';
}

export type EncounterBeatComponent = (
  | { readonly type: 'move'; readonly destination: CombatZone; readonly movementKind?: 'approach' | 'retreat' | 'run' | 'disengage' }
  | { readonly type: 'defend' }
  | { readonly type: 'protect'; readonly targetRef: string }
  | { readonly type: 'prepare'; readonly contentRef: NonNullable<CoreV1EncounterActionIntent['contentRef']>; readonly trigger: 'enemy_advances' | 'enemy_attacks' | 'ally_attacked'; readonly targetRefs?: readonly string[] }
  | { readonly type: 'intercept'; readonly targetRef: string }
  | { readonly type: 'assist'; readonly targetRef: string }
  | { readonly type: 'flee'; readonly destination?: 'far' | 'out_of_range' }
  | { readonly type: 'observe'; readonly targetRef?: string }
  | { readonly type: 'interact'; readonly targetRef: string; readonly description?: string }
  | { readonly type: 'improvise'; readonly description: string; readonly targetRef?: string }
  | { readonly type: 'use_item'; readonly inventoryEntryRef: string; readonly targetRefs?: readonly string[] }
  | { readonly type: 'attack'; readonly inventoryEntryRef: string; readonly targetRefs: readonly string[]; readonly versatileMode?: 'one_handed' | 'two_handed' }
  | { readonly type: 'cast'; readonly contentRef: NonNullable<CoreV1EncounterActionIntent['contentRef']>; readonly targetRefs?: readonly string[] }
) & { readonly essential?: boolean };

export interface EncounterNpcDirective {
  readonly actorRef: string;
  readonly strategy: 'aggressive' | 'defensive' | 'protect_ally' | 'attack_vulnerable' | 'flee_if_hurt' | 'prioritize_caster';
  readonly targetRef?: string;
}

export interface ResolveEncounterBeatInput extends EncounterMutationReference {
  readonly intent: {
    readonly actorRef: string;
    readonly objective: string;
    readonly narrative: string;
    readonly resolutionPolicy: 'atomic' | 'allow_partial';
    readonly components: readonly EncounterBeatComponent[];
  };
  readonly npcDirectives: readonly EncounterNpcDirective[];
}

export type ContinueEncounterInput = EncounterMutationReference;
export type ConfirmEncounterCompletionInput = EncounterMutationReference;
export type CancelEncounterInput = EncounterMutationReference;
export interface AbandonEncounterInput extends EncounterMutationReference {
  readonly confirmAuthorityDrift: true;
}
export type LoadEncounterInput = EncounterReference;

export interface EncounterParticipantDto {
  readonly actorRef: string;
  readonly bindingKind: 'persisted_actor' | 'ephemeral';
  readonly sideRef: string;
  readonly combatState: string;
  readonly zone: string;
  readonly resources: {
    readonly hp: { readonly current: number; readonly maximum: number };
    readonly mana: { readonly current: number; readonly maximum: number };
    readonly sp: { readonly current: number; readonly maximum: number };
  };
}

export type EncounterGenericAction =
  | 'move' | 'defend' | 'protect' | 'prepare' | 'intercept' | 'assist' | 'flee'
  | 'observe' | 'interact' | 'improvise' | 'use_item' | 'attack' | 'cast';

export interface EncounterScenePackageDto {
  readonly schemaVersion: 1;
  readonly stateVersion: number;
  readonly genericActions: readonly EncounterGenericAction[];
  readonly environment: { readonly zoneModel: 'abstract_bands'; readonly notes: readonly string[] };
  readonly participants: readonly {
    readonly actorRef: string;
    readonly role: string | null;
    readonly zone: string;
    readonly equippedEntryRefs: readonly string[];
    readonly knownContentRefs: readonly { readonly contentType: string; readonly code: string }[];
    readonly activeEffectRefs: readonly string[];
    readonly preparedActionRefs: readonly string[];
    readonly tacticalProfile: {
      readonly strategy: string | null;
      readonly objective: string | null;
      readonly faction: string | null;
      readonly traits: readonly string[];
    };
  }[];
}

export interface EncounterBeatSummaryDto {
  readonly externalTransitions: 1;
  readonly resolutionPolicy: 'atomic' | 'allow_partial';
  readonly partialResolutionApplied: boolean;
  readonly actorsActed: readonly string[];
  readonly componentResults: readonly {
    readonly index: number;
    readonly type: EncounterGenericAction;
    readonly status: 'accepted' | 'modified' | 'rejected' | 'conditional';
    readonly code?: string;
    readonly reason?: string;
    readonly field?: string;
    readonly alternative?: string;
    readonly requested?: string;
    readonly applied?: string;
  }[];
  readonly npcActions: readonly {
    readonly actorRef: string;
    readonly strategy: string;
    readonly actionType: EncounterGenericAction;
    readonly targetRef?: string;
  }[];
  readonly npcResults: readonly {
    readonly actorRef: string;
    readonly status: 'acted' | 'rejected';
    readonly reason?: string;
  }[];
  readonly requiresPlayerDecision: boolean;
}

export type EncounterNextRequiredActionDto =
  | { readonly type: 'submit_intent'; readonly actors: readonly { readonly actorRef: string; readonly readySlotRefs: readonly string[] }[] }
  | { readonly type: 'resolve_reaction'; readonly reactorRef: string; readonly reactionKind: 'block' | 'active_dodge' | 'interrupt' | 'counter_attack' }
  | { readonly type: 'continue' }
  | { readonly type: 'confirm_completion'; readonly completionCandidate: 'party_victory_candidate' | 'hostile_victory_candidate' | 'stalemate_candidate' | 'cancelled' }
  | { readonly type: 'none' };

export type EncounterTransitionCategory =
  | 'action_started' | 'action_resolved' | 'damage_applied' | 'resource_changed'
  | 'effect_applied' | 'effect_removed' | 'movement_resolved' | 'reaction_resolved'
  | 'participant_state_changed';

export interface EncounterTransitionSummaryDto {
  readonly processedEventCount: number;
  readonly events: readonly {
    readonly category: EncounterTransitionCategory;
    readonly actorRef?: string;
    readonly targetRef?: string;
  }[];
  readonly changes: readonly {
    readonly actorRef: string;
    readonly categories: readonly EncounterTransitionCategory[];
    readonly resources?: Partial<Readonly<Record<'hp' | 'mana' | 'sp', {
      readonly before: number;
      readonly after: number;
      readonly delta: number;
    }>>>;
    readonly zone?: { readonly before: string; readonly after: string };
    readonly combatState?: { readonly before: string; readonly after: string };
    readonly activeEffects?: { readonly applied: number; readonly removed: number };
  }[];
}

export interface EncounterRecoverySummaryDto {
  readonly reason: 'authority_drift';
  readonly authority: 'mechanics' | 'resources' | 'inventory' | 'effects' | 'campaign_tick';
  readonly actionResolved: false;
  readonly damageApplied: false;
  readonly costApplied: false;
  readonly rewardsGranted: false;
  readonly campaignReleased: true;
}

export interface EncounterDto {
  readonly operation: EncounterOperationName | 'load';
  readonly encounterRef: string;
  readonly lifecycleStatus: string;
  readonly stateVersion: number;
  readonly currentTick: string;
  readonly stopReason: string | null;
  readonly completionCandidate: string | null;
  readonly participants: readonly EncounterParticipantDto[];
  readonly nextRequiredAction: EncounterNextRequiredActionDto;
  readonly transitionSummary?: EncounterTransitionSummaryDto;
  readonly recoverySummary?: EncounterRecoverySummaryDto;
  readonly consequencesSummary?: EncounterPublicConsequencesSummaryV1;
  readonly scene?: EncounterScenePackageDto;
  readonly beatSummary?: EncounterBeatSummaryDto;
}

const stableRefPattern = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const lifecycleStatuses = new Set([
  'awaiting_intent', 'awaiting_reaction', 'processing_paused', 'completion_pending',
  'completed', 'failed', 'cancelled',
]);
const stopReasons = new Set([
  'plan_completed', 'actor_incapacitated', 'hostile_became_ready', 'target_set_changed',
  'resource_below_required', 'zone_changed', 'new_threat_detected', 'state_version_changed',
  'processing_limit', 'no_valid_target', 'reaction_required', 'new_intent_required',
  'encounter_completed', 'encounter_failed',
]);
const completionCandidates = new Set([
  'party_victory_candidate', 'hostile_victory_candidate', 'stalemate_candidate', 'cancelled',
]);
const combatStates = new Set([
  'ready', 'preparing', 'casting', 'moving', 'recovering', 'incapacitated_candidate', 'removed',
]);
const zones = new Set(['engaged', 'near', 'medium', 'far', 'out_of_range']);

function isPublicRef(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 160
    && stableRefPattern.test(value) && !uuidPattern.test(value);
}

function closedRecord(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)
    || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError(`${path} is not a closed encounter DTO`);
  }
  return value as Record<string, unknown>;
}

function closedOptionalRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  path: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)) {
    throw new TypeError(`${path} is not a closed encounter DTO`);
  }
  const keys = Object.keys(value);
  if (requiredKeys.some((key) => !Object.hasOwn(value, key))
    || keys.some((key) => !requiredKeys.includes(key) && !optionalKeys.includes(key))) {
    throw new TypeError(`${path} is not a closed encounter DTO`);
  }
  return value as Record<string, unknown>;
}

function parseNextRequiredAction(value: unknown, participantRefs: ReadonlySet<string>): EncounterNextRequiredActionDto {
  const base = closedOptionalRecord(value, ['type'], ['actors', 'reactorRef', 'reactionKind', 'completionCandidate'], '$.nextRequiredAction');
  if (base.type === 'submit_intent') {
    const action = closedRecord(value, ['type', 'actors'], '$.nextRequiredAction');
    if (!Array.isArray(action.actors) || action.actors.length < 1 || action.actors.length > 64
      || Object.keys(action.actors).length !== action.actors.length) {
      throw new TypeError('Encounter next action is invalid');
    }
    const actorRefs: string[] = [];
    for (const actorValue of action.actors) {
      const actor = closedRecord(actorValue, ['actorRef', 'readySlotRefs'], '$.nextRequiredAction.actors');
      if (!isPublicRef(actor.actorRef) || !participantRefs.has(actor.actorRef)
        || !Array.isArray(actor.readySlotRefs) || actor.readySlotRefs.length < 1 || actor.readySlotRefs.length > 16
        || Object.keys(actor.readySlotRefs).length !== actor.readySlotRefs.length
        || actor.readySlotRefs.some((ref) => !isPublicRef(ref))
        || new Set(actor.readySlotRefs).size !== actor.readySlotRefs.length
        || actor.readySlotRefs.some((ref, index, refs) => index > 0 && (refs[index - 1] as string) >= ref)) {
        throw new TypeError('Encounter next action is invalid');
      }
      actorRefs.push(actor.actorRef);
    }
    if (new Set(actorRefs).size !== actorRefs.length
      || actorRefs.some((ref, index) => index > 0 && (actorRefs[index - 1] as string).localeCompare(ref) >= 0)) {
      throw new TypeError('Encounter next action is invalid');
    }
    return value as EncounterNextRequiredActionDto;
  }
  if (base.type === 'resolve_reaction') {
    const action = closedRecord(value, ['type', 'reactorRef', 'reactionKind'], '$.nextRequiredAction');
    if (!isPublicRef(action.reactorRef) || !participantRefs.has(action.reactorRef)
      || !['block', 'active_dodge', 'interrupt', 'counter_attack'].includes(action.reactionKind as string)) {
      throw new TypeError('Encounter next action is invalid');
    }
    return value as EncounterNextRequiredActionDto;
  }
  if (base.type === 'confirm_completion') {
    const action = closedRecord(value, ['type', 'completionCandidate'], '$.nextRequiredAction');
    if (!completionCandidates.has(action.completionCandidate as string)) throw new TypeError('Encounter next action is invalid');
    return value as EncounterNextRequiredActionDto;
  }
  if (base.type === 'continue' || base.type === 'none') {
    closedRecord(value, ['type'], '$.nextRequiredAction');
    return value as EncounterNextRequiredActionDto;
  }
  throw new TypeError('Encounter next action is invalid');
}

const transitionCategories = new Set<EncounterTransitionCategory>([
  'action_started', 'action_resolved', 'damage_applied', 'resource_changed',
  'effect_applied', 'effect_removed', 'movement_resolved', 'reaction_resolved',
  'participant_state_changed',
]);
const genericActions = new Set<EncounterGenericAction>([
  'move', 'defend', 'protect', 'prepare', 'intercept', 'assist', 'flee',
  'observe', 'interact', 'improvise', 'use_item', 'attack', 'cast',
]);

function denseArray(value: unknown, maximum: number): value is unknown[] {
  return Array.isArray(value) && value.length <= maximum && Object.keys(value).length === value.length;
}

function parseScenePackage(value: unknown, participantRefs: ReadonlySet<string>, stateVersion: number): void {
  const scene = closedRecord(value, ['schemaVersion', 'stateVersion', 'genericActions', 'environment', 'participants'], '$.scene');
  if (scene.schemaVersion !== 1 || scene.stateVersion !== stateVersion
    || !denseArray(scene.genericActions, genericActions.size)
    || scene.genericActions.length !== genericActions.size
    || new Set(scene.genericActions).size !== scene.genericActions.length
    || scene.genericActions.some((action) => !genericActions.has(action as EncounterGenericAction))
    || !denseArray(scene.participants, 64) || scene.participants.length !== participantRefs.size) {
    throw new TypeError('Encounter scene package is invalid');
  }
  const environment = closedRecord(scene.environment, ['zoneModel', 'notes'], '$.scene.environment');
  if (environment.zoneModel !== 'abstract_bands' || !denseArray(environment.notes, 16)
    || environment.notes.some((note) => typeof note !== 'string' || note.length > 500)) {
    throw new TypeError('Encounter scene environment is invalid');
  }
  const seen = new Set<string>();
  for (const valueParticipant of scene.participants) {
    const participant = closedRecord(valueParticipant, [
      'actorRef', 'role', 'zone', 'equippedEntryRefs', 'knownContentRefs', 'activeEffectRefs',
      'preparedActionRefs', 'tacticalProfile',
    ], '$.scene.participants');
    if (!isPublicRef(participant.actorRef) || !participantRefs.has(participant.actorRef) || seen.has(participant.actorRef)
      || (participant.role !== null && (typeof participant.role !== 'string' || participant.role.length > 160))
      || !zones.has(participant.zone as string)
      || !denseArray(participant.equippedEntryRefs, 64) || participant.equippedEntryRefs.some((ref) => !isPublicRef(ref))
      || !denseArray(participant.activeEffectRefs, 128) || participant.activeEffectRefs.some((ref) => !isPublicRef(ref))
      || !denseArray(participant.preparedActionRefs, 5) || participant.preparedActionRefs.some((ref) => !isPublicRef(ref))
      || !denseArray(participant.knownContentRefs, 128)) {
      throw new TypeError('Encounter scene participant is invalid');
    }
    seen.add(participant.actorRef);
    for (const contentValue of participant.knownContentRefs) {
      const content = closedRecord(contentValue, ['contentType', 'code'], '$.scene.participants.knownContentRefs');
      if (!isPublicRef(content.contentType) || !isPublicRef(content.code)) throw new TypeError('Encounter scene content is invalid');
    }
    const tactical = closedRecord(participant.tacticalProfile, ['strategy', 'objective', 'faction', 'traits'], '$.scene.participants.tacticalProfile');
    for (const field of ['strategy', 'objective', 'faction'] as const) {
      if (tactical[field] !== null && (typeof tactical[field] !== 'string' || tactical[field].length > 200)) {
        throw new TypeError('Encounter tactical profile is invalid');
      }
    }
    if (!denseArray(tactical.traits, 16)
      || tactical.traits.some((trait) => typeof trait !== 'string' || trait.length > 160)) {
      throw new TypeError('Encounter tactical traits are invalid');
    }
  }
}

function parseBeatSummary(value: unknown, participantRefs: ReadonlySet<string>): void {
  const summary = closedRecord(value, [
    'externalTransitions', 'resolutionPolicy', 'partialResolutionApplied', 'actorsActed',
    'componentResults', 'npcActions', 'npcResults', 'requiresPlayerDecision',
  ], '$.beatSummary');
  if (summary.externalTransitions !== 1 || typeof summary.requiresPlayerDecision !== 'boolean'
    || !['atomic', 'allow_partial'].includes(summary.resolutionPolicy as string)
    || typeof summary.partialResolutionApplied !== 'boolean'
    || !denseArray(summary.actorsActed, 64) || new Set(summary.actorsActed).size !== summary.actorsActed.length
    || summary.actorsActed.some((ref) => !isPublicRef(ref) || !participantRefs.has(ref))
    || !denseArray(summary.componentResults, 3) || summary.componentResults.length < 1
    || !denseArray(summary.npcActions, 4)
    || !denseArray(summary.npcResults, 4)) throw new TypeError('Encounter beat summary is invalid');
  for (const resultValue of summary.componentResults) {
    const result = closedOptionalRecord(resultValue, ['index', 'type', 'status'], [
      'code', 'reason', 'field', 'alternative', 'requested', 'applied',
    ], '$.beatSummary.componentResults');
    if (!Number.isSafeInteger(result.index) || (result.index as number) < 0 || (result.index as number) > 2
      || !genericActions.has(result.type as EncounterGenericAction)
      || !['accepted', 'modified', 'rejected', 'conditional'].includes(result.status as string)
      || ['code', 'reason', 'field', 'alternative', 'requested', 'applied'].some((field) => (
        result[field] !== undefined && (typeof result[field] !== 'string' || result[field].length > 500)
      ))) {
      throw new TypeError('Encounter beat component result is invalid');
    }
    if (result.status === 'modified' && ['code', 'reason', 'field', 'requested', 'applied']
      .some((field) => typeof result[field] !== 'string')) throw new TypeError('Modified component result is incomplete');
    if (result.status === 'rejected' && ['code', 'reason', 'field', 'alternative']
      .some((field) => typeof result[field] !== 'string')) throw new TypeError('Rejected component result is incomplete');
  }
  for (const actionValue of summary.npcActions) {
    const action = closedOptionalRecord(actionValue, ['actorRef', 'strategy', 'actionType'], ['targetRef'], '$.beatSummary.npcActions');
    if (!isPublicRef(action.actorRef) || !participantRefs.has(action.actorRef)
      || typeof action.strategy !== 'string' || action.strategy.length < 1 || action.strategy.length > 100
      || !genericActions.has(action.actionType as EncounterGenericAction)
      || (action.targetRef !== undefined && (!isPublicRef(action.targetRef) || !participantRefs.has(action.targetRef)))) {
      throw new TypeError('Encounter NPC action summary is invalid');
    }
  }
  const seenNpcResults = new Set<string>();
  for (const resultValue of summary.npcResults) {
    const result = closedOptionalRecord(resultValue, ['actorRef', 'status'], ['reason'], '$.beatSummary.npcResults');
    if (!isPublicRef(result.actorRef) || !participantRefs.has(result.actorRef) || seenNpcResults.has(result.actorRef)
      || !['acted', 'rejected'].includes(result.status as string)
      || (result.status === 'rejected' && (typeof result.reason !== 'string' || result.reason.length > 300))
      || (result.reason !== undefined && typeof result.reason !== 'string')) {
      throw new TypeError('Encounter NPC result summary is invalid');
    }
    seenNpcResults.add(result.actorRef);
  }
}

function parseTransitionSummary(value: unknown, participantRefs: ReadonlySet<string>): void {
  const summary = closedRecord(value, ['processedEventCount', 'events', 'changes'], '$.transitionSummary');
  if (!Number.isSafeInteger(summary.processedEventCount) || (summary.processedEventCount as number) < 1
    || (summary.processedEventCount as number) > 32 || !Array.isArray(summary.events)
    || summary.events.length !== summary.processedEventCount || summary.events.length > 32
    || Object.keys(summary.events).length !== summary.events.length
    || !Array.isArray(summary.changes) || summary.changes.length > 64
    || Object.keys(summary.changes).length !== summary.changes.length) {
    throw new TypeError('Encounter transition summary is invalid');
  }
  for (const eventValue of summary.events) {
    const event = closedOptionalRecord(eventValue, ['category'], ['actorRef', 'targetRef'], '$.transitionSummary.events');
    if (!transitionCategories.has(event.category as EncounterTransitionCategory)
      || (event.actorRef !== undefined && (!isPublicRef(event.actorRef) || !participantRefs.has(event.actorRef)))
      || (event.targetRef !== undefined && (!isPublicRef(event.targetRef) || !participantRefs.has(event.targetRef)))) {
      throw new TypeError('Encounter transition event is invalid');
    }
  }
  const changedActorRefs = new Set<string>();
  for (const changeValue of summary.changes) {
    const change = closedOptionalRecord(
      changeValue, ['actorRef', 'categories'], ['resources', 'zone', 'combatState', 'activeEffects'], '$.transitionSummary.changes',
    );
    if (!isPublicRef(change.actorRef) || !participantRefs.has(change.actorRef) || changedActorRefs.has(change.actorRef)
      || !Array.isArray(change.categories) || change.categories.length < 1
      || change.categories.length > transitionCategories.size
      || new Set(change.categories).size !== change.categories.length
      || change.categories.some((category) => !transitionCategories.has(category as EncounterTransitionCategory))) {
      throw new TypeError('Encounter transition change is invalid');
    }
    changedActorRefs.add(change.actorRef);
    if (change.resources !== undefined) {
      const resources = closedOptionalRecord(change.resources, [], ['hp', 'mana', 'sp'], '$.transitionSummary.changes.resources');
      if (Object.keys(resources).length === 0) throw new TypeError('Encounter transition resource change is invalid');
      for (const poolValue of Object.values(resources)) {
        const pool = closedRecord(poolValue, ['before', 'after', 'delta'], '$.transitionSummary.changes.resources.pool');
        if (![pool.before, pool.after, pool.delta].every((item) => Number.isSafeInteger(item))
          || (pool.before as number) < 0 || (pool.after as number) < 0
          || (pool.delta as number) !== (pool.after as number) - (pool.before as number)) {
          throw new TypeError('Encounter transition resource change is invalid');
        }
      }
    }
    for (const field of ['zone', 'combatState'] as const) {
      if (change[field] === undefined) continue;
      const transition = closedRecord(change[field], ['before', 'after'], `$.transitionSummary.changes.${field}`);
      const allowed = field === 'zone' ? zones : combatStates;
      if (!allowed.has(transition.before as string) || !allowed.has(transition.after as string)) {
        throw new TypeError(`Encounter transition ${field} change is invalid`);
      }
    }
    if (change.activeEffects !== undefined) {
      const effects = closedRecord(change.activeEffects, ['applied', 'removed'], '$.transitionSummary.changes.activeEffects');
      if (![effects.applied, effects.removed].every((item) => Number.isSafeInteger(item) && (item as number) >= 0)) {
        throw new TypeError('Encounter transition active effects change is invalid');
      }
    }
  }
}

export function parseEncounterDto(value: unknown): EncounterDto {
  const root = closedOptionalRecord(value, [
    'operation', 'encounterRef', 'lifecycleStatus', 'stateVersion', 'currentTick',
    'stopReason', 'completionCandidate', 'participants', 'nextRequiredAction',
  ], ['transitionSummary', 'recoverySummary', 'consequencesSummary', 'scene', 'beatSummary'], '$');
  if (!['create', 'submit_intent', 'resolve_reaction', 'continue', 'confirm_completion', 'cancel', 'abandon', 'resolve_beat', 'load']
    .includes(root.operation as string)
    || !isPublicRef(root.encounterRef) || !lifecycleStatuses.has(root.lifecycleStatus as string)
    || !Number.isSafeInteger(root.stateVersion) || (root.stateVersion as number) < 1
    || typeof root.currentTick !== 'string' || !/^(0|[1-9][0-9]*)$/.test(root.currentTick)
    || (root.stopReason !== null && !stopReasons.has(root.stopReason as string))
    || (root.completionCandidate !== null && !completionCandidates.has(root.completionCandidate as string))
    || !Array.isArray(root.participants) || root.participants.length < 1 || root.participants.length > 64
    || Object.keys(root.participants).length !== root.participants.length) {
    throw new TypeError('Encounter DTO is invalid');
  }
  const participantRefs = new Set<string>();
  for (const [index, valueParticipant] of root.participants.entries()) {
    const participant = closedRecord(valueParticipant, [
      'actorRef', 'bindingKind', 'sideRef', 'combatState', 'zone', 'resources',
    ], `$.participants.${index}`);
    if (!isPublicRef(participant.actorRef) || participantRefs.has(participant.actorRef)
      || !['persisted_actor', 'ephemeral'].includes(participant.bindingKind as string)
      || !isPublicRef(participant.sideRef) || !combatStates.has(participant.combatState as string)
      || !zones.has(participant.zone as string)) throw new TypeError('Encounter participant DTO is invalid');
    const resources = closedRecord(participant.resources, ['hp', 'mana', 'sp'], `$.participants.${index}.resources`);
    for (const resource of ['hp', 'mana', 'sp']) {
      const pool = closedRecord(resources[resource], ['current', 'maximum'], `$.participants.${index}.resources.${resource}`);
      if (!Number.isSafeInteger(pool.current) || !Number.isSafeInteger(pool.maximum)
        || (pool.current as number) < 0 || (pool.maximum as number) < 0
        || (pool.current as number) > (pool.maximum as number)) {
        throw new TypeError('Encounter resource DTO is invalid');
      }
    }
    participantRefs.add(participant.actorRef);
  }
  const nextRequiredAction = parseNextRequiredAction(root.nextRequiredAction, participantRefs);
  const nextActionByLifecycle: Readonly<Record<string, EncounterNextRequiredActionDto['type']>> = {
    awaiting_intent: 'submit_intent', awaiting_reaction: 'resolve_reaction', processing_paused: 'continue',
    completion_pending: 'confirm_completion', completed: 'none', failed: 'none', cancelled: 'none',
  };
  const expectedNextAction = nextActionByLifecycle[root.lifecycleStatus as string];
  if (nextRequiredAction.type !== expectedNextAction
    || (nextRequiredAction.type === 'confirm_completion'
      && nextRequiredAction.completionCandidate !== root.completionCandidate)) {
    throw new TypeError('Encounter next action does not match lifecycle');
  }
  if (root.transitionSummary !== undefined) {
    if (!['submit_intent', 'resolve_reaction', 'continue', 'resolve_beat'].includes(root.operation as string)) {
      throw new TypeError('Encounter transition summary does not match operation');
    }
    parseTransitionSummary(root.transitionSummary, participantRefs);
  }
  if (root.recoverySummary !== undefined) {
    const recovery = closedRecord(root.recoverySummary, [
      'reason', 'authority', 'actionResolved', 'damageApplied', 'costApplied', 'rewardsGranted', 'campaignReleased',
    ], '$.recoverySummary');
    if (root.operation !== 'abandon' || root.lifecycleStatus !== 'failed' || root.stopReason !== 'encounter_failed'
      || recovery.reason !== 'authority_drift'
      || !['mechanics', 'resources', 'inventory', 'effects', 'campaign_tick'].includes(recovery.authority as string)
      || recovery.actionResolved !== false || recovery.damageApplied !== false || recovery.costApplied !== false
      || recovery.rewardsGranted !== false || recovery.campaignReleased !== true) {
      throw new TypeError('Encounter recovery summary does not match operation');
    }
  }
  if (root.operation === 'abandon' && root.recoverySummary === undefined) {
    throw new TypeError('Encounter abandon requires a recovery summary');
  }
  if (root.scene !== undefined) parseScenePackage(root.scene, participantRefs, root.stateVersion as number);
  if (root.beatSummary !== undefined) {
    if (root.operation !== 'resolve_beat') throw new TypeError('Encounter beat summary does not match operation');
    parseBeatSummary(root.beatSummary, participantRefs);
  }
  if (root.consequencesSummary !== undefined) {
    if (!['completed', 'cancelled'].includes(root.lifecycleStatus as string)) {
      throw new TypeError('Encounter consequences require a terminal lifecycle');
    }
    const consequences = parseEncounterPublicConsequencesSummary(root.consequencesSummary, participantRefs);
    const expectedOutcome = root.lifecycleStatus === 'cancelled' ? 'cancelled' : {
      party_victory_candidate: 'party_victory',
      hostile_victory_candidate: 'party_defeat',
      stalemate_candidate: 'stalemate',
    }[root.completionCandidate as string];
    if (consequences.outcome !== expectedOutcome) {
      throw new TypeError('Encounter consequences do not match completion state');
    }
  }
  return structuredClone(value) as EncounterDto;
}

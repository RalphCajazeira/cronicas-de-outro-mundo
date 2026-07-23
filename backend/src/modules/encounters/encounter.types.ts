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
  readonly setupMode?: 'explicit' | 'assisted';
  readonly partySideRef?: string;
  readonly participants: readonly (EncounterPersistedParticipantInput | EncounterEphemeralParticipantInput)[];
  readonly relations: readonly CoreV1EncounterParticipantRelation[];
  readonly context?: EncounterContextV1;
  readonly setupSummary?: EncounterSetupSummaryDto;
}

export interface EncounterContextV1 {
  readonly schemaVersion: 1;
  readonly setupMode: 'explicit' | 'assisted';
  readonly encounterKind: 'combat';
  readonly objective: string | null;
  readonly engagementPreference: 'explicit' | 'immediate' | 'close' | 'ranged' | 'ambush' | 'safe_distance';
  readonly protectedActorRefs: readonly string[];
  readonly environment: {
    readonly summary: string | null;
    readonly tags: readonly string[];
  };
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
) & {
  readonly essential?: boolean;
  readonly when?: {
    readonly actorRef?: string;
    readonly resource: 'hp' | 'mana' | 'sp';
    readonly operator: 'at_or_below_percent' | 'at_or_above_percent';
    readonly percent: number;
  };
  readonly fallback?: 'skip' | 'defend';
};

export interface EncounterNpcDirective {
  readonly actorRef: string;
  readonly strategy: 'aggressive' | 'defensive' | 'protect_ally' | 'attack_vulnerable' | 'flee_if_hurt' | 'prioritize_caster';
  readonly targetRef?: string;
}

export interface ResolveEncounterBeatInput extends EncounterMutationReference {
  readonly intent?: {
    readonly actorRef: string;
    readonly objective: string;
    readonly narrative: string;
    readonly resolutionPolicy: 'atomic' | 'allow_partial';
    readonly components: readonly EncounterBeatComponent[];
  };
  readonly npcDirectives?: readonly EncounterNpcDirective[];
  readonly policy?: EncounterAutomaticPolicy;
}

export interface EncounterAutomaticResourcePolicy {
  readonly allowCommonConsumables: boolean;
  readonly allowRareConsumables: boolean;
  readonly allowLimitedAbilities: boolean;
  readonly preserveManaPercent: number;
  readonly preserveSpPercent: number;
  readonly stopBelowHpPercent: number;
  readonly stopIfProtectedActorBelowHpPercent: number;
  readonly allowFlee: boolean;
  readonly allowTargetSwitch: boolean;
  readonly allowEnvironmentalInteraction: boolean;
}

export interface EncounterAutomaticPolicy {
  readonly actorRef: string;
  readonly mode: 'until_decision' | 'until_terminal' | 'bounded';
  readonly strategy: 'aggressive' | 'balanced' | 'defensive' | 'support' | 'protect_target' | 'escape';
  readonly objective: string;
  readonly targetPriority: 'nearest_hostile' | 'lowest_hp_hostile' | 'explicit';
  readonly targetRefs?: readonly string[];
  readonly protectedActorRefs: readonly string[];
  readonly maximumBeats: number;
  readonly resourcePolicy: EncounterAutomaticResourcePolicy;
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
  readonly schemaVersion: 2;
  readonly encounterRef: string;
  readonly stateVersion: number;
  readonly lifecycleStatus: string;
  readonly objective: string | null;
  readonly genericActions: readonly EncounterGenericAction[];
  readonly processingLimits: {
    readonly maximumBeatsPerCall: number;
    readonly maximumComponentsPerBeat: number;
    readonly maximumNpcActionsPerBeat: number;
    readonly maximumEventsPerCheckpoint: number;
    readonly maximumProjectedActions: number;
    readonly maximumSceneBytes: number;
    readonly maximumTransactionDurationMs: number;
  };
  readonly mandatoryStopConditions: readonly string[];
  readonly catalogProjection: {
    readonly status: 'complete' | 'partial';
    readonly sourceActionCount: number;
    readonly detailedActionCount: number;
    readonly omittedBlockedActionCount: number;
    readonly summarizedActorRefs: readonly string[];
    readonly summarizedCategories: readonly ('attacks' | 'abilities' | 'items')[];
  };
  readonly environment: {
    readonly zoneModel: 'abstract_bands';
    readonly summary: string | null;
    readonly tags: readonly string[];
    readonly notes: readonly string[];
  };
  readonly participants: readonly {
    readonly actorRef: string;
    readonly role: string | null;
    readonly sideRef: string;
    readonly relations: {
      readonly allies: readonly string[];
      readonly hostiles: readonly string[];
      readonly neutrals: readonly string[];
    };
    readonly zone: string;
    readonly combatState: string;
    readonly resources: {
      readonly hp: { readonly current: number; readonly maximum: number };
      readonly mana: { readonly current: number; readonly maximum: number };
      readonly sp: { readonly current: number; readonly maximum: number };
    };
    readonly equippedEntryRefs?: readonly string[];
    readonly knownContentRefs?: readonly { readonly contentType: string; readonly code: string }[];
    readonly activeEffects?: readonly {
      readonly effectRef: string;
      readonly kind: string;
      readonly stacks: number;
      readonly durationType: string;
    }[];
    readonly preparedActionRefs?: readonly string[];
    readonly validThreatRefs: readonly string[];
    readonly usableActions: {
      readonly catalogMode: 'full' | 'summary';
      readonly attacks: readonly EncounterProjectedActionDto[];
      readonly abilities: readonly EncounterProjectedActionDto[];
      readonly items: readonly EncounterProjectedActionDto[];
      readonly summary?: {
        readonly attacks: { readonly total: number; readonly usable: number };
        readonly abilities: { readonly total: number; readonly usable: number };
        readonly items: { readonly total: number; readonly usable: number };
      };
      readonly movements: readonly {
        readonly destination: string;
        readonly movementKind: 'approach' | 'retreat' | 'run' | 'disengage';
        readonly canUse: boolean;
        readonly blockers?: readonly string[];
      }[];
      readonly reactions: readonly {
        readonly kind: string;
        readonly cost: EncounterProjectedCostDto;
        readonly canUse: boolean;
        readonly blockers?: readonly string[];
      }[];
    };
    readonly tacticalProfile?: {
      readonly strategy?: string;
      readonly objective?: string;
      readonly faction?: string;
      readonly traits?: readonly string[];
    };
  }[];
}

export type EncounterProjectedCostDto =
  | { readonly type: 'none' }
  | { readonly type: 'mana' | 'sp'; readonly amount: number }
  | { readonly type: 'hybrid'; readonly mana: number; readonly sp: number }
  | { readonly type: 'hp'; readonly percent: number }
  | { readonly type: 'unsupported' };

export interface EncounterProjectedActionDto {
  readonly source: 'inventory' | 'content';
  readonly inventoryEntryRef?: string;
  readonly contentRef?: {
    readonly scope: 'world' | 'campaign';
    readonly contentType: string;
    readonly code: string;
    readonly versionNumber: number;
  };
  readonly code: string;
  readonly name: string;
  readonly actionType: 'attack' | 'cast' | 'use_item';
  readonly rarity?: string;
  readonly range: string;
  readonly cost: EncounterProjectedCostDto;
  readonly quantity?: number;
  readonly consumable?: boolean;
  readonly compatibleModes?: readonly ('one_handed' | 'two_handed')[];
  readonly validTargetRefs: readonly string[];
  readonly canUse: boolean;
  readonly blockers?: readonly string[];
}

export interface EncounterSetupSummaryDto {
  readonly setupMode: 'assisted';
  readonly sides: readonly {
    readonly sideRef: string;
    readonly actorRefs: readonly string[];
  }[];
  readonly relations: readonly {
    readonly leftActorRef: string;
    readonly rightActorRef: string;
    readonly relation: 'self' | 'ally' | 'hostile' | 'neutral';
  }[];
  readonly zones: readonly { readonly actorRef: string; readonly zone: string }[];
  readonly objective: string;
  readonly normalizations: readonly string[];
  readonly warnings: readonly string[];
  readonly firstAvailableActions: readonly {
    readonly actorRef: string;
    readonly actionType: EncounterGenericAction;
    readonly targetRefs: readonly string[];
  }[];
  readonly blockers: readonly string[];
}

export type EncounterStopCategory = 'technical' | 'decision' | 'terminal' | 'error';

export interface EncounterBatchSummaryDto {
  readonly mode: 'plan' | 'automatic';
  readonly startingStateVersion: number;
  readonly endingStateVersion: number;
  readonly beatsProcessed: number;
  readonly actionsResolved: number;
  readonly actorsActed: readonly string[];
  readonly stopReason: string;
  readonly stopCategory: EncounterStopCategory;
  readonly requiresPlayerDecision: boolean;
  readonly decisionReason: string | null;
  readonly availableAlternatives: readonly string[];
  readonly terminalCandidate: string | null;
  readonly narrativeFacts: readonly string[];
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
  readonly deferredNpcActorRefs?: readonly string[];
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
  readonly visibleEventCount: number;
  readonly eventsTruncated: boolean;
  readonly actorsActed: readonly string[];
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
  readonly setupSummary?: EncounterSetupSummaryDto;
  readonly batchSummary?: EncounterBatchSummaryDto;
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
  const scene = closedRecord(value, [
    'schemaVersion', 'encounterRef', 'stateVersion', 'lifecycleStatus', 'objective', 'genericActions',
    'processingLimits', 'mandatoryStopConditions', 'catalogProjection', 'environment', 'participants',
  ], '$.scene');
  if (scene.schemaVersion !== 2 || !isPublicRef(scene.encounterRef) || scene.stateVersion !== stateVersion
    || typeof scene.lifecycleStatus !== 'string' || !lifecycleStatuses.has(scene.lifecycleStatus)
    || (scene.objective !== null && (typeof scene.objective !== 'string' || scene.objective.length > 240))
    || !denseArray(scene.genericActions, genericActions.size)
    || scene.genericActions.length !== genericActions.size
    || new Set(scene.genericActions).size !== scene.genericActions.length
    || scene.genericActions.some((action) => !genericActions.has(action as EncounterGenericAction))
    || !denseArray(scene.participants, 64) || scene.participants.length !== participantRefs.size) {
    throw new TypeError('Encounter scene package is invalid');
  }
  const limits = closedRecord(
    scene.processingLimits,
    [
      'maximumBeatsPerCall', 'maximumComponentsPerBeat', 'maximumNpcActionsPerBeat',
      'maximumEventsPerCheckpoint', 'maximumProjectedActions', 'maximumSceneBytes',
      'maximumTransactionDurationMs',
    ],
    '$.scene.processingLimits',
  );
  if (limits.maximumBeatsPerCall !== 12 || limits.maximumComponentsPerBeat !== 3
    || limits.maximumNpcActionsPerBeat !== 4 || limits.maximumEventsPerCheckpoint !== 32
    || limits.maximumProjectedActions !== 256 || limits.maximumSceneBytes !== 262_144
    || limits.maximumTransactionDurationMs !== 30_000
    || !denseArray(scene.mandatoryStopConditions, 32)
    || scene.mandatoryStopConditions.length < 1
    || scene.mandatoryStopConditions.some((condition) => typeof condition !== 'string' || condition.length > 100)) {
    throw new TypeError('Encounter scene processing limits are invalid');
  }
  const catalogProjection = closedRecord(scene.catalogProjection, [
    'status', 'sourceActionCount', 'detailedActionCount', 'omittedBlockedActionCount',
    'summarizedActorRefs', 'summarizedCategories',
  ], '$.scene.catalogProjection');
  if (!['complete', 'partial'].includes(catalogProjection.status as string)
    || !Number.isSafeInteger(catalogProjection.sourceActionCount) || (catalogProjection.sourceActionCount as number) < 0
    || !Number.isSafeInteger(catalogProjection.detailedActionCount) || (catalogProjection.detailedActionCount as number) < 0
    || !Number.isSafeInteger(catalogProjection.omittedBlockedActionCount)
    || (catalogProjection.omittedBlockedActionCount as number) < 0
    || !denseArray(catalogProjection.summarizedActorRefs, 64)
    || catalogProjection.summarizedActorRefs.some((ref) => !isPublicRef(ref) || !participantRefs.has(ref))
    || !denseArray(catalogProjection.summarizedCategories, 3)
    || new Set(catalogProjection.summarizedCategories).size !== catalogProjection.summarizedCategories.length
    || catalogProjection.summarizedCategories.some((category) => !['attacks', 'abilities', 'items'].includes(category as string))
    || (catalogProjection.status === 'complete'
      && ((catalogProjection.omittedBlockedActionCount as number) > 0
        || catalogProjection.summarizedActorRefs.length > 0))) {
    throw new TypeError('Encounter scene catalog projection is invalid');
  }
  const environment = closedRecord(scene.environment, ['zoneModel', 'summary', 'tags', 'notes'], '$.scene.environment');
  if (environment.zoneModel !== 'abstract_bands' || !denseArray(environment.notes, 16)
    || environment.notes.some((note) => typeof note !== 'string' || note.length > 500)
    || (environment.summary !== null && (typeof environment.summary !== 'string' || environment.summary.length > 500))
    || !denseArray(environment.tags, 12)
    || environment.tags.some((tag) => !isPublicRef(tag))) {
    throw new TypeError('Encounter scene environment is invalid');
  }
  const seen = new Set<string>();
  for (const valueParticipant of scene.participants) {
    const participant = closedOptionalRecord(valueParticipant, [
      'actorRef', 'role', 'sideRef', 'relations', 'zone', 'combatState', 'resources',
      'validThreatRefs', 'usableActions',
    ], [
      'equippedEntryRefs', 'knownContentRefs', 'activeEffects', 'preparedActionRefs', 'tacticalProfile',
    ], '$.scene.participants');
    if (!isPublicRef(participant.actorRef) || !participantRefs.has(participant.actorRef) || seen.has(participant.actorRef)
      || (participant.role !== null && (typeof participant.role !== 'string' || participant.role.length > 160))
      || !isPublicRef(participant.sideRef) || !zones.has(participant.zone as string)
      || !combatStates.has(participant.combatState as string)
      || (participant.equippedEntryRefs !== undefined
        && (!denseArray(participant.equippedEntryRefs, 64) || participant.equippedEntryRefs.some((ref) => !isPublicRef(ref))))
      || (participant.preparedActionRefs !== undefined
        && (!denseArray(participant.preparedActionRefs, 5) || participant.preparedActionRefs.some((ref) => !isPublicRef(ref))))
      || !denseArray(participant.validThreatRefs, 64)
      || participant.validThreatRefs.some((ref) => !isPublicRef(ref) || !participantRefs.has(ref))
      || (participant.knownContentRefs !== undefined && !denseArray(participant.knownContentRefs, 128))
      || (participant.activeEffects !== undefined && !denseArray(participant.activeEffects, 128))) {
      const reasons = [
        (!isPublicRef(participant.actorRef) || !participantRefs.has(participant.actorRef) || seen.has(participant.actorRef)) && 'actorRef',
        (participant.role !== null && (typeof participant.role !== 'string' || participant.role.length > 160)) && 'role',
        !isPublicRef(participant.sideRef) && 'sideRef',
        !zones.has(participant.zone as string) && 'zone',
        !combatStates.has(participant.combatState as string) && 'combatState',
        (participant.equippedEntryRefs !== undefined
          && (!denseArray(participant.equippedEntryRefs, 64) || participant.equippedEntryRefs.some((ref) => !isPublicRef(ref)))) && 'equipment',
        (participant.preparedActionRefs !== undefined
          && (!denseArray(participant.preparedActionRefs, 5) || participant.preparedActionRefs.some((ref) => !isPublicRef(ref)))) && 'preparedActions',
        (!denseArray(participant.validThreatRefs, 64)
          || participant.validThreatRefs.some((ref) => !isPublicRef(ref) || !participantRefs.has(ref))) && 'threats',
        (participant.knownContentRefs !== undefined && !denseArray(participant.knownContentRefs, 128)) && 'content',
        (participant.activeEffects !== undefined && !denseArray(participant.activeEffects, 128)) && 'effects',
      ].filter((reason): reason is string => typeof reason === 'string');
      throw new TypeError(`Encounter scene participant is invalid (${reasons.join(',')})`);
    }
    seen.add(participant.actorRef);
    const resources = closedRecord(participant.resources, ['hp', 'mana', 'sp'], '$.scene.participants.resources');
    for (const resource of ['hp', 'mana', 'sp']) {
      const pool = closedRecord(resources[resource], ['current', 'maximum'], '$.scene.participants.resources.pool');
      if (!Number.isSafeInteger(pool.current) || !Number.isSafeInteger(pool.maximum)
        || (pool.current as number) < 0 || (pool.current as number) > (pool.maximum as number)) {
        throw new TypeError('Encounter scene participant resources are invalid');
      }
    }
    const relations = closedRecord(
      participant.relations, ['allies', 'hostiles', 'neutrals'], '$.scene.participants.relations',
    );
    const relatedRefs = (['allies', 'hostiles', 'neutrals'] as const).flatMap((field) => {
      if (!denseArray(relations[field], 64)
        || relations[field].some((ref) => !isPublicRef(ref) || !participantRefs.has(ref)
          || ref === participant.actorRef)) {
        throw new TypeError('Encounter scene relations are invalid');
      }
      return relations[field] as string[];
    });
    if (relatedRefs.length !== participantRefs.size - 1 || new Set(relatedRefs).size !== relatedRefs.length) {
      throw new TypeError('Encounter scene relation groups are incomplete');
    }
    for (const effectValue of participant.activeEffects ?? []) {
      const effect = closedRecord(effectValue, ['effectRef', 'kind', 'stacks', 'durationType'], '$.scene.participants.activeEffects');
      if (!isPublicRef(effect.effectRef) || !isPublicRef(effect.kind)
        || !Number.isSafeInteger(effect.stacks) || (effect.stacks as number) < 1
        || !isPublicRef(effect.durationType)) throw new TypeError('Encounter scene effects are invalid');
    }
    for (const contentValue of participant.knownContentRefs ?? []) {
      const content = closedRecord(contentValue, ['contentType', 'code'], '$.scene.participants.knownContentRefs');
      if (!isPublicRef(content.contentType) || !isPublicRef(content.code)) throw new TypeError('Encounter scene content is invalid');
    }
    if (participant.tacticalProfile !== undefined) {
      const tactical = closedOptionalRecord(
        participant.tacticalProfile, [], ['strategy', 'objective', 'faction', 'traits'], '$.scene.participants.tacticalProfile',
      );
      for (const field of ['strategy', 'objective', 'faction'] as const) {
        if (tactical[field] !== undefined && (typeof tactical[field] !== 'string' || tactical[field].length > 200)) {
        throw new TypeError('Encounter tactical profile is invalid');
        }
      }
      if (tactical.traits !== undefined && (!denseArray(tactical.traits, 16)
        || tactical.traits.some((trait) => typeof trait !== 'string' || trait.length > 160))) {
        throw new TypeError('Encounter tactical traits are invalid');
      }
    }
    parseUsableActions(participant.usableActions, participantRefs);
  }
}

function parseProjectedCost(value: unknown): void {
  const base = closedOptionalRecord(value, ['type'], ['amount', 'mana', 'sp', 'percent'], '$.scene.action.cost');
  if (base.type === 'none' || base.type === 'unsupported') {
    closedRecord(value, ['type'], '$.scene.action.cost');
    return;
  }
  if (base.type === 'mana' || base.type === 'sp') {
    const cost = closedRecord(value, ['type', 'amount'], '$.scene.action.cost');
    if (!Number.isSafeInteger(cost.amount) || (cost.amount as number) < 0) throw new TypeError('Encounter action cost is invalid');
    return;
  }
  if (base.type === 'hybrid') {
    const cost = closedRecord(value, ['type', 'mana', 'sp'], '$.scene.action.cost');
    if (![cost.mana, cost.sp].every((amount) => Number.isSafeInteger(amount) && (amount as number) >= 0)) {
      throw new TypeError('Encounter action cost is invalid');
    }
    return;
  }
  if (base.type === 'hp') {
    const cost = closedRecord(value, ['type', 'percent'], '$.scene.action.cost');
    if (!Number.isSafeInteger(cost.percent) || (cost.percent as number) < 1 || (cost.percent as number) > 100) {
      throw new TypeError('Encounter action cost is invalid');
    }
    return;
  }
  throw new TypeError('Encounter action cost is invalid');
}

function parseProjectedAction(value: unknown, participantRefs: ReadonlySet<string>): void {
  const action = closedOptionalRecord(value, [
    'source', 'code', 'name', 'actionType', 'range', 'cost', 'validTargetRefs', 'canUse',
  ], [
    'rarity', 'consumable', 'compatibleModes', 'blockers', 'inventoryEntryRef', 'contentRef', 'quantity',
  ], '$.scene.action');
  if (!['inventory', 'content'].includes(action.source as string)
    || !isPublicRef(action.code) || typeof action.name !== 'string' || action.name.length < 1 || action.name.length > 200
    || !['attack', 'cast', 'use_item'].includes(action.actionType as string)
    || (action.rarity !== undefined && !isPublicRef(action.rarity))
    || !isPublicRef(action.range)
    || (action.consumable !== undefined && action.consumable !== true)
    || typeof action.canUse !== 'boolean'
    || (action.compatibleModes !== undefined && (!denseArray(action.compatibleModes, 2)
      || action.compatibleModes.some((mode) => !['one_handed', 'two_handed'].includes(mode as string))))
    || !denseArray(action.validTargetRefs, 16)
    || action.validTargetRefs.some((ref) => !isPublicRef(ref) || !participantRefs.has(ref))
    || (action.blockers !== undefined && (!denseArray(action.blockers, 16)
      || action.blockers.some((blocker) => !isPublicRef(blocker)))
    )) throw new TypeError('Encounter projected action is invalid');
  if (action.source === 'inventory') {
    if (!isPublicRef(action.inventoryEntryRef) || action.contentRef !== undefined) throw new TypeError('Encounter inventory action is invalid');
  } else {
    const content = closedRecord(action.contentRef, ['scope', 'contentType', 'code', 'versionNumber'], '$.scene.action.contentRef');
    if (!['world', 'campaign'].includes(content.scope as string) || !isPublicRef(content.contentType)
      || !isPublicRef(content.code) || !Number.isSafeInteger(content.versionNumber)
      || (content.versionNumber as number) < 1 || action.inventoryEntryRef !== undefined) {
      throw new TypeError('Encounter content action is invalid');
    }
  }
  if (action.quantity !== undefined && (!Number.isSafeInteger(action.quantity) || (action.quantity as number) < 0)) {
    throw new TypeError('Encounter projected action quantity is invalid');
  }
  parseProjectedCost(action.cost);
}

function parseUsableActions(value: unknown, participantRefs: ReadonlySet<string>): void {
  const actions = closedOptionalRecord(
    value, ['catalogMode', 'attacks', 'abilities', 'items', 'movements', 'reactions'], ['summary'], '$.scene.usableActions',
  );
  if (!['full', 'summary'].includes(actions.catalogMode as string)) throw new TypeError('Encounter catalog mode is invalid');
  for (const field of ['attacks', 'abilities', 'items'] as const) {
    if (!denseArray(actions[field], 512)) throw new TypeError('Encounter action list is invalid');
    actions[field].forEach((action) => parseProjectedAction(action, participantRefs));
  }
  if (actions.catalogMode === 'summary') {
    if ((actions.attacks as unknown[]).length !== 0 || (actions.abilities as unknown[]).length !== 0
      || (actions.items as unknown[]).length !== 0) {
      throw new TypeError('Encounter summarized catalog must not expose detailed actions');
    }
    const summary = closedRecord(actions.summary, ['attacks', 'abilities', 'items'], '$.scene.usableActions.summary');
    for (const field of ['attacks', 'abilities', 'items'] as const) {
      const counts = closedRecord(summary[field], ['total', 'usable'], '$.scene.usableActions.summary.counts');
      if (!Number.isSafeInteger(counts.total) || (counts.total as number) < 0
        || !Number.isSafeInteger(counts.usable) || (counts.usable as number) < 0
        || (counts.usable as number) > (counts.total as number)) {
        throw new TypeError('Encounter summarized catalog counts are invalid');
      }
    }
  } else if (actions.summary !== undefined) {
    throw new TypeError('Encounter full catalog must not include a summary');
  }
  if (!denseArray(actions.movements, 5) || !denseArray(actions.reactions, 16)) {
    throw new TypeError('Encounter movement or reaction list is invalid');
  }
  for (const valueMovement of actions.movements) {
    const movement = closedOptionalRecord(
      valueMovement, ['destination', 'movementKind', 'canUse'], ['blockers'], '$.scene.movements',
    );
    if (!zones.has(movement.destination as string)
      || !['approach', 'retreat', 'run', 'disengage'].includes(movement.movementKind as string)
      || typeof movement.canUse !== 'boolean'
      || (movement.blockers !== undefined && (!denseArray(movement.blockers, 8)
        || movement.blockers.some((blocker) => !isPublicRef(blocker))))) {
      throw new TypeError('Encounter movement is invalid');
    }
  }
  for (const valueReaction of actions.reactions) {
    const reaction = closedOptionalRecord(valueReaction, ['kind', 'cost', 'canUse'], ['blockers'], '$.scene.reactions');
    if (!isPublicRef(reaction.kind) || typeof reaction.canUse !== 'boolean'
      || (reaction.blockers !== undefined && (!denseArray(reaction.blockers, 8)
        || reaction.blockers.some((blocker) => !isPublicRef(blocker))))) {
      throw new TypeError('Encounter reaction is invalid');
    }
    parseProjectedCost(reaction.cost);
  }
}

function parseBeatSummary(value: unknown, participantRefs: ReadonlySet<string>): void {
  const summary = closedOptionalRecord(value, [
    'externalTransitions', 'resolutionPolicy', 'partialResolutionApplied', 'actorsActed',
    'componentResults', 'npcActions', 'npcResults', 'requiresPlayerDecision',
  ], ['deferredNpcActorRefs'], '$.beatSummary');
  if (summary.externalTransitions !== 1 || typeof summary.requiresPlayerDecision !== 'boolean'
    || !['atomic', 'allow_partial'].includes(summary.resolutionPolicy as string)
    || typeof summary.partialResolutionApplied !== 'boolean'
    || !denseArray(summary.actorsActed, 64) || new Set(summary.actorsActed).size !== summary.actorsActed.length
    || summary.actorsActed.some((ref) => !isPublicRef(ref) || !participantRefs.has(ref))
    || !denseArray(summary.componentResults, 3) || summary.componentResults.length < 1
    || !denseArray(summary.npcActions, 4)
    || !denseArray(summary.npcResults, 4)
    || (summary.deferredNpcActorRefs !== undefined
      && (!denseArray(summary.deferredNpcActorRefs, 64)
        || new Set(summary.deferredNpcActorRefs).size !== summary.deferredNpcActorRefs.length
        || summary.deferredNpcActorRefs.some((ref) => !isPublicRef(ref) || !participantRefs.has(ref))))) {
    throw new TypeError('Encounter beat summary is invalid');
  }
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

function parseSetupSummary(value: unknown, participantRefs: ReadonlySet<string>): void {
  const summary = closedRecord(value, [
    'setupMode', 'sides', 'relations', 'zones', 'objective', 'normalizations',
    'warnings', 'firstAvailableActions', 'blockers',
  ], '$.setupSummary');
  if (summary.setupMode !== 'assisted' || typeof summary.objective !== 'string'
    || summary.objective.length < 1 || summary.objective.length > 240
    || !denseArray(summary.sides, 3) || summary.sides.length < 2
    || !denseArray(summary.relations, 2_080)
    || !denseArray(summary.zones, 64) || summary.zones.length !== participantRefs.size
    || !denseArray(summary.normalizations, 16) || !denseArray(summary.warnings, 16)
    || !denseArray(summary.firstAvailableActions, 128) || !denseArray(summary.blockers, 16)) {
    throw new TypeError('Encounter setup summary is invalid');
  }
  for (const sideValue of summary.sides) {
    const side = closedRecord(sideValue, ['sideRef', 'actorRefs'], '$.setupSummary.sides');
    if (!isPublicRef(side.sideRef) || !denseArray(side.actorRefs, 64)
      || side.actorRefs.some((ref) => !isPublicRef(ref) || !participantRefs.has(ref))) {
      throw new TypeError('Encounter setup sides are invalid');
    }
  }
  for (const relationValue of summary.relations) {
    const relation = closedRecord(relationValue, ['leftActorRef', 'rightActorRef', 'relation'], '$.setupSummary.relations');
    if (!isPublicRef(relation.leftActorRef) || !participantRefs.has(relation.leftActorRef)
      || !isPublicRef(relation.rightActorRef) || !participantRefs.has(relation.rightActorRef)
      || !['self', 'ally', 'hostile', 'neutral'].includes(relation.relation as string)) {
      throw new TypeError('Encounter setup relations are invalid');
    }
  }
  for (const zoneValue of summary.zones) {
    const zone = closedRecord(zoneValue, ['actorRef', 'zone'], '$.setupSummary.zones');
    if (!isPublicRef(zone.actorRef) || !participantRefs.has(zone.actorRef) || !zones.has(zone.zone as string)) {
      throw new TypeError('Encounter setup zones are invalid');
    }
  }
  for (const actionValue of summary.firstAvailableActions) {
    const action = closedRecord(actionValue, ['actorRef', 'actionType', 'targetRefs'], '$.setupSummary.firstAvailableActions');
    if (!isPublicRef(action.actorRef) || !participantRefs.has(action.actorRef)
      || !genericActions.has(action.actionType as EncounterGenericAction)
      || !denseArray(action.targetRefs, 16)
      || action.targetRefs.some((ref) => !isPublicRef(ref) || !participantRefs.has(ref))) {
      throw new TypeError('Encounter setup first actions are invalid');
    }
  }
  for (const field of ['normalizations', 'warnings', 'blockers'] as const) {
    if ((summary[field] as unknown[]).some((entry) => typeof entry !== 'string' || entry.length > 300)) {
      throw new TypeError('Encounter setup diagnostics are invalid');
    }
  }
}

function parseBatchSummary(value: unknown, stateVersion: number, participantRefs: ReadonlySet<string>): void {
  const summary = closedRecord(value, [
    'mode', 'startingStateVersion', 'endingStateVersion', 'beatsProcessed', 'actionsResolved',
    'actorsActed',
    'stopReason', 'stopCategory', 'requiresPlayerDecision', 'decisionReason',
    'availableAlternatives', 'terminalCandidate', 'narrativeFacts',
  ], '$.batchSummary');
  if (!['plan', 'automatic'].includes(summary.mode as string)
    || !Number.isSafeInteger(summary.startingStateVersion) || (summary.startingStateVersion as number) < 1
    || summary.endingStateVersion !== stateVersion
    || !Number.isSafeInteger(summary.beatsProcessed) || (summary.beatsProcessed as number) < 0
    || (summary.beatsProcessed as number) > 12
    || !Number.isSafeInteger(summary.actionsResolved) || (summary.actionsResolved as number) < 0
    || !denseArray(summary.actorsActed, 64) || new Set(summary.actorsActed).size !== summary.actorsActed.length
    || summary.actorsActed.some((ref) => !isPublicRef(ref) || !participantRefs.has(ref))
    || typeof summary.stopReason !== 'string' || summary.stopReason.length < 1 || summary.stopReason.length > 100
    || !['technical', 'decision', 'terminal', 'error'].includes(summary.stopCategory as string)
    || typeof summary.requiresPlayerDecision !== 'boolean'
    || (summary.decisionReason !== null
      && (typeof summary.decisionReason !== 'string' || summary.decisionReason.length > 300))
    || (summary.terminalCandidate !== null && !completionCandidates.has(summary.terminalCandidate as string))
    || !denseArray(summary.availableAlternatives, 16)
    || summary.availableAlternatives.some((alternative) => typeof alternative !== 'string' || alternative.length > 300)
    || !denseArray(summary.narrativeFacts, 128)
    || summary.narrativeFacts.some((fact) => typeof fact !== 'string' || fact.length > 300)
    || (summary.stopCategory === 'technical' && summary.requiresPlayerDecision !== false)
    || (summary.stopCategory === 'decision' && summary.requiresPlayerDecision !== true)) {
    throw new TypeError('Encounter batch summary is invalid');
  }
}

function parseTransitionSummary(value: unknown, participantRefs: ReadonlySet<string>): void {
  const summary = closedRecord(value, [
    'processedEventCount', 'visibleEventCount', 'eventsTruncated', 'actorsActed', 'events', 'changes',
  ], '$.transitionSummary');
  if (!Number.isSafeInteger(summary.processedEventCount) || (summary.processedEventCount as number) < 1
    || (summary.processedEventCount as number) > 384
    || !Number.isSafeInteger(summary.visibleEventCount) || (summary.visibleEventCount as number) < 1
    || (summary.visibleEventCount as number) > 32 || !Array.isArray(summary.events)
    || summary.events.length !== summary.visibleEventCount || summary.events.length > 32
    || typeof summary.eventsTruncated !== 'boolean'
    || summary.eventsTruncated !== ((summary.processedEventCount as number) > summary.visibleEventCount)
    || !denseArray(summary.actorsActed, 64) || new Set(summary.actorsActed).size !== summary.actorsActed.length
    || summary.actorsActed.some((ref) => !isPublicRef(ref) || !participantRefs.has(ref))
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
  ], [
    'transitionSummary', 'recoverySummary', 'consequencesSummary', 'scene', 'beatSummary',
    'setupSummary', 'batchSummary',
  ], '$');
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
  if (root.setupSummary !== undefined) {
    if (root.operation !== 'create') throw new TypeError('Encounter setup summary does not match operation');
    parseSetupSummary(root.setupSummary, participantRefs);
  }
  if (root.batchSummary !== undefined) {
    if (root.operation !== 'resolve_beat') throw new TypeError('Encounter batch summary does not match operation');
    parseBatchSummary(root.batchSummary, root.stateVersion as number, participantRefs);
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

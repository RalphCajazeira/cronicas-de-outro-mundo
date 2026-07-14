import type {
  ActionSlot,
  CastingState,
  CombatTick,
  CombatZone,
  MovementKind,
  MultiTargetActionDefinition,
  PhysicalSpeedInput,
  MagicalSpeedInput,
  ReactionKind,
  TerrainType,
  TimelineEvent,
} from './core-v1.action-economy.types.js';
import type {
  CoreV1ContentKind,
  CoreV1MechanicalContentProfile,
  CoreV1Targeting,
} from './core-v1.content-mechanics.types.js';
import type {
  CoreV1ActorEffectContext,
  CoreV1CostModifierSet,
  CoreV1DamageDefenseContext,
  CoreV1EffectSequenceResult,
  CoreV1InjectedRolls,
  CoreV1RuntimeDurationBinding,
  CoreV1StatusDefinitionBinding,
} from './core-v1.effects.types.js';
import type {
  CoreV1EquipmentLoadout,
  CoreV1EquipmentRequirementContext,
  CoreV1InventoryState,
} from './core-v1.inventory.types.js';
import type {
  CoreV1Cost,
  DamageComponentDefinition,
  PrimaryAttributes,
  SecondaryAttributes,
  ValidationIssue,
} from './core-v1.types.js';

export type CoreV1EncounterStatus =
  | 'setup' | 'active' | 'paused' | 'completed' | 'cancelled' | 'failed';

export type CoreV1EncounterCombatState =
  | 'ready' | 'preparing' | 'casting' | 'moving' | 'recovering'
  | 'incapacitated_candidate' | 'removed';

export type CoreV1EncounterRelation = 'ally' | 'hostile' | 'neutral' | 'self';

export type CoreV1EncounterTargetSelector =
  | 'self' | 'explicit' | 'nearest_hostile' | 'lowest_hp_hostile' | 'nearest_ally';

export type CoreV1EncounterActionSource =
  | 'content' | 'consumable' | 'basic_weapon_attack' | 'movement' | 'wait';

export type CoreV1EncounterEventType =
  | 'action_started'
  | 'action_effect'
  | 'action_invalidated'
  | 'action_interrupted'
  | 'reaction_started'
  | 'reaction_resolved'
  | 'counter_attack_started'
  | 'channel_pulse'
  | 'upkeep_due'
  | 'movement_effect'
  | 'actor_ready'
  | 'cooldown_expired'
  | 'participant_incapacitated_candidate';

export type CoreV1EncounterStopReason =
  | 'plan_completed'
  | 'actor_incapacitated'
  | 'hostile_became_ready'
  | 'target_set_changed'
  | 'resource_below_required'
  | 'zone_changed'
  | 'new_threat_detected'
  | 'state_version_changed'
  | 'processing_limit'
  | 'no_valid_target'
  | 'reaction_required'
  | 'new_intent_required'
  | 'encounter_completed'
  | 'encounter_failed';

export type CoreV1EncounterCompletionCandidate =
  | 'party_victory_candidate'
  | 'hostile_victory_candidate'
  | 'stalemate_candidate'
  | 'cancelled';

export type CoreV1EncounterOperationIssueCode =
  | 'STALE_ENCOUNTER_STATE'
  | 'NO_VALID_TARGET'
  | 'ACTION_SLOT_NOT_READY'
  | 'ACTION_ON_COOLDOWN'
  | 'REACTION_WINDOW_CLOSED'
  | 'REACTION_OUTCOME_REQUIRED'
  | 'REQUIRES_SPATIAL_ADAPTER'
  | 'REQUIRES_UPKEEP_POLICY'
  | 'PROCESSING_LIMIT';

export type CoreV1EncounterResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
    readonly ok: false;
    readonly code: 'INVALID_CORE_V1_ENCOUNTER_OPERATION';
    readonly retryable: true;
    readonly issues: readonly ValidationIssue[];
  };

export interface CoreV1EncounterInitiative {
  readonly score: number;
  readonly tieBreak: number;
  readonly firstReadyTick: CombatTick;
  readonly surprised: boolean;
}

export interface CoreV1EncounterReactionCapability {
  readonly capabilityRef: string;
  readonly kind: ReactionKind;
  readonly tier: number;
  readonly cost: CoreV1Cost;
  readonly blockValue?: number;
}

export interface CoreV1EncounterEquipmentContext {
  readonly inventory: CoreV1InventoryState;
  readonly loadout: CoreV1EquipmentLoadout;
  readonly requirements: CoreV1EquipmentRequirementContext;
}

export interface CoreV1EncounterParticipant {
  readonly actorRef: string;
  readonly sideRef: string;
  readonly actorStateVersion: number;
  readonly mechanicsStateVersion: number;
  readonly inventoryStateVersion: number;
  readonly effectsStateVersion: number;
  readonly zone: CombatZone;
  readonly combatState: CoreV1EncounterCombatState;
  readonly primaryAttributes: PrimaryAttributes;
  readonly resources: CoreV1ActorEffectContext['resources'];
  readonly secondaryAttributes: SecondaryAttributes;
  readonly activeEffects: CoreV1ActorEffectContext['activeEffects'];
  readonly actionSlots: readonly ActionSlot[];
  readonly reactionCapabilities: readonly CoreV1EncounterReactionCapability[];
  readonly equipmentContext: CoreV1EncounterEquipmentContext;
  readonly initiative: CoreV1EncounterInitiative;
}

export interface CoreV1EncounterParticipantInput
  extends Omit<CoreV1EncounterParticipant, 'initiative'> {
  readonly initiative: {
    readonly readinessModifier?: number;
    readonly statusModifier?: number;
    readonly tieBreak: number;
    readonly surprised?: boolean;
  };
}

export interface CoreV1EncounterParticipantRelation {
  readonly leftActorRef: string;
  readonly rightActorRef: string;
  readonly relation: CoreV1EncounterRelation;
}

export interface CoreV1EncounterCooldown {
  readonly actorRef: string;
  readonly cooldownRef: string;
  readonly readyAtTick: CombatTick;
  readonly sourceKind: 'reaction' | 'content';
}

export interface CoreV1EncounterContentReference {
  readonly scope: 'world' | 'campaign';
  readonly contentType: CoreV1ContentKind;
  readonly code: string;
  readonly versionNumber: number;
}

export interface CoreV1EncounterTargetCandidate {
  readonly actorRef: string;
  readonly relation: CoreV1EncounterRelation;
  readonly rangeBand: CombatZone;
  readonly targetable: boolean;
  readonly active: boolean;
  readonly hpCurrent: number;
  readonly hpMaximum: number;
  readonly stableOrder: number;
}

export interface CoreV1EncounterCandidateRange {
  readonly fromActorRef: string;
  readonly toActorRef: string;
  readonly rangeBand: CombatZone;
}

export interface CoreV1EncounterTargetingContext {
  readonly candidates: readonly CoreV1EncounterTargetCandidate[];
  readonly spatialCandidateRefs?: readonly string[];
  readonly candidateRanges?: readonly CoreV1EncounterCandidateRange[];
}

export interface CoreV1ResolvedEncounterTarget {
  readonly targetRef: string;
  readonly targetOrdinal: number;
  readonly damageMultiplierBps: number;
  readonly effectTickOffset: CombatTick;
}

export interface CoreV1EncounterTargetRequest {
  readonly encounter: CoreV1EncounterState;
  readonly sourceActorRef: string;
  readonly targeting: CoreV1Targeting;
  readonly selector: CoreV1EncounterTargetSelector;
  readonly requestedTargetRefs: readonly string[];
  readonly allowedRelations: readonly CoreV1EncounterRelation[];
  readonly context: CoreV1EncounterTargetingContext;
}

export interface CoreV1EncounterReactionPolicy {
  readonly mode: 'none' | 'allow' | 'require';
  readonly preferredReaction?: Exclude<ReactionKind, 'counter_attack'>;
  readonly allowCounterAttack: boolean;
}

export interface CoreV1EncounterActionIntent {
  readonly intentRef: string;
  readonly sourceActorRef: string;
  readonly slotRef: string;
  readonly actionSource: CoreV1EncounterActionSource;
  readonly targetSelector: CoreV1EncounterTargetSelector;
  readonly requestedTargetRefs: readonly string[];
  readonly contentRef?: CoreV1EncounterContentReference;
  readonly weaponEntryRef?: string;
  readonly versatileMode?: 'one_handed' | 'two_handed';
  readonly reactionPolicy?: CoreV1EncounterReactionPolicy;
}

export interface CoreV1EncounterMovementDefinition {
  readonly kind: MovementKind | 'move_and_act';
  readonly from: CombatZone;
  readonly to: CombatZone;
  readonly terrain: TerrainType;
  readonly combinedActionAllowed?: boolean;
}

export interface CoreV1EncounterCastingDefinition {
  readonly reservedMana: number;
  readonly canMoveWhileCasting: boolean;
  readonly mobileCastTimeMultiplierBps?: number;
  readonly preparedUntilTick?: CombatTick | null;
  readonly channelInterval?: CombatTick | null;
  readonly channelEndTick?: CombatTick | null;
}

export interface CoreV1EncounterActionDefinition {
  readonly actionSource: CoreV1EncounterActionSource;
  readonly actionKind: 'physical' | 'magic' | 'hybrid' | 'movement' | 'item' | 'wait';
  readonly profile?: CoreV1MechanicalContentProfile;
  readonly contentRef?: CoreV1EncounterContentReference;
  readonly actionTags: readonly string[];
  readonly fullPrimaryAction: boolean;
  readonly allowedRelations: readonly CoreV1EncounterRelation[];
  readonly effectRefs: readonly string[];
  readonly statusDefinitions?: readonly CoreV1StatusDefinitionBinding[];
  readonly runtimeDurations?: readonly CoreV1RuntimeDurationBinding[];
  readonly weaponDamageComponents?: readonly DamageComponentDefinition[];
  readonly costModifiers?: CoreV1CostModifierSet;
  readonly defenses?: Readonly<Record<string, CoreV1DamageDefenseContext>>;
  readonly physicalSpeed?: PhysicalSpeedInput;
  readonly magicalSpeed?: MagicalSpeedInput;
  readonly movement?: CoreV1EncounterMovementDefinition;
  readonly casting?: CoreV1EncounterCastingDefinition;
  readonly combo?: MultiTargetActionDefinition;
  readonly interruptible: boolean;
  readonly blockable: boolean;
  readonly dodgeable: boolean;
  readonly canRetargetBeforeEffect: boolean;
}

export interface CoreV1EncounterResourceReservationPlan {
  readonly cost: CoreV1Cost;
  readonly affordable: boolean;
  readonly reservations: readonly { readonly resource: string; readonly amount: number }[];
}

export interface CoreV1EncounterEvent {
  readonly eventRef: string;
  readonly type: CoreV1EncounterEventType;
  readonly timelineEvent: TimelineEvent;
  readonly actionRef?: string;
  readonly targetRef?: string;
  readonly targetOrdinal?: number;
  readonly comboStepRef?: string;
  readonly reactionKind?: ReactionKind;
}

export interface CoreV1EncounterExecutionPlan {
  readonly profile?: CoreV1MechanicalContentProfile;
  readonly contentRef?: CoreV1EncounterContentReference;
  readonly effectRefs: readonly string[];
  readonly statusDefinitions: readonly CoreV1StatusDefinitionBinding[];
  readonly runtimeDurations: readonly CoreV1RuntimeDurationBinding[];
  readonly weaponDamageComponents: readonly DamageComponentDefinition[];
  readonly costModifiers?: CoreV1CostModifierSet;
  readonly defenses: Readonly<Record<string, CoreV1DamageDefenseContext>>;
  readonly movement?: CoreV1EncounterMovementDefinition;
  readonly castingState?: CastingState;
  readonly reactionPolicy: CoreV1EncounterReactionPolicy;
  readonly comboStopOnMiss: boolean;
  readonly consumedEntryRef?: string;
}

export interface CoreV1CompiledEncounterAction {
  readonly actionRef: string;
  readonly intentRef: string;
  readonly sourceActorRef: string;
  readonly slotRef: string;
  readonly actionKind: CoreV1EncounterActionDefinition['actionKind'];
  readonly contentRef?: CoreV1EncounterContentReference;
  readonly startTick: CombatTick;
  readonly effectTick: CombatTick;
  readonly nextActionAtTick: CombatTick;
  readonly preparationTicks: CombatTick;
  readonly recoveryTicks: CombatTick;
  readonly targets: readonly CoreV1ResolvedEncounterTarget[];
  readonly reactionDepth: 0 | 1 | 2;
  readonly interruptible: boolean;
  readonly blockable: boolean;
  readonly dodgeable: boolean;
  readonly canRetargetBeforeEffect: boolean;
  readonly resourceReservationPlan: CoreV1EncounterResourceReservationPlan;
  readonly cooldownPlan: readonly CoreV1EncounterCooldown[];
  readonly upkeepPlan: readonly { readonly resource: 'mana' | 'sp'; readonly amount: number }[];
  readonly internalEvents: readonly CoreV1EncounterEvent[];
  readonly executionPlan: CoreV1EncounterExecutionPlan;
  readonly state: 'scheduled' | 'active' | 'interrupted' | 'invalidated' | 'resolved';
  readonly costApplied: boolean;
  readonly selfEffectsApplied: boolean;
  readonly dodgedTargetRefs: readonly string[];
}

export interface CoreV1StoredEncounterActionPlan {
  readonly planRef: string;
  readonly actorRef: string;
  readonly expectedStateVersion: number;
  readonly intents: readonly CoreV1EncounterActionIntent[];
  readonly stopConditions: readonly (
    | 'actorIncapacitated' | 'hostileBecomesReady' | 'targetSetChangedMaterially'
    | 'resourceBelowRequired' | 'zoneChanged' | 'newThreatDetected'
    | 'stateVersionChanged' | 'processingLimit' | 'noValidTarget'
    | 'reactionRequired' | 'newPlayerIntentRequired'
  )[];
}

export interface CoreV1EncounterState {
  readonly schemaVersion: 1;
  readonly rulesetCode: 'core-v1';
  readonly encounterRulesCode: 'core-v1-encounter-v1';
  readonly encounterRef: string;
  readonly partySideRef: string | null;
  readonly currentTick: CombatTick;
  readonly stateVersion: number;
  readonly actionSequence: number;
  readonly status: CoreV1EncounterStatus;
  readonly participants: readonly CoreV1EncounterParticipant[];
  readonly relations: readonly CoreV1EncounterParticipantRelation[];
  readonly scheduledEvents: readonly CoreV1EncounterEvent[];
  readonly activeActions: readonly CoreV1CompiledEncounterAction[];
  readonly cooldowns: readonly CoreV1EncounterCooldown[];
  readonly actionPlans: readonly CoreV1StoredEncounterActionPlan[];
  readonly completionCandidate: CoreV1EncounterCompletionCandidate | null;
}

export interface CoreV1CreateEncounterInput {
  readonly encounterRef: string;
  readonly partySideRef?: string;
  readonly currentTick?: CombatTick;
  readonly status?: 'setup' | 'active';
  readonly participants: readonly CoreV1EncounterParticipantInput[];
  readonly relations: readonly CoreV1EncounterParticipantRelation[];
}

export interface CoreV1EncounterTieBreakRequest {
  readonly encounterRef: string;
  readonly actorRef: string;
}

export interface EncounterRollProvider {
  tieBreak(request: CoreV1EncounterTieBreakRequest): number;
  effectRolls(request: {
    readonly encounterRef: string;
    readonly actionRef: string;
    readonly sourceActorRef: string;
    readonly targetActorRef: string;
    readonly targetOrdinal: number;
  }): CoreV1InjectedRolls;
}

export type CoreV1ReactionOutcome =
  | { readonly kind: 'block'; readonly success: boolean; readonly blockValue: number; readonly completeBlock: boolean }
  | { readonly kind: 'active_dodge'; readonly success: boolean }
  | { readonly kind: 'interrupt'; readonly success: boolean }
  | { readonly kind: 'counter_attack'; readonly success: boolean };

export interface ReactionOutcomeResolver {
  resolve(request: {
    readonly encounter: CoreV1EncounterState;
    readonly action: CoreV1CompiledEncounterAction;
    readonly reactorActorRef: string;
    readonly reactionKind: ReactionKind;
    readonly currentTick: CombatTick;
  }): CoreV1ReactionOutcome;
}

export interface CoreV1EncounterRuntime {
  readonly rolls: EncounterRollProvider;
  readonly reactionOutcomes?: ReactionOutcomeResolver;
}

export interface CoreV1CompileEncounterActionInput {
  readonly encounter: CoreV1EncounterState;
  readonly intent: CoreV1EncounterActionIntent;
  readonly definition: CoreV1EncounterActionDefinition;
  readonly targetingContext: CoreV1EncounterTargetingContext;
}

export interface CoreV1EncounterInvalidatedEvent {
  readonly event: CoreV1EncounterEvent;
  readonly reason: CoreV1EncounterOperationIssueCode | 'STATE_CHANGED';
}

export interface CoreV1EncounterBatchResult {
  readonly encounterBefore: CoreV1EncounterState;
  readonly encounterAfter: CoreV1EncounterState;
  readonly processedEvents: readonly CoreV1EncounterEvent[];
  readonly resolvedActions: readonly string[];
  readonly effectResolutions: readonly CoreV1EffectSequenceResult[];
  readonly reactionResolutions: readonly CoreV1ReactionOutcome[];
  readonly movementChanges: readonly {
    readonly actorRef: string;
    readonly from: CombatZone;
    readonly to: CombatZone;
  }[];
  readonly cooldownChanges: readonly CoreV1EncounterCooldown[];
  readonly invalidatedEvents: readonly CoreV1EncounterInvalidatedEvent[];
  readonly readyActors: readonly string[];
  readonly stopReason: CoreV1EncounterStopReason | null;
  readonly continuationRequired: boolean;
}

export interface CoreV1ApplyEncounterIntentInput extends CoreV1CompileEncounterActionInput {
  readonly runtime: CoreV1EncounterRuntime;
}

export interface CoreV1ApplyEncounterActionPlanInput {
  readonly encounter: CoreV1EncounterState;
  readonly plan: CoreV1StoredEncounterActionPlan;
  readonly definitions: Readonly<Record<string, CoreV1EncounterActionDefinition>>;
  readonly targetingContexts: Readonly<Record<string, CoreV1EncounterTargetingContext>>;
  readonly runtime: CoreV1EncounterRuntime;
}

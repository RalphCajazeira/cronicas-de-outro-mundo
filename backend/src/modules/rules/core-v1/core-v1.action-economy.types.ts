import type { PrimaryAttributes } from './core-v1.types.js';

export type CombatTick = bigint;
export type TemporalProfileName = 'quick' | 'normal' | 'heavy' | 'very_heavy';
export type RepresentativeTemporalProfileName =
  | 'dagger' | 'short_sword' | 'long_sword' | 'heavy_axe' | 'bow' | 'crossbow'
  | 'unarmed' | 'potion' | 'equipment_swap' | 'whirlwind' | 'fireball' | 'long_spell';

export interface TemporalProfile {
  readonly preparation: CombatTick;
  readonly recovery: CombatTick;
  readonly cycle: CombatTick;
}

export type EncumbranceState = 'normal' | 'encumbered' | 'heavily_encumbered' | 'overloaded';

export interface PhysicalSpeedInput {
  readonly attributes: PrimaryAttributes;
  readonly weaponFamilyRank: number;
  readonly weaponWeightUnits: number;
  readonly twoHanded: boolean;
  readonly carriedWeightUnits: number;
  readonly carryingCapacityUnits: number;
  readonly actionSpecificSpeedModifiers?: number;
  readonly statusSpeedMultiplierBps?: number;
}

export interface PhysicalSpeedResult {
  readonly baseAttackSpeedBps: number;
  readonly rankSpeedBonusBps: number;
  readonly weaponHandlingCapacity: number;
  readonly handledWeaponWeight: number;
  readonly handlingPenaltyBps: number;
  readonly encumbranceState: EncumbranceState;
  readonly encumbrancePenaltyBps: number;
  readonly canStartAttackOrMovement: boolean;
  readonly effectiveAttackSpeedBps: number;
}

export interface MagicalSpeedInput {
  readonly attributes: PrimaryAttributes;
  readonly magicSchoolRank: number;
  readonly armorCastingPenaltyBps: number;
  readonly statusSpeedMultiplierBps?: number;
  readonly explicitRecoveryModifiers?: number;
}

export interface MagicalSpeedResult {
  readonly baseCastingSpeedBps: number;
  readonly schoolRankSpeedBonusBps: number;
  readonly effectiveCastingSpeedBps: number;
  readonly recoverySpeedBps: number;
}

export type ActionKind =
  | 'physical' | 'magic' | 'hybrid' | 'movement' | 'item' | 'equipment'
  | 'single' | 'multi_target' | 'area' | 'chain' | 'cleave' | 'combo'
  | 'reaction' | 'extra_action';
export type TargetMode = 'self' | 'single' | 'multiple' | 'area' | 'zone' | 'none';
export type ActionState =
  | 'scheduled' | 'preparing' | 'casting' | 'moving' | 'resolved' | 'interrupted'
  | 'cancelled' | 'invalidated' | 'recovering' | 'ready';

export interface ResourceReservation {
  readonly resource: 'mana' | 'sp' | 'custom';
  readonly resourceRef?: string;
  readonly amount: number;
}

export interface PureAction {
  readonly actionRef: string;
  readonly actorRef: string;
  readonly slotRef: string;
  readonly actionKind: ActionKind;
  readonly targetMode: TargetMode;
  readonly targetRefs: readonly string[];
  readonly startTick: CombatTick;
  readonly basePreparationTime: CombatTick;
  readonly baseRecoveryTime: CombatTick;
  readonly effectivePreparationTime: CombatTick;
  readonly effectiveRecoveryTime: CombatTick;
  readonly effectTick: CombatTick;
  readonly nextActionAtTick: CombatTick;
  readonly resourceReservations: readonly ResourceReservation[];
  readonly reactionDepth: 0 | 1 | 2;
  readonly canRetargetBeforeEffect: boolean;
  readonly interruptible: boolean;
  readonly state: ActionState;
}

export type TimelineEventType =
  | 'invalidation' | 'reaction_resolution' | 'action_effect'
  | 'channel_pulse' | 'upkeep' | 'actor_ready';

export interface TimelineEvent {
  readonly eventId: string;
  readonly sequence: number;
  readonly type: TimelineEventType;
  readonly tick: CombatTick;
  readonly actorRef: string;
  readonly actionRef?: string;
  readonly initiativeScore: number;
  readonly agility: number;
  readonly perception: number;
  readonly luck: number;
  readonly rngTieBreak: number;
  readonly stableRef: string;
  readonly reactionDepth: 0 | 1 | 2;
}

export interface EventResolution {
  readonly cancelEventIds?: readonly string[];
  readonly scheduledEvents?: readonly TimelineEvent[];
}

export interface EventBatchResult {
  readonly combatTickBefore: CombatTick;
  readonly combatTickAfter: CombatTick;
  readonly processed: readonly TimelineEvent[];
  readonly cancelled: readonly TimelineEvent[];
  readonly remaining: readonly TimelineEvent[];
}

export type ActionSlotType = 'primary' | 'secondary';
export interface ActionSlot {
  readonly slotRef: string;
  readonly slotType: ActionSlotType;
  readonly nextActionAtTick: CombatTick;
  readonly lastActionAtTick: CombatTick | null;
  readonly allowedActionTags: readonly string[];
  readonly potencyMultiplierBps: number;
  readonly stateVersion: number;
}

export type CombatZone = 'engaged' | 'near' | 'medium' | 'far' | 'out_of_range';
export type TerrainType = 'normal' | 'difficult' | 'severe';
export type MovementKind = 'approach' | 'retreat' | 'run' | 'disengage';
export interface MovementResult {
  readonly from: CombatZone;
  readonly to: CombatZone;
  readonly transitions: number;
  readonly movementTime: CombatTick;
  readonly conceptualSpCost: number;
  readonly combinedActionAtTick?: CombatTick;
}

export type CastingPhase = 'reserved' | 'casting' | 'completed' | 'interrupted' | 'channeling';
export interface CastingState {
  readonly startTick: CombatTick;
  readonly completionTick: CombatTick;
  readonly reservedMana: number;
  readonly phase: CastingPhase;
  readonly preparedUntilTick: CombatTick | null;
  readonly channelNextPulseTick: CombatTick | null;
}
export interface ManaDelta {
  readonly reserved: number;
  readonly consumed: number;
  readonly released: number;
}

export type ReactionKind = 'block' | 'active_dodge' | 'interrupt' | 'counter_attack';
export interface ReactionDefinition {
  readonly time: CombatTick;
  readonly nextActionPenalty: CombatTick;
  readonly cooldown: CombatTick;
}
export interface ReactionRequest {
  readonly kind: ReactionKind;
  readonly originActionRef: string;
  readonly sourceEventIsReaction: boolean;
  readonly currentDepth: 0 | 1 | 2;
  readonly startTick: CombatTick;
  readonly originEffectTick: CombatTick;
  readonly defensiveReactionAlreadyUsed: boolean;
  readonly counterAttackAlreadyUsed: boolean;
  readonly surprised: boolean;
  readonly actorFirstReadyTick: CombatTick | null;
}
export interface ReactionResolution {
  readonly kind: ReactionKind;
  readonly reactionDepth: 1 | 2;
  readonly completionTick: CombatTick;
  readonly nextActionPenalty: CombatTick;
  readonly cooldownUntilTick: CombatTick;
}

export interface ComboStep {
  readonly stepRef: string;
  readonly offset: CombatTick;
  readonly interruptWindow?: CombatTick;
}
export interface MultiTargetActionDefinition {
  readonly actionKind: 'single' | 'multi_target' | 'area' | 'chain' | 'cleave' | 'combo';
  readonly maxTargets: number;
  readonly chainCount: number;
  readonly chainInterval: CombatTick;
  readonly targetFalloffBps: number;
  readonly damageMultiplierPerTargetBps: readonly number[];
  readonly comboSteps: readonly ComboStep[];
  readonly stopOnMiss: boolean;
  readonly maxComboEvents: number;
}

export type ActionPlanStopCondition =
  | 'actorIncapacitated' | 'hostileBecomesReady' | 'targetSetChangedMaterially'
  | 'resourceBelowRequired' | 'zoneChanged' | 'newThreatDetected'
  | 'stateVersionChanged' | 'processingLimit';
export interface ActionPlanStep {
  readonly actionRef: string;
}
export interface ActionPlan {
  readonly actorRef: string;
  readonly maxPrimaryActions: number;
  readonly steps: readonly ActionPlanStep[];
  readonly stopConditions: readonly ActionPlanStopCondition[];
  readonly expectedCombatTick: CombatTick;
  readonly expectedStateVersion: number;
}
export interface ResolvedPlanStep {
  readonly actionRef: string;
  readonly resolved: boolean;
  readonly completionTick: CombatTick;
  readonly events: readonly TimelineEvent[];
  readonly stopSignals: readonly Exclude<ActionPlanStopCondition, 'processingLimit'>[];
}
export interface ActionPlanContext {
  readonly combatTick: CombatTick;
  readonly stateVersion: number;
  readonly nextReadyActors: readonly string[];
}
export interface ActionPlanResult {
  readonly resolvedActions: readonly string[];
  readonly events: readonly TimelineEvent[];
  readonly combatTickBefore: CombatTick;
  readonly combatTickAfter: CombatTick;
  readonly nextReadyActors: readonly string[];
  readonly stopReason: ActionPlanStopCondition | null;
  readonly continuationRequired: boolean;
}

export interface TemporalSlotInput {
  readonly cycle: CombatTick;
  readonly potencyMultiplierBps?: number;
  readonly secondary?: boolean;
}

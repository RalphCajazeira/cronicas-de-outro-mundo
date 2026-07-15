import type { CombatTick } from './core-v1.action-economy.types.js';
import type {
  CoreV1ActionProfile,
  CoreV1ContentKind,
  CoreV1Duration,
  CoreV1Effect,
  CoreV1MechanicalContentProfile,
  CoreV1PassiveModifierTarget,
  CoreV1ReactionKind,
  CoreV1SecondaryModifierCode,
  CoreV1StatusStacking,
  CoreV1TargetingType,
} from './core-v1.content-mechanics.types.js';
import type {
  CoreV1ContentVersionReference,
  CoreV1InventoryState,
} from './core-v1.inventory.types.js';
import type {
  AuthorizedNumericModifier,
  CoreV1Cost,
  DamageComponentDefinition,
  DamageImmunities,
  DamageResistanceProfile,
  MitigatedDamageComponent,
  PrimaryAttributeCode,
  PrimaryAttributes,
  SecondaryAttributes,
  ValidationIssue,
} from './core-v1.types.js';

export interface CoreV1CustomResourceReference {
  readonly type: 'custom_resource';
  readonly code: string;
}

export interface CoreV1ResourcePool {
  readonly current: number;
  readonly maximum: number;
}

export interface CoreV1CustomResourcePool {
  readonly resourceRef: CoreV1CustomResourceReference;
  readonly pool: CoreV1ResourcePool;
}

export interface CoreV1ResourceState {
  readonly hp: CoreV1ResourcePool;
  readonly mana: CoreV1ResourcePool;
  readonly sp: CoreV1ResourcePool;
  readonly customResources?: readonly CoreV1CustomResourcePool[];
}

export interface CoreV1CostModifierSet {
  readonly manaCostBps?: readonly AuthorizedNumericModifier[];
  readonly spCostBps?: readonly AuthorizedNumericModifier[];
  readonly hpCostBps?: readonly AuthorizedNumericModifier[];
}

export type CoreV1ResourceCode = 'hp' | 'mana' | 'sp' | 'custom';

export interface CoreV1ResourceDelta {
  readonly resource: CoreV1ResourceCode;
  readonly resourceRef?: CoreV1CustomResourceReference;
  readonly before: number;
  readonly after: number;
  readonly delta: number;
}

export interface CoreV1CostAmountReport {
  readonly resource: CoreV1ResourceCode;
  readonly resourceRef?: CoreV1CustomResourceReference;
  readonly base: number;
  readonly modifierBps: number;
  readonly effectiveMultiplierBps: number;
  readonly adjusted: number;
}

export interface CoreV1MaintenancePlan {
  readonly activationCost: number;
  readonly upkeepCost: number;
  readonly upkeepResource: 'mana' | 'sp';
}

export interface CoreV1CostResolution {
  readonly cost: CoreV1Cost;
  readonly amounts: readonly CoreV1CostAmountReport[];
  readonly resourceDeltas: readonly CoreV1ResourceDelta[];
  readonly maintenancePlan?: CoreV1MaintenancePlan;
  readonly affordable: boolean;
}

export type CoreV1InjectedRolls =
  | {
    readonly forcedMiss: true;
    readonly concentrationRoll?: number;
  }
  | {
    readonly forcedMiss?: false;
    readonly hitRollBps: number;
    readonly criticalRollBps: number;
    readonly concentrationRoll?: number;
  };

export interface CoreV1EffectContentVersionReference {
  readonly scope: 'world' | 'campaign';
  readonly contentType: CoreV1ContentKind;
  readonly code: string;
  readonly versionNumber: number;
}

export type CoreV1RuntimeDurationState =
  | { readonly type: 'ticks'; readonly expiresAtTick: CombatTick }
  | { readonly type: 'actions'; readonly remainingActions: number }
  | { readonly type: 'scene'; readonly scope: 'scene' }
  | { readonly type: 'encounter'; readonly scope: 'encounter' }
  | { readonly type: 'permanent'; readonly scope: 'permanent' };

export type CoreV1ActiveEffectPayload =
  | {
    readonly type: 'status';
    readonly contentVersion: CoreV1EffectContentVersionReference;
    readonly profile: CoreV1MechanicalContentProfile;
    readonly stacking: CoreV1StatusStacking;
    readonly baseDuration: CoreV1Duration;
  }
  | {
    readonly type: 'primary_modifier';
    readonly attributeCode: PrimaryAttributeCode;
    readonly amount: number;
  }
  | {
    readonly type: 'secondary_modifier';
    readonly secondaryCode: CoreV1SecondaryModifierCode;
    readonly amount: number;
  }
  | {
    readonly type: 'reaction_grant';
    readonly reactionKind: CoreV1ReactionKind;
    readonly reactionDepth: 1 | 2;
  };

export interface CoreV1ActiveEffectInstance {
  readonly effectRef: string;
  readonly sourceActorRef: string;
  readonly targetActorRef: string;
  readonly sourceContent: CoreV1EffectContentVersionReference;
  readonly effectIndex: number;
  readonly kind: CoreV1ActiveEffectPayload['type'];
  readonly stacks: number;
  readonly appliedAtTick: CombatTick;
  readonly durationState: CoreV1RuntimeDurationState;
  readonly payload: CoreV1ActiveEffectPayload;
}

export interface CoreV1ActorEffectContext {
  readonly actorRef: string;
  readonly primaryAttributes: PrimaryAttributes;
  readonly resources: CoreV1ResourceState;
  readonly secondaryAttributes: SecondaryAttributes;
  readonly activeEffects: readonly CoreV1ActiveEffectInstance[];
  readonly stateVersion: number;
}

export interface CoreV1TargetResolutionContext {
  readonly targetRef: string;
  readonly targetOrdinal: number;
  readonly damageMultiplierBps: number;
}

export interface CoreV1DamageDefenseContext {
  readonly blockValue: number;
  readonly completeBlock: boolean;
  readonly temporaryImmunities?: DamageImmunities;
  readonly temporaryResistances?: DamageResistanceProfile;
}

export interface CoreV1DamageApplicationInput {
  readonly attacker: CoreV1ActorEffectContext;
  readonly target: CoreV1ActorEffectContext;
  readonly damageComponents: readonly DamageComponentDefinition[];
  readonly weaponDamageComponents?: readonly DamageComponentDefinition[];
  readonly addDamage?: boolean;
  readonly relevantRank?: number;
  readonly situationalHitModifiersBps?: number;
  readonly rolls: CoreV1InjectedRolls;
  readonly targeting: CoreV1TargetResolutionContext;
  readonly defense: CoreV1DamageDefenseContext;
}

export interface CoreV1DamageApplicationResult {
  readonly hpBefore: number;
  readonly hpAfter: number;
  readonly damageApplied: number;
  readonly overkill: number;
  readonly defeatedCandidate: boolean;
  readonly hitChanceBps: number;
  readonly hit: boolean;
  readonly criticalChanceBps: number;
  readonly critical: boolean;
  readonly componentBreakdown: readonly MitigatedDamageComponent[];
}

export interface CoreV1ResourceRestorationResult {
  readonly resource: CoreV1ResourceCode;
  readonly resourceRef?: CoreV1CustomResourceReference;
  readonly before: number;
  readonly after: number;
  readonly requested: number;
  readonly applied: number;
  readonly wasted: number;
  readonly resources: CoreV1ResourceState;
}

export interface CoreV1StatusDefinitionBinding {
  readonly effectIndex: number;
  readonly effectRef: string;
  readonly contentVersion: CoreV1EffectContentVersionReference;
  readonly profile?: CoreV1MechanicalContentProfile;
}

export interface CoreV1RuntimeDurationBinding {
  readonly effectIndex: number;
  readonly duration: CoreV1Duration;
}

export interface CoreV1ActiveEffectChange {
  readonly change: 'created' | 'refreshed' | 'stacked' | 'replaced' | 'removed' | 'expired' | 'ignored';
  readonly effectRef: string;
  readonly stacksBefore: number;
  readonly stacksAfter: number;
  readonly stacksAdded: number;
  readonly ignoredDuplicate: boolean;
}

export interface CoreV1CollectedActiveModifier extends AuthorizedNumericModifier {
  readonly target: CoreV1PassiveModifierTarget;
  readonly source: { readonly type: 'status'; readonly ref: string };
}

export interface CoreV1MovementCommand {
  readonly from: 'engaged' | 'near' | 'medium' | 'far' | 'out_of_range';
  readonly to: 'engaged' | 'near' | 'medium' | 'far' | 'out_of_range';
  readonly maximumTransitions: 1 | 2;
}

export type CoreV1ConceptualEventType =
  | 'resource_spent'
  | 'resource_restored'
  | 'damage_applied'
  | 'status_applied'
  | 'status_refreshed'
  | 'status_stacked'
  | 'status_removed'
  | 'status_expired'
  | 'modifier_applied'
  | 'reaction_granted'
  | 'movement_requested'
  | 'consumable_consumed';

export interface CoreV1ConceptualEvent {
  readonly eventType: CoreV1ConceptualEventType;
  readonly sourceActorRef: string;
  readonly targetActorRef: string;
  readonly contentRef: CoreV1EffectContentVersionReference;
  readonly effectRef?: string;
  readonly amount?: number;
  readonly resource?: CoreV1ResourceCode;
  readonly stacks?: number;
}

export interface CoreV1EffectSequenceInput {
  readonly profile: CoreV1MechanicalContentProfile;
  readonly sourceContent: CoreV1EffectContentVersionReference;
  readonly sourceActor: CoreV1ActorEffectContext;
  readonly targetActor: CoreV1ActorEffectContext;
  readonly currentTick: CombatTick;
  readonly effectRefs: readonly string[];
  readonly statusDefinitions?: readonly CoreV1StatusDefinitionBinding[];
  readonly runtimeDurations?: readonly CoreV1RuntimeDurationBinding[];
  readonly rolls?: CoreV1InjectedRolls;
  readonly targeting: CoreV1TargetResolutionContext;
  readonly defense?: CoreV1DamageDefenseContext;
  readonly weaponDamageComponents?: readonly DamageComponentDefinition[];
  readonly costModifiers?: CoreV1CostModifierSet;
}

export interface CoreV1EffectSequenceResult {
  readonly sourceBefore: CoreV1ActorEffectContext;
  readonly sourceAfter: CoreV1ActorEffectContext;
  readonly targetBefore: CoreV1ActorEffectContext;
  readonly targetAfter: CoreV1ActorEffectContext;
  readonly costResolution: CoreV1CostResolution;
  readonly effectResults: readonly { readonly effectIndex: number; readonly type: CoreV1Effect['type']; readonly applied: boolean }[];
  readonly activeEffectChanges: readonly CoreV1ActiveEffectChange[];
  readonly resourceChanges: readonly CoreV1ResourceDelta[];
  readonly damageResults: readonly CoreV1DamageApplicationResult[];
  readonly movementCommands: readonly CoreV1MovementCommand[];
  readonly upkeepPlans: readonly CoreV1MaintenancePlan[];
  readonly events: readonly CoreV1ConceptualEvent[];
}

export interface CoreV1ConsumableUseInput extends Omit<CoreV1EffectSequenceInput, 'profile' | 'sourceContent'> {
  readonly inventory: CoreV1InventoryState;
  readonly entryRef: string;
  readonly contentVersionRef: CoreV1ContentVersionReference;
  readonly profile: CoreV1MechanicalContentProfile;
}

export interface CoreV1ConsumableUseResult {
  readonly inventoryBefore: CoreV1InventoryState;
  readonly inventoryAfter: CoreV1InventoryState;
  readonly sequence: CoreV1EffectSequenceResult;
  readonly actionProfile: CoreV1ActionProfile | null;
  readonly consumedEntryRef: string;
  readonly events: readonly CoreV1ConceptualEvent[];
}

export type CoreV1EffectResolutionErrorCode =
  | 'INVALID_CORE_V1_EFFECT_RESOLUTION'
  | 'INSUFFICIENT_RESOURCE'
  | 'INVALID_ACTIVE_EFFECT_STATE'
  | 'REQUIRES_ACTION_ORCHESTRATOR';

export type CoreV1EffectResolutionResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
    readonly ok: false;
    readonly code: CoreV1EffectResolutionErrorCode;
    readonly retryable: true;
    readonly issues: readonly ValidationIssue[];
  };

export interface CoreV1EffectRulesIdentity {
  readonly rulesetCode: 'core-v1';
  readonly effectRulesCode: 'core-v1-effects-v1';
  readonly schemaVersion: 1;
}

export interface CoreV1EffectRulesLimits {
  readonly maxActors: number;
  readonly maxEffectsPerSequence: number;
  readonly maxChanges: number;
  readonly maxActiveEffectsPerActor: number;
  readonly maxActiveModifiersPerActor: number;
  readonly maxStacksPerState: number;
  readonly rollBps: { readonly minimum: number; readonly maximum: number };
  readonly multiplierBps: { readonly minimum: 0; readonly maximum: number };
}

export interface CoreV1ApplyStatusInput {
  readonly actor: CoreV1ActorEffectContext;
  readonly sourceActorRef: string;
  readonly sourceContent: CoreV1EffectContentVersionReference;
  readonly effectIndex: number;
  readonly effectRef: string;
  readonly contentVersion: CoreV1EffectContentVersionReference;
  readonly profile: CoreV1MechanicalContentProfile;
  readonly duration: CoreV1Duration;
  readonly stacking: CoreV1StatusStacking;
  readonly currentTick: CombatTick;
}

export interface CoreV1ApplyStatusResult {
  readonly actor: CoreV1ActorEffectContext;
  readonly change: CoreV1ActiveEffectChange;
}

export interface CoreV1RemoveStatusInput {
  readonly actor: CoreV1ActorEffectContext;
  readonly contentVersion: CoreV1EffectContentVersionReference;
}

export interface CoreV1ActiveEffectLifecycleResult {
  readonly actor: CoreV1ActorEffectContext;
  readonly changes: readonly CoreV1ActiveEffectChange[];
}

export interface CoreV1TargetingValidationInput {
  readonly targetingType: CoreV1TargetingType;
  readonly context: CoreV1TargetResolutionContext;
}

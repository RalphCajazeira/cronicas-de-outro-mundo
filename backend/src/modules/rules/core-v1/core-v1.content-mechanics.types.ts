import type {
  RepresentativeTemporalProfileName,
  TemporalProfileName,
} from './core-v1.action-economy.types.js';
import type {
  CoreV1Cost,
  DamageComponentDefinition,
  NpcRole,
  PrimaryAttributeCode,
  ValidationIssue,
} from './core-v1.types.js';

export type CoreV1ContentKind =
  | 'weapon'
  | 'armor'
  | 'shield'
  | 'clothing'
  | 'spell'
  | 'skill'
  | 'talent'
  | 'item'
  | 'consumable'
  | 'status_effect'
  | 'race'
  | 'class'
  | 'creature_template';

export type CoreV1ProfileMode = 'mechanical' | 'narrative';
export type CoreV1Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' | 'mythic';
export type CoreV1Element =
  | 'fire'
  | 'ice'
  | 'lightning'
  | 'earth'
  | 'wind'
  | 'water'
  | 'light'
  | 'shadow'
  | 'poison'
  | 'arcane';

export type CoreV1ActivationType = 'passive' | 'active' | 'triggered' | 'reaction';
export type CoreV1Trigger =
  | 'on_hit'
  | 'on_critical_hit'
  | 'on_damage_taken'
  | 'on_block'
  | 'on_dodge'
  | 'on_cast'
  | 'on_resource_threshold'
  | 'on_scene_start'
  | 'on_encounter_start';
export type CoreV1ReactionKind = 'block' | 'dodge' | 'interrupt' | 'counter_attack';

export type CoreV1Activation =
  | { readonly type: 'passive' }
  | { readonly type: 'active' }
  | { readonly type: 'triggered'; readonly trigger: CoreV1Trigger }
  | { readonly type: 'reaction'; readonly reactionKind: CoreV1ReactionKind };

export type CoreV1ActionProfile =
  | TemporalProfileName
  | RepresentativeTemporalProfileName
  | CoreV1ReactionKind;

export type CoreV1TargetingType =
  | 'self'
  | 'single_target'
  | 'multi_target'
  | 'area'
  | 'chain'
  | 'cleave'
  | 'weapon_attack';
export type CoreV1RangeBand = 'self' | 'engaged' | 'near' | 'medium' | 'far';
export type CoreV1AreaShape = 'circle' | 'cone' | 'line' | 'burst' | 'zone';

export interface CoreV1Targeting {
  readonly type: CoreV1TargetingType;
  readonly rangeBand: CoreV1RangeBand;
  readonly maxTargets?: number;
  readonly areaShape?: CoreV1AreaShape;
  readonly chainCount?: number;
  readonly chainInterval?: number;
  readonly targetFalloffBps?: number;
  readonly damageMultiplierPerTargetBps?: readonly number[];
}

export type CoreV1Duration =
  | { readonly type: 'instant' }
  | { readonly type: 'ticks'; readonly value: number }
  | { readonly type: 'actions'; readonly value: number }
  | { readonly type: 'scene' }
  | { readonly type: 'encounter' }
  | { readonly type: 'permanent' };

export type CoreV1StatusStacking =
  | { readonly type: 'none' }
  | { readonly type: 'refresh' }
  | { readonly type: 'stack_intensity'; readonly maxStacks: number }
  | { readonly type: 'stack_duration'; readonly maxStacks: number }
  | { readonly type: 'replace' };

export interface CoreV1DamageImmunitiesDefinition {
  readonly physical?: boolean;
  readonly magical?: boolean;
  readonly elements?: readonly CoreV1Element[];
}

export interface CoreV1DefenseDefinition {
  readonly physicalFlatDefense?: number;
  readonly magicalFlatDefense?: number;
  readonly physicalResistanceBps?: number;
  readonly magicalResistanceBps?: number;
  readonly elementalResistanceBps?: Readonly<Partial<Record<CoreV1Element, number>>>;
  readonly blockValue?: number;
  readonly immunities?: CoreV1DamageImmunitiesDefinition;
}

export type CoreV1SecondaryModifierCode =
  | 'actorPhysicalPower'
  | 'actorMagicalPower'
  | 'physicalDefense'
  | 'magicalDefense'
  | 'accuracy'
  | 'evasion'
  | 'attackSpeedBps'
  | 'castingSpeedBps'
  | 'criticalChanceBps'
  | 'criticalDamageBps'
  | 'movementSpeed'
  | 'carryingCapacity'
  | 'physicalResistanceBps'
  | 'magicalResistanceBps'
  | 'maxHp'
  | 'maxMana'
  | 'maxSp';

export type CoreV1PassiveModifierTarget =
  | PrimaryAttributeCode
  | CoreV1SecondaryModifierCode
  | 'elementalResistanceBps'
  | 'hpRegen'
  | 'manaRegen'
  | 'spRegen'
  | 'manaCostBps'
  | 'spCostBps'
  | 'hpCostBps';

export type CoreV1ModifierSourceRule =
  | 'content_intrinsic'
  | 'equipped_content'
  | 'granted_content'
  | 'status_effect'
  | 'ruleset';

export interface CoreV1PassiveModifier {
  readonly target: CoreV1PassiveModifierTarget;
  readonly amount: number;
  readonly sourceRule: CoreV1ModifierSourceRule;
}

export interface CoreV1ContentReference {
  readonly contentKind: CoreV1ContentKind;
  readonly code: string;
}

export interface CoreV1Requirements {
  readonly minimumLevel?: number;
  readonly minimumPrimaryAttributes?: Readonly<Partial<Record<PrimaryAttributeCode, number>>>;
  readonly requiredContent?: readonly CoreV1ContentReference[];
  readonly requiredWeaponTags?: readonly string[];
  readonly requiredEquipmentTags?: readonly string[];
  readonly requiredRuleset?: 'core-v1';
}

export interface CoreV1Presentation {
  readonly summary?: string;
  readonly appearance?: string;
  readonly sensory?: string;
}

interface CoreV1EffectBase {
  readonly type:
    | 'damage'
    | 'add_damage'
    | 'restore_resource'
    | 'modify_primary_attribute'
    | 'modify_secondary_attribute'
    | 'apply_status'
    | 'remove_status'
    | 'grant_reaction'
    | 'movement';
}

export interface CoreV1DamageEffect extends CoreV1EffectBase {
  readonly type: 'damage';
  readonly damageComponents: readonly DamageComponentDefinition[];
  readonly targeting: CoreV1Targeting;
}

export interface CoreV1AddDamageEffect extends CoreV1EffectBase {
  readonly type: 'add_damage';
  readonly damageComponents: readonly DamageComponentDefinition[];
  readonly targeting: CoreV1Targeting & { readonly type: 'weapon_attack' };
}

export interface CoreV1RestoreResourceEffect extends CoreV1EffectBase {
  readonly type: 'restore_resource';
  readonly resource: 'hp' | 'mana' | 'sp';
  readonly amount: number;
  readonly targeting: CoreV1Targeting;
}

export interface CoreV1ModifyPrimaryAttributeEffect extends CoreV1EffectBase {
  readonly type: 'modify_primary_attribute';
  readonly attributeCode: PrimaryAttributeCode;
  readonly amount: number;
  readonly duration: CoreV1Duration;
}

export interface CoreV1ModifySecondaryAttributeEffect extends CoreV1EffectBase {
  readonly type: 'modify_secondary_attribute';
  readonly secondaryCode: CoreV1SecondaryModifierCode;
  readonly amount: number;
  readonly duration: CoreV1Duration;
}

export interface CoreV1ApplyStatusEffect extends CoreV1EffectBase {
  readonly type: 'apply_status';
  readonly statusRef: string;
  readonly duration: CoreV1Duration;
  readonly stacking: CoreV1StatusStacking;
}

export interface CoreV1RemoveStatusEffect extends CoreV1EffectBase {
  readonly type: 'remove_status';
  readonly statusRef: string;
}

export interface CoreV1GrantReactionEffect extends CoreV1EffectBase {
  readonly type: 'grant_reaction';
  readonly reactionKind: CoreV1ReactionKind;
  readonly reactionDepth: 1 | 2;
}

export interface CoreV1MovementEffect extends CoreV1EffectBase {
  readonly type: 'movement';
  readonly from: 'engaged' | 'near' | 'medium' | 'far' | 'out_of_range';
  readonly to: 'engaged' | 'near' | 'medium' | 'far' | 'out_of_range';
  readonly maximumTransitions: 1 | 2;
}

export type CoreV1Effect =
  | CoreV1DamageEffect
  | CoreV1AddDamageEffect
  | CoreV1RestoreResourceEffect
  | CoreV1ModifyPrimaryAttributeEffect
  | CoreV1ModifySecondaryAttributeEffect
  | CoreV1ApplyStatusEffect
  | CoreV1RemoveStatusEffect
  | CoreV1GrantReactionEffect
  | CoreV1MovementEffect;

export type CoreV1Handedness = 'one_handed' | 'two_handed' | 'versatile';
export type CoreV1EquipmentSlot =
  | 'main_hand'
  | 'off_hand'
  | 'head'
  | 'chest'
  | 'hands'
  | 'legs'
  | 'feet'
  | 'body'
  | 'accessory';

export interface CoreV1CreatureTemplateDefinition {
  readonly role: NpcRole;
  readonly primaryAttributeBudget: number;
  readonly contentRefs: readonly CoreV1ContentReference[];
  readonly tags: readonly string[];
  readonly limits: {
    readonly maxContentRefs: number;
    readonly maxActiveAbilities: number;
  };
}

interface CoreV1ContentProfileIdentity {
  readonly schemaVersion: 1;
  readonly rulesetCode: 'core-v1';
  readonly profileMode: CoreV1ProfileMode;
  readonly contentKind: CoreV1ContentKind;
  readonly code: string;
  readonly name: string;
  readonly description?: string;
  readonly lore?: string;
  readonly tags?: readonly string[];
  readonly presentation?: CoreV1Presentation;
}

export interface CoreV1NarrativeContentProfile extends CoreV1ContentProfileIdentity {
  readonly profileMode: 'narrative';
}

export interface CoreV1MechanicalContentProfile extends CoreV1ContentProfileIdentity {
  readonly profileMode: 'mechanical';
  readonly tier: number;
  readonly rarity: CoreV1Rarity;
  readonly activation: CoreV1Activation;
  readonly cost: CoreV1Cost;
  readonly actionProfile?: CoreV1ActionProfile;
  readonly targeting?: CoreV1Targeting;
  readonly damageComponents?: readonly DamageComponentDefinition[];
  readonly defense?: CoreV1DefenseDefinition;
  readonly effects?: readonly CoreV1Effect[];
  readonly passiveModifiers?: readonly CoreV1PassiveModifier[];
  readonly requirements?: CoreV1Requirements;
  readonly handedness?: CoreV1Handedness;
  readonly weaponTags?: readonly string[];
  readonly equipmentSlots?: readonly CoreV1EquipmentSlot[];
  readonly consumable?: boolean;
  readonly duration?: CoreV1Duration;
  readonly stacking?: CoreV1StatusStacking;
  readonly grants?: readonly CoreV1ContentReference[];
  readonly template?: CoreV1CreatureTemplateDefinition;
}

export type CoreV1ContentProfile = CoreV1NarrativeContentProfile | CoreV1MechanicalContentProfile;

export type CoreV1ContentValidationResult =
  | { readonly ok: true; readonly value: CoreV1ContentProfile }
  | {
    readonly ok: false;
    readonly code: 'INVALID_CORE_V1_CONTENT_PROFILE';
    readonly retryable: true;
    readonly issues: readonly ValidationIssue[];
  };

import type {
  CoreV1ActionProfile,
  CoreV1ActivationType,
  CoreV1AreaShape,
  CoreV1ContentKind,
  CoreV1Element,
  CoreV1EquipmentSlot,
  CoreV1ModifierSourceRule,
  CoreV1PassiveModifierTarget,
  CoreV1Rarity,
  CoreV1ReactionKind,
  CoreV1SecondaryModifierCode,
  CoreV1TargetingType,
  CoreV1Trigger,
} from './core-v1.content-mechanics.types.js';

export const CORE_V1_CONTENT_SCHEMA_VERSION = 1 as const;
export const CORE_V1_CONTENT_RULESET_CODE = 'core-v1' as const;
export const CORE_V1_MAX_CONTENT_TIER = 10;
export const CORE_V1_MAX_STATUS_STACKS = 20;
export const CORE_V1_MAX_DURATION_TICKS = 1_000_000_000;
export const CORE_V1_MAX_DURATION_ACTIONS = 1_000;
export const CORE_V1_MAX_CONTENT_EFFECTS = 12;
export const CORE_V1_MAX_PASSIVE_MODIFIERS = 12;
export const CORE_V1_MAX_CONTENT_REFERENCES = 32;
export const CORE_V1_MAX_CONTENT_TAGS = 24;
export const CORE_V1_MAX_TARGETS = 64;

export const CORE_V1_CONTENT_KINDS = Object.freeze([
  'weapon', 'armor', 'shield', 'clothing', 'spell', 'skill', 'talent', 'item',
  'consumable', 'status_effect', 'race', 'class', 'creature_template',
] as const) satisfies readonly CoreV1ContentKind[];

export const CORE_V1_RARITIES = Object.freeze([
  'common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic',
] as const) satisfies readonly CoreV1Rarity[];

// Calibratable RulesetVersion configuration. It limits extra independent properties;
// it never expands the numeric power envelope of the content tier.
export const CORE_V1_RARITY_ADDITIONAL_PROPERTY_LIMITS = Object.freeze({
  common: 0,
  uncommon: 1,
  rare: 2,
  epic: 3,
  legendary: 4,
  mythic: 5,
}) satisfies Readonly<Record<CoreV1Rarity, number>>;

export const CORE_V1_ELEMENTS = Object.freeze([
  'fire', 'ice', 'lightning', 'earth', 'wind', 'water', 'light', 'shadow', 'poison', 'arcane',
] as const) satisfies readonly CoreV1Element[];

export const CORE_V1_ACTIVATION_TYPES = Object.freeze([
  'passive', 'active', 'triggered', 'reaction',
] as const) satisfies readonly CoreV1ActivationType[];

export const CORE_V1_TRIGGERS = Object.freeze([
  'on_hit', 'on_critical_hit', 'on_damage_taken', 'on_block', 'on_dodge', 'on_cast',
  'on_resource_threshold', 'on_scene_start', 'on_encounter_start',
] as const) satisfies readonly CoreV1Trigger[];

export const CORE_V1_CONTENT_REACTIONS = Object.freeze([
  'block', 'dodge', 'interrupt', 'counter_attack',
] as const) satisfies readonly CoreV1ReactionKind[];

export const CORE_V1_CONTENT_ACTION_PROFILES = Object.freeze([
  'quick', 'normal', 'heavy', 'very_heavy',
  'dagger', 'short_sword', 'long_sword', 'heavy_axe', 'bow', 'crossbow', 'unarmed',
  'potion', 'equipment_swap', 'whirlwind', 'fireball', 'long_spell',
  'block', 'dodge', 'interrupt', 'counter_attack',
] as const) satisfies readonly CoreV1ActionProfile[];

export const CORE_V1_TARGETING_TYPES = Object.freeze([
  'self', 'single_target', 'multi_target', 'area', 'chain', 'cleave', 'weapon_attack',
] as const) satisfies readonly CoreV1TargetingType[];

export const CORE_V1_CONTENT_EFFECTS = Object.freeze([
  'damage', 'add_damage', 'restore_resource', 'modify_primary_attribute',
  'modify_secondary_attribute', 'apply_status', 'remove_status', 'grant_reaction', 'movement',
] as const);

export const CORE_V1_AREA_SHAPES = Object.freeze([
  'circle', 'cone', 'line', 'burst', 'zone',
] as const) satisfies readonly CoreV1AreaShape[];

export const CORE_V1_SECONDARY_MODIFIER_CODES = Object.freeze([
  'actorPhysicalPower', 'actorMagicalPower', 'physicalDefense', 'magicalDefense', 'accuracy',
  'evasion', 'attackSpeedBps', 'castingSpeedBps', 'criticalChanceBps', 'criticalDamageBps',
  'movementSpeed', 'carryingCapacity', 'physicalResistanceBps', 'magicalResistanceBps',
  'maxHp', 'maxMana', 'maxSp',
] as const) satisfies readonly CoreV1SecondaryModifierCode[];

export const CORE_V1_PASSIVE_MODIFIER_TARGETS = Object.freeze([
  'strength', 'vitality', 'agility', 'dexterity', 'intelligence', 'wisdom', 'perception',
  'willpower', 'luck',
  ...CORE_V1_SECONDARY_MODIFIER_CODES,
  'elementalResistanceBps', 'hpRegen', 'manaRegen', 'spRegen',
  'manaCostBps', 'spCostBps', 'hpCostBps',
] as const) satisfies readonly CoreV1PassiveModifierTarget[];

export const CORE_V1_MODIFIER_SOURCE_RULES = Object.freeze([
  'content_intrinsic', 'equipped_content', 'granted_content', 'status_effect', 'ruleset',
] as const) satisfies readonly CoreV1ModifierSourceRule[];

export const CORE_V1_EQUIPMENT_SLOTS = Object.freeze([
  'main_hand', 'off_hand', 'head', 'chest', 'hands', 'legs', 'feet', 'body', 'accessory',
] as const) satisfies readonly CoreV1EquipmentSlot[];

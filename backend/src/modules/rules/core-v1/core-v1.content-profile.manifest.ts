import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../shared/json/canonical-json.js';
import {
  CORE_V1_ACTIVATION_TYPES,
  CORE_V1_AREA_SHAPES,
  CORE_V1_CONTENT_ACTION_PROFILES,
  CORE_V1_CONTENT_EFFECTS,
  CORE_V1_CONTENT_KINDS,
  CORE_V1_CONTENT_REACTIONS,
  CORE_V1_CONTENT_RULESET_CODE,
  CORE_V1_CONTENT_SCHEMA_VERSION,
  CORE_V1_ELEMENTS,
  CORE_V1_EQUIPMENT_SLOTS,
  CORE_V1_MAX_CONTENT_EFFECTS,
  CORE_V1_MAX_CONTENT_REFERENCES,
  CORE_V1_MAX_CONTENT_TAGS,
  CORE_V1_MAX_CONTENT_TIER,
  CORE_V1_MAX_DURATION_ACTIONS,
  CORE_V1_MAX_DURATION_TICKS,
  CORE_V1_MAX_PASSIVE_MODIFIERS,
  CORE_V1_MAX_STATUS_STACKS,
  CORE_V1_MAX_TARGETS,
  CORE_V1_MODIFIER_SOURCE_RULES,
  CORE_V1_PASSIVE_MODIFIER_TARGETS,
  CORE_V1_RARITIES,
  CORE_V1_RARITY_ADDITIONAL_PROPERTY_LIMITS,
  CORE_V1_SECONDARY_MODIFIER_CODES,
  CORE_V1_TARGETING_TYPES,
  CORE_V1_TRIGGERS,
} from './core-v1.content-mechanics.config.js';
import {
  CORE_V1_AREA_PER_TARGET_DAMAGE_CAP_BPS,
  CORE_V1_AREA_TOTAL_DAMAGE_CAP_BPS,
  CORE_V1_ATTRIBUTE_HARD_CAP,
  CORE_V1_LEVEL_CAP,
  CORE_V1_MAX_DAMAGE_COMPONENTS,
  CORE_V1_PRIMARY_ATTRIBUTES,
} from './core-v1.config.js';

export const CORE_V1_CONTENT_PROFILE_CODE = 'core-v1-content-v1' as const;
export const CORE_V1_CONTENT_PROFILE_SCHEMA_VERSION = 1 as const;

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const CORE_V1_CONTENT_PROFILE_SNAPSHOT = deepFreeze({
  identity: {
    code: CORE_V1_CONTENT_PROFILE_CODE,
    schemaVersion: CORE_V1_CONTENT_PROFILE_SCHEMA_VERSION,
    rulesetCode: CORE_V1_CONTENT_RULESET_CODE,
    contentSchemaVersion: CORE_V1_CONTENT_SCHEMA_VERSION,
  },
  catalogs: {
    contentKinds: [...CORE_V1_CONTENT_KINDS],
    profileModes: ['mechanical', 'narrative'],
    narrativeKinds: ['clothing', 'item', 'class'],
    rarities: [...CORE_V1_RARITIES],
    rarityAdditionalPropertyLimits: CORE_V1_RARITY_ADDITIONAL_PROPERTY_LIMITS,
    elements: [...CORE_V1_ELEMENTS],
    activationTypes: [...CORE_V1_ACTIVATION_TYPES],
    triggers: [...CORE_V1_TRIGGERS],
    reactions: [...CORE_V1_CONTENT_REACTIONS],
    actionProfiles: [...CORE_V1_CONTENT_ACTION_PROFILES],
    targetingTypes: [...CORE_V1_TARGETING_TYPES],
    rangeBands: ['self', 'engaged', 'near', 'medium', 'far'],
    areaShapes: [...CORE_V1_AREA_SHAPES],
    durationTypes: ['instant', 'ticks', 'actions', 'scene', 'encounter', 'permanent'],
    stackingTypes: ['none', 'refresh', 'stack_intensity', 'stack_duration', 'replace'],
    effects: [...CORE_V1_CONTENT_EFFECTS],
    primaryAttributes: [...CORE_V1_PRIMARY_ATTRIBUTES],
    secondaryModifiers: [...CORE_V1_SECONDARY_MODIFIER_CODES],
    passiveModifierTargets: [...CORE_V1_PASSIVE_MODIFIER_TARGETS],
    modifierSourceRules: [...CORE_V1_MODIFIER_SOURCE_RULES],
    equipmentSlots: [...CORE_V1_EQUIPMENT_SLOTS],
  },
  limits: {
    maximumTier: CORE_V1_MAX_CONTENT_TIER,
    maximumDamageComponents: CORE_V1_MAX_DAMAGE_COMPONENTS,
    maximumEffects: CORE_V1_MAX_CONTENT_EFFECTS,
    maximumPassiveModifiers: CORE_V1_MAX_PASSIVE_MODIFIERS,
    maximumContentReferences: CORE_V1_MAX_CONTENT_REFERENCES,
    maximumTags: CORE_V1_MAX_CONTENT_TAGS,
    maximumTargets: CORE_V1_MAX_TARGETS,
    maximumStatusStacks: CORE_V1_MAX_STATUS_STACKS,
    maximumDurationTicks: CORE_V1_MAX_DURATION_TICKS,
    maximumDurationActions: CORE_V1_MAX_DURATION_ACTIONS,
    maximumLevel: CORE_V1_LEVEL_CAP,
    maximumPrimaryAttribute: CORE_V1_ATTRIBUTE_HARD_CAP,
    areaDamageCapsBps: {
      perTarget: CORE_V1_AREA_PER_TARGET_DAMAGE_CAP_BPS,
      total: CORE_V1_AREA_TOTAL_DAMAGE_CAP_BPS,
    },
    reactionDepth: 2,
  },
});

export const CORE_V1_CONTENT_PROFILE_CANONICAL_JSON = canonicalJson(CORE_V1_CONTENT_PROFILE_SNAPSHOT);
export const CORE_V1_CONTENT_PROFILE_HASH = createHash('sha256')
  .update(CORE_V1_CONTENT_PROFILE_CANONICAL_JSON)
  .digest('hex');

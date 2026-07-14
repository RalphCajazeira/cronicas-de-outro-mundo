import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../shared/json/canonical-json.js';
import {
  CORE_V1_EFFECT_RULES_CODE,
  CORE_V1_EFFECT_RULESET_CODE,
  CORE_V1_EFFECT_SCHEMA_VERSION,
  CORE_V1_MAX_ACTIVE_EFFECTS_PER_ACTOR,
  CORE_V1_MAX_ACTIVE_MODIFIERS_PER_ACTOR,
  CORE_V1_MAX_EFFECTS_PER_SEQUENCE,
  CORE_V1_MAX_OPERATIONAL_MULTIPLIER_BPS,
  CORE_V1_MAX_RESOLUTION_ACTORS,
  CORE_V1_MAX_RESOLUTION_CHANGES,
  CORE_V1_MAX_ROLL_BPS,
  CORE_V1_MAX_RUNTIME_STATUS_STACKS,
  CORE_V1_MIN_ROLL_BPS,
} from './core-v1.effects.config.js';

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const CORE_V1_EFFECT_RULES_SNAPSHOT = deepFreeze({
  identity: {
    code: CORE_V1_EFFECT_RULES_CODE,
    schemaVersion: CORE_V1_EFFECT_SCHEMA_VERSION,
    rulesetCode: CORE_V1_EFFECT_RULESET_CODE,
  },
  limits: {
    maximumActorsPerResolution: CORE_V1_MAX_RESOLUTION_ACTORS,
    maximumEffectsPerSequence: CORE_V1_MAX_EFFECTS_PER_SEQUENCE,
    maximumChangesPerResolution: CORE_V1_MAX_RESOLUTION_CHANGES,
    maximumActiveEffectsPerActor: CORE_V1_MAX_ACTIVE_EFFECTS_PER_ACTOR,
    maximumActiveModifiersPerActor: CORE_V1_MAX_ACTIVE_MODIFIERS_PER_ACTOR,
    maximumStacksPerState: CORE_V1_MAX_RUNTIME_STATUS_STACKS,
  },
  rolls: {
    kinds: ['hit', 'critical', 'concentration'],
    minimumBps: CORE_V1_MIN_ROLL_BPS,
    maximumBps: CORE_V1_MAX_ROLL_BPS,
    generatedByBackend: true,
  },
  multipliers: { minimumBps: 0, maximumBps: CORE_V1_MAX_OPERATIONAL_MULTIPLIER_BPS },
  costs: ['mana', 'sp', 'hybrid', 'active_defense', 'special_dodge', 'maintenance', 'hp', 'none', 'custom'],
  activeStateTypes: ['status', 'primary_modifier', 'secondary_modifier', 'reaction_grant'],
  durations: ['ticks', 'actions', 'scene', 'encounter', 'permanent'],
  stacking: ['none', 'refresh', 'stack_intensity', 'stack_duration', 'replace'],
  conceptualEvents: [
    'resource_spent', 'resource_restored', 'damage_applied', 'status_applied',
    'status_refreshed', 'status_stacked', 'status_removed', 'status_expired',
    'modifier_applied', 'reaction_granted', 'movement_requested', 'consumable_consumed',
  ],
  atomicity: {
    validateBeforeRolls: true,
    persistResolutionRollsResourcesInventoryAndEffectsTogether: true,
    replayDoesNotReroll: true,
    failureLeavesNoPartialState: true,
  },
});

export const CORE_V1_EFFECT_RULES_CANONICAL_JSON = canonicalJson(CORE_V1_EFFECT_RULES_SNAPSHOT);
export const CORE_V1_EFFECT_RULES_HASH = createHash('sha256')
  .update(CORE_V1_EFFECT_RULES_CANONICAL_JSON)
  .digest('hex');

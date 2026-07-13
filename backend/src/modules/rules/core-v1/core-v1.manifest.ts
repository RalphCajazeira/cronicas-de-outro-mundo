import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../shared/json/canonical-json.js';
import {
  CORE_V1_ACTION_ECONOMY_REVISION,
  CORE_V1_ENCOUNTER_WINDOW_TICKS,
  CORE_V1_MAX_COMBAT_TICK,
  CORE_V1_MAX_COMBO_EVENTS,
  CORE_V1_MAX_COMBO_STEPS,
  CORE_V1_MAX_EVENT_QUEUE_SIZE,
  CORE_V1_MAX_PLAN_ACTIONS,
  CORE_V1_MAX_PROCESSING_ADVANCE,
  CORE_V1_MAX_PROCESSING_EVENTS,
  CORE_V1_MAX_TECHNICAL_TICK,
  CORE_V1_MIN_IMPACT_INTERVAL,
  CORE_V1_REACTION_DEFINITIONS,
  CORE_V1_REFERENCE_ACTION_TICKS,
  CORE_V1_REPRESENTATIVE_TEMPORAL_PROFILES,
  CORE_V1_TEMPORAL_PROFILES,
  CORE_V1_TEMPORAL_XP_WINDOW_TICKS,
  CORE_V1_TERRAIN_MULTIPLIER_BPS,
} from './core-v1.action-economy.config.js';
import {
  CORE_V1_AREA_PER_TARGET_DAMAGE_CAP_BPS,
  CORE_V1_AREA_TOTAL_DAMAGE_CAP_BPS,
  CORE_V1_ATTRIBUTE_HARD_CAP,
  CORE_V1_ATTRIBUTE_PRESETS,
  CORE_V1_ATTRIBUTE_SOFT_CAP,
  CORE_V1_CREATION_ATTRIBUTE_MAX,
  CORE_V1_CREATION_ATTRIBUTE_MIN,
  CORE_V1_INITIAL_ATTRIBUTE_BUDGET,
  CORE_V1_INITIAL_LEVEL,
  CORE_V1_INITIAL_XP,
  CORE_V1_HYBRID_STANDARD_COST_BPS,
  CORE_V1_LEVEL_CAP,
  CORE_V1_MASTERY_XP,
  CORE_V1_MAX_DAMAGE_COMPONENTS,
  CORE_V1_NPC_INVENTORY_LIMITS,
  CORE_V1_NPC_RESOURCE_MULTIPLIERS,
  CORE_V1_NPC_THREAT_MULTIPLIER_BPS,
  CORE_V1_PRIMARY_ATTRIBUTES,
  CORE_V1_RULESET_ID,
  CORE_V1_TIER_DAMAGE_ENVELOPES,
} from './core-v1.config.js';
import { getHybridCost, getManaCostBand, getSpCostBand } from './core-v1.content.js';

export const CORE_V1_RULESET_CODE = 'core' as const;
export const CORE_V1_RULESET_NAME = 'Core Ruleset' as const;
export const CORE_V1_VERSION_CODE = CORE_V1_RULESET_ID;
export const CORE_V1_REVISION = CORE_V1_ACTION_ECONOMY_REVISION;
export const CORE_V1_SCHEMA_VERSION = 1 as const;

function tick(value: bigint): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted)) throw new RangeError('Core v1 tick is outside the manifest safe-integer range');
  return converted;
}

function ticks<T extends Readonly<Record<string, Readonly<Record<string, bigint>>>>>(input: T) {
  return Object.fromEntries(Object.entries(input).map(([name, values]) => [
    name,
    Object.fromEntries(Object.entries(values).map(([key, value]) => [key, tick(value)])),
  ]));
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const tierCosts = Array.from({ length: 10 }, (_, index) => {
  const tier = index + 1;
  return { tier, mana: getManaCostBand(tier), sp: getSpCostBand(tier), hybrid: getHybridCost(tier) };
});

export const CORE_V1_CONFIG_SNAPSHOT = deepFreeze({
  identity: {
    rulesetCode: CORE_V1_RULESET_CODE,
    versionCode: CORE_V1_VERSION_CODE,
    numericalRevision: 'RC1',
    actionEconomyRevision: CORE_V1_REVISION,
    schemaVersion: CORE_V1_SCHEMA_VERSION,
  },
  attributes: {
    primary: [...CORE_V1_PRIMARY_ATTRIBUTES],
    initialBudget: CORE_V1_INITIAL_ATTRIBUTE_BUDGET,
    creationMinimum: CORE_V1_CREATION_ATTRIBUTE_MIN,
    creationMaximum: CORE_V1_CREATION_ATTRIBUTE_MAX,
    softCap: CORE_V1_ATTRIBUTE_SOFT_CAP,
    hardCap: CORE_V1_ATTRIBUTE_HARD_CAP,
    presets: CORE_V1_ATTRIBUTE_PRESETS,
  },
  progression: {
    initialLevel: CORE_V1_INITIAL_LEVEL,
    initialXp: CORE_V1_INITIAL_XP,
    levelCap: CORE_V1_LEVEL_CAP,
    masteryXp: CORE_V1_MASTERY_XP,
  },
  content: {
    maximumDamageComponents: CORE_V1_MAX_DAMAGE_COMPONENTS,
    tierDamageEnvelopes: CORE_V1_TIER_DAMAGE_ENVELOPES,
    areaDamageCapsBps: {
      perTarget: CORE_V1_AREA_PER_TARGET_DAMAGE_CAP_BPS,
      total: CORE_V1_AREA_TOTAL_DAMAGE_CAP_BPS,
    },
    tierCosts,
    hybridStandardCostBps: CORE_V1_HYBRID_STANDARD_COST_BPS,
    npcResourceMultipliers: CORE_V1_NPC_RESOURCE_MULTIPLIERS,
    npcThreatMultipliersBps: CORE_V1_NPC_THREAT_MULTIPLIER_BPS,
    provisionalNpcInventoryLimits: CORE_V1_NPC_INVENTORY_LIMITS,
  },
  actionEconomy: {
    referenceActionTicks: tick(CORE_V1_REFERENCE_ACTION_TICKS),
    maximumCombatTick: tick(CORE_V1_MAX_COMBAT_TICK),
    maximumTechnicalTick: tick(CORE_V1_MAX_TECHNICAL_TICK),
    maximumEventQueueSize: CORE_V1_MAX_EVENT_QUEUE_SIZE,
    maximumPlanActions: CORE_V1_MAX_PLAN_ACTIONS,
    maximumProcessingEvents: CORE_V1_MAX_PROCESSING_EVENTS,
    maximumProcessingAdvance: tick(CORE_V1_MAX_PROCESSING_ADVANCE),
    maximumComboSteps: CORE_V1_MAX_COMBO_STEPS,
    maximumComboEvents: CORE_V1_MAX_COMBO_EVENTS,
    minimumImpactInterval: tick(CORE_V1_MIN_IMPACT_INTERVAL),
    encounterWindowTicks: tick(CORE_V1_ENCOUNTER_WINDOW_TICKS),
    temporalXpWindowTicks: tick(CORE_V1_TEMPORAL_XP_WINDOW_TICKS),
    temporalProfiles: ticks(CORE_V1_TEMPORAL_PROFILES),
    representativeTemporalProfiles: ticks(CORE_V1_REPRESENTATIVE_TEMPORAL_PROFILES),
    terrainMultipliersBps: CORE_V1_TERRAIN_MULTIPLIER_BPS,
    reactions: ticks(CORE_V1_REACTION_DEFINITIONS),
    maximumReactionDepth: 2,
  },
});

export const CORE_V1_CONFIG_CANONICAL_JSON = canonicalJson(CORE_V1_CONFIG_SNAPSHOT);
export const CORE_V1_CONFIG_HASH = createHash('sha256').update(CORE_V1_CONFIG_CANONICAL_JSON).digest('hex');

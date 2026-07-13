import type {
  NpcResourceMultipliers, NpcRole, PrimaryAttributeCode, PrimaryAttributePreset,
  PrimaryAttributes, TierDamageEnvelope,
} from './core-v1.types.js';

export const CORE_V1_RULESET_ID = 'core-v1' as const;

export const CORE_V1_PRIMARY_ATTRIBUTES = Object.freeze([
  'strength',
  'vitality',
  'agility',
  'dexterity',
  'intelligence',
  'wisdom',
  'perception',
  'willpower',
  'luck',
] as const) satisfies readonly PrimaryAttributeCode[];

export const CORE_V1_INITIAL_LEVEL = 1;
export const CORE_V1_INITIAL_XP = 0;
export const CORE_V1_LEVEL_CAP = 20;
export const CORE_V1_INITIAL_ATTRIBUTE_BUDGET = CORE_V1_PRIMARY_ATTRIBUTES.length * 10;
export const CORE_V1_CREATION_ATTRIBUTE_MIN = 4;
export const CORE_V1_CREATION_ATTRIBUTE_MAX = 16;
export const CORE_V1_ATTRIBUTE_SOFT_CAP = 20;
export const CORE_V1_ATTRIBUTE_HARD_CAP = 30;
export const CORE_V1_MAX_DAMAGE_COMPONENTS = 6;
export const CORE_V1_MASTERY_XP = 2000;
export const CORE_V1_AREA_PER_TARGET_DAMAGE_CAP_BPS = 6000;
export const CORE_V1_AREA_TOTAL_DAMAGE_CAP_BPS = 15000;
export const CORE_V1_HYBRID_STANDARD_COST_BPS = 6000;

export const CORE_V1_ATTRIBUTE_PRESETS = Object.freeze({
  balanced: Object.freeze({
    strength: 10, vitality: 10, agility: 10, dexterity: 10, intelligence: 10,
    wisdom: 10, perception: 10, willpower: 10, luck: 10,
  }),
  physical: Object.freeze({
    strength: 15, vitality: 13, agility: 12, dexterity: 14, intelligence: 6,
    wisdom: 6, perception: 10, willpower: 9, luck: 5,
  }),
  magical: Object.freeze({
    strength: 5, vitality: 9, agility: 7, dexterity: 10, intelligence: 16,
    wisdom: 15, perception: 10, willpower: 12, luck: 6,
  }),
}) satisfies Readonly<Record<PrimaryAttributePreset, PrimaryAttributes>>;

export const CORE_V1_TIER_DAMAGE_ENVELOPES = Object.freeze({
  1: Object.freeze({ minimum: 3, maximum: 10 }),
  2: Object.freeze({ minimum: 5, maximum: 12 }),
  3: Object.freeze({ minimum: 7, maximum: 16 }),
  4: Object.freeze({ minimum: 10, maximum: 19 }),
  5: Object.freeze({ minimum: 13, maximum: 24 }),
  6: Object.freeze({ minimum: 16, maximum: 28 }),
  7: Object.freeze({ minimum: 20, maximum: 33 }),
  8: Object.freeze({ minimum: 24, maximum: 38 }),
  9: Object.freeze({ minimum: 29, maximum: 43 }),
  10: Object.freeze({ minimum: 34, maximum: 50 }),
}) satisfies Readonly<Record<number, TierDamageEnvelope>>;

export const CORE_V1_NPC_RESOURCE_MULTIPLIERS = Object.freeze({
  minion: Object.freeze({ hpBps: 3000, manaBps: 5000, spBps: 5000 }),
  standard: Object.freeze({ hpBps: 9000, manaBps: 9000, spBps: 9000 }),
  elite: Object.freeze({ hpBps: 14000, manaBps: 12500, spBps: 12500 }),
  boss: Object.freeze({ hpBps: 25000, manaBps: 17500, spBps: 17500 }),
}) satisfies Readonly<Record<NpcRole, NpcResourceMultipliers>>;

export const CORE_V1_NPC_THREAT_MULTIPLIER_BPS = Object.freeze({
  minion: 2500,
  standard: 10000,
  elite: 20000,
  boss: 40000,
}) satisfies Readonly<Record<NpcRole, number>>;

// Provisional RulesetVersion defaults only; inventory runtime is outside Phase 1A.
export const CORE_V1_NPC_INVENTORY_LIMITS = Object.freeze({
  minion: Object.freeze({ maxEntries: 2, maxConsumableEntries: 0 }),
  standard: Object.freeze({ maxEntries: 8, maxConsumableEntries: 2 }),
  elite: Object.freeze({ maxEntries: 12, maxConsumableEntries: 3 }),
  boss: Object.freeze({ maxEntries: 20, maxConsumableEntries: 5 }),
}) satisfies Readonly<Record<NpcRole, { maxEntries: number; maxConsumableEntries: number }>>;

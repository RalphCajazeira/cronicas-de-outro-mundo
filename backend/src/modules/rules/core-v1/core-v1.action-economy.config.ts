import type {
  ReactionDefinition, ReactionKind, RepresentativeTemporalProfileName, TemporalProfile,
  TemporalProfileName, TerrainType,
} from './core-v1.action-economy.types.js';

export const CORE_V1_ACTION_ECONOMY_REVISION = 'RC1.1' as const;
export const CORE_V1_REFERENCE_ACTION_TICKS = 1000n;
export const CORE_V1_MAX_COMBAT_TICK = 1_000_000_000n;
export const CORE_V1_MAX_TECHNICAL_TICK = 9_000_000_000_000_000n;
export const CORE_V1_MAX_EVENT_QUEUE_SIZE = 256;
export const CORE_V1_MAX_PLAN_ACTIONS = 5;
export const CORE_V1_MAX_PROCESSING_EVENTS = 32;
export const CORE_V1_MAX_PROCESSING_ADVANCE = 5000n;
export const CORE_V1_MAX_COMBO_STEPS = 5;
export const CORE_V1_MAX_COMBO_EVENTS = 8;
export const CORE_V1_MIN_IMPACT_INTERVAL = 50n;
export const CORE_V1_ENCOUNTER_WINDOW_TICKS = 10000n;
export const CORE_V1_TEMPORAL_XP_WINDOW_TICKS = 1000n;

export const CORE_V1_TEMPORAL_PROFILES = Object.freeze({
  quick: Object.freeze({ preparation: 350n, recovery: 250n, cycle: 600n }),
  normal: Object.freeze({ preparation: 550n, recovery: 450n, cycle: 1000n }),
  heavy: Object.freeze({ preparation: 800n, recovery: 700n, cycle: 1500n }),
  very_heavy: Object.freeze({ preparation: 1100n, recovery: 900n, cycle: 2000n }),
}) satisfies Readonly<Record<TemporalProfileName, TemporalProfile>>;

export const CORE_V1_REPRESENTATIVE_TEMPORAL_PROFILES = Object.freeze({
  dagger: Object.freeze({ preparation: 350n, recovery: 250n, cycle: 600n }),
  short_sword: Object.freeze({ preparation: 450n, recovery: 350n, cycle: 800n }),
  long_sword: Object.freeze({ preparation: 550n, recovery: 450n, cycle: 1000n }),
  heavy_axe: Object.freeze({ preparation: 850n, recovery: 750n, cycle: 1600n }),
  bow: Object.freeze({ preparation: 650n, recovery: 450n, cycle: 1100n }),
  crossbow: Object.freeze({ preparation: 500n, recovery: 1400n, cycle: 1900n }),
  unarmed: Object.freeze({ preparation: 400n, recovery: 300n, cycle: 700n }),
  potion: Object.freeze({ preparation: 500n, recovery: 500n, cycle: 1000n }),
  equipment_swap: Object.freeze({ preparation: 700n, recovery: 300n, cycle: 1000n }),
  whirlwind: Object.freeze({ preparation: 700n, recovery: 700n, cycle: 1400n }),
  fireball: Object.freeze({ preparation: 700n, recovery: 500n, cycle: 1200n }),
  long_spell: Object.freeze({ preparation: 1400n, recovery: 700n, cycle: 2100n }),
}) satisfies Readonly<Record<RepresentativeTemporalProfileName, TemporalProfile>>;

export const CORE_V1_TERRAIN_MULTIPLIER_BPS = Object.freeze({
  normal: 10000,
  difficult: 15000,
  severe: 20000,
}) satisfies Readonly<Record<TerrainType, number>>;

export const CORE_V1_REACTION_DEFINITIONS = Object.freeze({
  block: Object.freeze({ time: 100n, nextActionPenalty: 150n, cooldown: 1000n }),
  active_dodge: Object.freeze({ time: 150n, nextActionPenalty: 250n, cooldown: 1200n }),
  interrupt: Object.freeze({ time: 150n, nextActionPenalty: 200n, cooldown: 1500n }),
  counter_attack: Object.freeze({ time: 300n, nextActionPenalty: 400n, cooldown: 1600n }),
}) satisfies Readonly<Record<ReactionKind, ReactionDefinition>>;

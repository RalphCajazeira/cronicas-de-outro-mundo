export * from './core-v1.attributes.js';
export * from './core-v1.action-economy.js';
export * from './core-v1.action-mechanics.js';
export * from './core-v1.temporal.js';
export * from './core-v1.ticks.js';
export * from './core-v1.timeline.js';
export * from './core-v1.content.js';
export * from './core-v1.content-mechanics.js';
export * from './core-v1.inventory.js';
export * from './core-v1.equipment.js';
export * from './core-v1.effects.js';
export * from './core-v1.damage.js';
export * from './core-v1.progression.js';
export type * from './core-v1.action-economy.types.js';
export type * from './core-v1.content-mechanics.types.js';
export type * from './core-v1.inventory.types.js';
export type * from './core-v1.effects.types.js';
export type * from './core-v1.types.js';
export { CORE_V1_ACTION_ECONOMY_REVISION } from './core-v1.action-economy.config.js';
export {
  CORE_V1_ATTRIBUTE_HARD_CAP,
  CORE_V1_ATTRIBUTE_SOFT_CAP,
  CORE_V1_CREATION_ATTRIBUTE_MAX,
  CORE_V1_CREATION_ATTRIBUTE_MIN,
  CORE_V1_INITIAL_ATTRIBUTE_BUDGET,
  CORE_V1_INITIAL_LEVEL,
  CORE_V1_INITIAL_XP,
  CORE_V1_LEVEL_CAP,
  CORE_V1_MASTERY_XP,
  CORE_V1_MAX_DAMAGE_COMPONENTS,
  CORE_V1_PRIMARY_ATTRIBUTES,
  CORE_V1_RULESET_ID,
} from './core-v1.config.js';
export {
  CORE_V1_CONTENT_RULESET_CODE,
  CORE_V1_CONTENT_SCHEMA_VERSION,
  CORE_V1_MAX_STATUS_STACKS,
} from './core-v1.content-mechanics.config.js';
export {
  CORE_V1_INVENTORY_RULES_CODE,
  CORE_V1_INVENTORY_RULESET_CODE,
  CORE_V1_INVENTORY_SCHEMA_VERSION,
  CORE_V1_MAX_EQUIPPED_ENTRIES,
  CORE_V1_MAX_INVENTORY_ENTRIES_PER_OPERATION,
  CORE_V1_MAX_STACK_QUANTITY,
} from './core-v1.inventory.config.js';
export { ceilDiv, clamp, roundHalfUp } from './core-v1.math.js';

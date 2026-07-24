import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../shared/json/canonical-json.js';
import {
  CORE_V1_CREATION_ATTRIBUTE_MAX,
  CORE_V1_CREATION_ATTRIBUTE_MIN,
  CORE_V1_INITIAL_ATTRIBUTE_BUDGET,
  CORE_V1_INITIAL_LEVEL,
  CORE_V1_INITIAL_XP,
  CORE_V1_PRIMARY_ATTRIBUTES,
  CORE_V1_RULESET_ID,
} from './core-v1.config.js';
import {
  CORE_V1_2_ATTRIBUTE_POINTS_PER_ADDITIONAL_LEVEL,
  CORE_V1_2_REVISION,
  CORE_V1_2_SCHEMA_VERSION,
  CORE_V1_2_TECHNICAL_ATTRIBUTE_MAXIMUM,
  CORE_V1_2_TECHNICAL_LEVEL_MAXIMUM,
  CORE_V1_2_VERSION_CODE,
  CORE_V1_2_XP_STORAGE_MAXIMUM,
} from './core-v1.progression-v2.js';

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const CORE_V1_2_CONFIG_SNAPSHOT = deepFreeze({
  identity: {
    rulesetCode: 'core',
    versionCode: CORE_V1_2_VERSION_CODE,
    numericalRevision: CORE_V1_2_REVISION,
    actionEconomyRevision: 'RC1.1',
    schemaVersion: CORE_V1_2_SCHEMA_VERSION,
    basedOnVersionCode: CORE_V1_RULESET_ID,
  },
  attributes: {
    primary: [...CORE_V1_PRIMARY_ATTRIBUTES],
    initialBudget: CORE_V1_INITIAL_ATTRIBUTE_BUDGET,
    creationMinimum: CORE_V1_CREATION_ATTRIBUTE_MIN,
    creationMaximum: CORE_V1_CREATION_ATTRIBUTE_MAX,
    progressionPointsPerAdditionalLevel: CORE_V1_2_ATTRIBUTE_POINTS_PER_ADDITIONAL_LEVEL,
    effectiveGameplayCap: null,
  },
  progression: {
    initialLevel: CORE_V1_INITIAL_LEVEL,
    initialXp: CORE_V1_INITIAL_XP,
    gameplayLevelCap: null,
    xpCurve: '100 + 35 * (level - 1) + 5 * (level - 1)^2',
    levelUpMode: 'one_level_per_operation',
  },
  technicalEnvelope: {
    actorIntegerStorage: 'postgresql-int32',
    maximumStoredXp: CORE_V1_2_XP_STORAGE_MAXIMUM,
    maximumRepresentableLevel: CORE_V1_2_TECHNICAL_LEVEL_MAXIMUM,
    maximumRepresentablePrimaryAttribute: CORE_V1_2_TECHNICAL_ATTRIBUTE_MAXIMUM,
    gameplayLimit: false,
  },
  inheritedMechanics: {
    baseVersionCode: CORE_V1_RULESET_ID,
    baseConfigHash: '2cfe9c45585ef51f3a06f2c9dc11e5cd6a5274d3eb77f96271daf2613fc1e4df',
    resourceAndDerivedFormulas: 'unchanged',
    actionEconomy: 'RC1.1',
  },
});

export const CORE_V1_2_CONFIG_CANONICAL_JSON = canonicalJson(CORE_V1_2_CONFIG_SNAPSHOT);
export const CORE_V1_2_CONFIG_HASH = createHash('sha256')
  .update(CORE_V1_2_CONFIG_CANONICAL_JSON)
  .digest('hex');

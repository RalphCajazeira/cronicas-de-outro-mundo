import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../shared/json/canonical-json.js';
import {
  CORE_V1_2_CONFIG_HASH,
  CORE_V1_2_CONFIG_SNAPSHOT,
} from './core-v1.progression-v2.manifest.js';
import {
  CORE_V1_3_REVISION,
  CORE_V1_3_SCHEMA_VERSION,
  CORE_V1_3_VERSION_CODE,
} from './core-v1.progression-v3.js';

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const CORE_V1_3_CONFIG_SNAPSHOT = deepFreeze({
  identity: {
    rulesetCode: 'core',
    versionCode: CORE_V1_3_VERSION_CODE,
    numericalRevision: CORE_V1_3_REVISION,
    actionEconomyRevision: 'RC1.1',
    schemaVersion: CORE_V1_3_SCHEMA_VERSION,
    basedOnVersionCode: 'core-v1.2',
  },
  inheritedMechanics: {
    baseVersionCode: 'core-v1.2',
    baseConfigHash: CORE_V1_2_CONFIG_HASH,
    progression: 'RC1.2',
    resourceAndExistingDerivedFormulas: 'unchanged',
    actionEconomy: 'RC1.1',
  },
  secondaryAttributes: {
    stealth: 'floor((2 * agility + dexterity + perception + luck) / 2) plus authoritative modifiers; non-negative PostgreSQL INTEGER score',
    detection: 'floor((2 * perception + wisdom + intelligence + luck) / 2) plus authoritative modifiers; non-negative PostgreSQL INTEGER score',
  },
  stealthContest: {
    rollRangeBps: [1, 10_000],
    rollContribution: 'floor((10001 - rollBps) / 250)',
    lighting: { bright: -8, normal: 0, dim: 5, dark: 10, magical_darkness: 15 },
    cover: { none: -8, partial: 3, substantial: 8, full: 12 },
    noise: { silent: 5, low: 2, normal: 0, loud: -8 },
    pace: { stationary: 5, careful: 2, normal: 0, fast: -10 },
    margin: 'agentStealth + contextModifier + agentRollContribution - observerDetection - observerRollContribution',
    tie: 'margin 0 is success and unaware',
    highSuccessMargin: 20,
    criticalFailureMargin: -20,
    observerSpecificAwareness: true,
  },
  surpriseAttack: {
    requiresUnawareObserver: true,
    accuracyModifierBps: 1_500,
    criticalChanceModifierBps: 1_000,
    guaranteedCriticalMargin: 20,
    revealingAttack: true,
    reactionPolicy: 'normal',
  },
  compatibility: {
    inheritedConfig: CORE_V1_2_CONFIG_SNAPSHOT.identity.versionCode,
    oldPublicationsImmutable: true,
  },
});

export const CORE_V1_3_CONFIG_CANONICAL_JSON = canonicalJson(CORE_V1_3_CONFIG_SNAPSHOT);
export const CORE_V1_3_CONFIG_HASH = createHash('sha256')
  .update(CORE_V1_3_CONFIG_CANONICAL_JSON)
  .digest('hex');

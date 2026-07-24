import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../shared/json/canonical-json.js';
import { CORE_V1_CONTENT_PROFILE_SNAPSHOT } from './core-v1.content-profile.manifest.js';

export const CORE_V1_3_CONTENT_PROFILE_CODE = 'core-v1.3-content-v1' as const;

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const snapshot = structuredClone(CORE_V1_CONTENT_PROFILE_SNAPSHOT) as {
  identity: { code: string };
  catalogs: { secondaryModifiers: string[]; passiveModifierTargets: string[] };
  limits: Record<string, unknown>;
};
snapshot.identity.code = CORE_V1_3_CONTENT_PROFILE_CODE;
snapshot.catalogs.secondaryModifiers.push('stealth', 'detection');
snapshot.catalogs.passiveModifierTargets.push('stealth', 'detection');
snapshot.limits.modifierTierEnvelopes = {
  basisPoints: '1000 * tier',
  carryingCapacity: '50 * tier',
  resourceMaximum: '10 * tier',
  movementSpeed: 'tier',
  primaryAttribute: '2 * tier',
  otherScalar: '10 * tier',
};

export const CORE_V1_3_CONTENT_PROFILE_SNAPSHOT = deepFreeze(snapshot);
export const CORE_V1_3_CONTENT_PROFILE_CANONICAL_JSON = canonicalJson(CORE_V1_3_CONTENT_PROFILE_SNAPSHOT);
export const CORE_V1_3_CONTENT_PROFILE_HASH = createHash('sha256')
  .update(CORE_V1_3_CONTENT_PROFILE_CANONICAL_JSON)
  .digest('hex');

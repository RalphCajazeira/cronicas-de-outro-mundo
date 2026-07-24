import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../../shared/json/canonical-json.js';
import {
  CORE_V1_CONTENT_PROFILE_CANONICAL_JSON,
  CORE_V1_CONTENT_PROFILE_CODE,
  CORE_V1_CONTENT_PROFILE_HASH,
  CORE_V1_CONTENT_PROFILE_SCHEMA_VERSION,
  CORE_V1_CONTENT_PROFILE_SNAPSHOT,
} from './core-v1.content-profile.manifest.js';
import {
  CORE_V1_3_CONTENT_PROFILE_CANONICAL_JSON,
  CORE_V1_3_CONTENT_PROFILE_CODE,
  CORE_V1_3_CONTENT_PROFILE_HASH,
  CORE_V1_3_CONTENT_PROFILE_SNAPSHOT,
} from './core-v1.content-profile-v3.manifest.js';

describe('core-v1 content profile manifest', () => {
  it('publishes the official identity, canonical snapshot and fixed SHA-256 hash', () => {
    expect(CORE_V1_CONTENT_PROFILE_CODE).toBe('core-v1-content-v1');
    expect(CORE_V1_CONTENT_PROFILE_SCHEMA_VERSION).toBe(1);
    expect(CORE_V1_CONTENT_PROFILE_CANONICAL_JSON).toBe(canonicalJson(CORE_V1_CONTENT_PROFILE_SNAPSHOT));
    expect(CORE_V1_CONTENT_PROFILE_HASH).toBe('892ee105f786aca9c880a3930d0d53ed3f726e6a5cfca655470ec2a5204faac7');
    expect(createHash('sha256').update(CORE_V1_CONTENT_PROFILE_CANONICAL_JSON).digest('hex')).toBe(CORE_V1_CONTENT_PROFILE_HASH);
  });

  it('captures every canonical kind and relevant limits without executable functions', () => {
    expect(CORE_V1_CONTENT_PROFILE_SNAPSHOT.catalogs.contentKinds).toHaveLength(13);
    expect(CORE_V1_CONTENT_PROFILE_SNAPSHOT.catalogs.contentKinds).toContain('clothing');
    expect(CORE_V1_CONTENT_PROFILE_SNAPSHOT.catalogs.contentKinds).toContain('consumable');
    expect(CORE_V1_CONTENT_PROFILE_SNAPSHOT.limits).toMatchObject({ maximumTier: 10, maximumDamageComponents: 6, reactionDepth: 2 });
    expect(CORE_V1_CONTENT_PROFILE_CANONICAL_JSON).not.toContain('function');
  });

  it('is recursively immutable and changes hash when a copied field changes', () => {
    expect(Object.isFrozen(CORE_V1_CONTENT_PROFILE_SNAPSHOT)).toBe(true);
    expect(Object.isFrozen(CORE_V1_CONTENT_PROFILE_SNAPSHOT.catalogs.contentKinds)).toBe(true);
    const changed = structuredClone(CORE_V1_CONTENT_PROFILE_SNAPSHOT);
    changed.limits.maximumTargets += 1;
    expect(createHash('sha256').update(canonicalJson(changed)).digest('hex')).not.toBe(CORE_V1_CONTENT_PROFILE_HASH);
  });

  it('publishes RC1.3 additions separately while preserving the historical manifest', () => {
    expect(CORE_V1_3_CONTENT_PROFILE_CODE).toBe('core-v1.3-content-v1');
    expect(CORE_V1_3_CONTENT_PROFILE_SNAPSHOT.catalogs.secondaryModifiers)
      .toEqual(expect.arrayContaining(['stealth', 'detection']));
    expect(CORE_V1_3_CONTENT_PROFILE_SNAPSHOT.limits.modifierTierEnvelopes)
      .toMatchObject({ movementSpeed: 'tier', otherScalar: '10 * tier' });
    expect(CORE_V1_3_CONTENT_PROFILE_HASH).toBe(
      createHash('sha256').update(CORE_V1_3_CONTENT_PROFILE_CANONICAL_JSON).digest('hex'),
    );
    expect(Object.isFrozen(CORE_V1_3_CONTENT_PROFILE_SNAPSHOT.catalogs.secondaryModifiers)).toBe(true);
    expect(CORE_V1_CONTENT_PROFILE_HASH)
      .toBe('892ee105f786aca9c880a3930d0d53ed3f726e6a5cfca655470ec2a5204faac7');
  });
});

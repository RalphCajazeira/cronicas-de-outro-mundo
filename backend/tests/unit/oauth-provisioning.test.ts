import { describe, expect, it } from 'vitest';
import {
  parseProvisionMode,
  validateOAuthClientPolicyInput,
} from '../../scripts/upsert-oauth-client-policy.js';
import { validateSyntheticIdentityInput } from '../../scripts/provision-synthetic-identity.js';
import {
  AUTHENTICATED_FIXTURE_ISSUER,
  AUTHENTICATED_FIXTURE_PROJECT_REF,
  parseFixtureProvisionMode,
  resolveSyntheticUser,
  validateAuthenticatedFixtureProvisioningEnvironment,
} from '../../scripts/provision-authenticated-readonly-fixture.js';
import {
  AUTHENTICATED_FIXTURE_MANIFEST_PATH,
  parseAuthenticatedFixtureManifest,
  parseProvisioningManifestChange,
} from '../../scripts/staging-provisioning-manifest.js';

describe('OAuth staging provisioning guards', () => {
  it('requires one explicit dry-run or apply mode', () => {
    expect(parseProvisionMode(['--dry-run'])).toBe('dry-run');
    expect(parseProvisionMode(['--apply'])).toBe('apply');
    expect(() => parseProvisionMode([])).toThrow();
    expect(() => parseProvisionMode(['--dry-run', '--apply'])).toThrow();
  });

  it('accepts only exact bounded client IDs and the approved protected resources', () => {
    expect(() => validateOAuthClientPolicyInput(
      'synthetic-client',
      'https://cronicas-de-outro-mundo-staging-api.onrender.com/mcp-auth',
    )).not.toThrow();
    expect(() => validateOAuthClientPolicyInput(
      'extension-client',
      'https://cronicas-de-outro-mundo-staging-api.onrender.com/extension/session',
    )).not.toThrow();
    expect(() => validateOAuthClientPolicyInput(
      'synthetic-client ',
      'https://cronicas-de-outro-mundo-staging-api.onrender.com/mcp-auth',
    )).toThrow();
    expect(() => validateOAuthClientPolicyInput(
      'synthetic-client',
      'https://cronicas-de-outro-mundo-staging-api.onrender.com/mcp-auth-similar',
    )).toThrow();
    expect(() => validateOAuthClientPolicyInput(
      'x'.repeat(513),
      'https://cronicas-de-outro-mundo-staging-api.onrender.com/mcp-auth',
    )).toThrow();
  });

  it('accepts only a Supabase issuer, UUID subject, and reserved synthetic email', () => {
    expect(() => validateSyntheticIdentityInput(
      'https://project-ref.supabase.co/auth/v1',
      '7f43ce60-3dca-4ab0-8fe1-33a2ca9e43ba',
      'oauth-staging@cronicas.example.test',
    )).not.toThrow();
    expect(() => validateSyntheticIdentityInput(
      'https://evil.example/auth/v1',
      '7f43ce60-3dca-4ab0-8fe1-33a2ca9e43ba',
      'oauth-staging@cronicas.example.test',
    )).toThrow();
    expect(() => validateSyntheticIdentityInput(
      'https://project-ref.supabase.co/auth/v1',
      'not-a-uuid',
      'oauth-staging@cronicas.example.test',
    )).toThrow();
    expect(() => validateSyntheticIdentityInput(
      'https://project-ref.supabase.co/auth/v1',
      '7f43ce60-3dca-4ab0-8fe1-33a2ca9e43ba',
      'real-person@example.com',
    )).toThrow();
  });

  it('restricts the authenticated fixture to the explicit staging environment and project', () => {
    const connectionString = `postgresql://cronicas_staging_app.${AUTHENTICATED_FIXTURE_PROJECT_REF}:secret@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=verify-full`;
    expect(() => validateAuthenticatedFixtureProvisioningEnvironment({
      appEnvironment: 'staging',
      projectRef: AUTHENTICATED_FIXTURE_PROJECT_REF,
      connectionString,
      issuer: AUTHENTICATED_FIXTURE_ISSUER,
      subject: '7f43ce60-3dca-4ab0-8fe1-33a2ca9e43ba',
    })).not.toThrow();
    expect(() => validateAuthenticatedFixtureProvisioningEnvironment({
      appEnvironment: 'production',
      projectRef: AUTHENTICATED_FIXTURE_PROJECT_REF,
      connectionString,
      issuer: AUTHENTICATED_FIXTURE_ISSUER,
      subject: '7f43ce60-3dca-4ab0-8fe1-33a2ca9e43ba',
    })).toThrow();
    expect(() => validateAuthenticatedFixtureProvisioningEnvironment({
      appEnvironment: 'staging',
      projectRef: 'another-project-ref',
      connectionString,
      issuer: AUTHENTICATED_FIXTURE_ISSUER,
      subject: '7f43ce60-3dca-4ab0-8fe1-33a2ca9e43ba',
    })).toThrow();
    expect(() => validateAuthenticatedFixtureProvisioningEnvironment({
      appEnvironment: 'staging',
      projectRef: AUTHENTICATED_FIXTURE_PROJECT_REF,
      connectionString: 'postgresql://postgres:secret@example.com:5432/postgres?sslmode=verify-full',
      issuer: AUTHENTICATED_FIXTURE_ISSUER,
      subject: '7f43ce60-3dca-4ab0-8fe1-33a2ca9e43ba',
    })).toThrow();
    expect(() => validateAuthenticatedFixtureProvisioningEnvironment({
      appEnvironment: 'staging',
      projectRef: AUTHENTICATED_FIXTURE_PROJECT_REF,
      connectionString,
      issuer: 'https://another-project.supabase.co/auth/v1',
      subject: '7f43ce60-3dca-4ab0-8fe1-33a2ca9e43ba',
    })).toThrow();
    expect(() => validateAuthenticatedFixtureProvisioningEnvironment({
      appEnvironment: 'staging',
      projectRef: AUTHENTICATED_FIXTURE_PROJECT_REF,
      connectionString,
      issuer: AUTHENTICATED_FIXTURE_ISSUER,
      subject: '',
    })).toThrow();
  });

  it('accepts only the strict, secret-free versioned provisioning manifest', () => {
    const manifest = {
      operationId: 'authenticated-readonly-fixture-v1',
      executionRevision: 2,
      environment: 'staging',
      type: 'AUTHENTICATED_READONLY_FIXTURE',
      enabled: true,
      expectedRecords: {
        player: 1,
        world: 1,
        campaign: 1,
        actor: 1,
        campaignMembership: 1,
        actorControl: 1,
        actorAttribute: 9,
        actorResource: 3,
        actorDerivedSnapshot: 1,
        contentDefinition: 7,
        contentVersion: 7,
        inventoryEntry: 3,
        equipmentSlot: 1,
        actorContent: 3,
        activeEffect: 1,
      },
    };
    expect(parseAuthenticatedFixtureManifest(manifest)).toEqual(manifest);
    expect(() => parseAuthenticatedFixtureManifest({ ...manifest, subject: 'forbidden' })).toThrow();
    expect(() => parseAuthenticatedFixtureManifest({
      ...manifest,
      expectedRecords: { ...manifest.expectedRecords, actor: 2 },
    })).toThrow();
    expect(() => parseAuthenticatedFixtureManifest({ ...manifest, environment: 'production' })).toThrow();
  });

  it('detects only an added or modified exact manifest path', () => {
    expect(parseProvisioningManifestChange('')).toBe(false);
    expect(parseProvisioningManifestChange(`A\t${AUTHENTICATED_FIXTURE_MANIFEST_PATH}`)).toBe(true);
    expect(parseProvisioningManifestChange(`M\t${AUTHENTICATED_FIXTURE_MANIFEST_PATH}`)).toBe(true);
    expect(() => parseProvisioningManifestChange(
      `D\t${AUTHENTICATED_FIXTURE_MANIFEST_PATH}`,
    )).toThrow();
    expect(() => parseProvisioningManifestChange(
      `R100\told.json\t${AUTHENTICATED_FIXTURE_MANIFEST_PATH}`,
    )).toThrow();
  });

  it('requires one explicit fixture mode', () => {
    expect(parseFixtureProvisionMode(['--dry-run'])).toBe('dry-run');
    expect(parseFixtureProvisionMode(['--apply'])).toBe('apply');
    expect(parseFixtureProvisionMode(['--postflight'])).toBe('postflight');
    expect(() => parseFixtureProvisionMode([])).toThrow();
    expect(() => parseFixtureProvisionMode(['--dry-run', '--apply'])).toThrow();
  });

  it.each([
    ['duplicate subject', [
      { user: { id: 'user-1', status: 'ACTIVE', suspendedAt: null, deletedAt: null } },
      { user: { id: 'user-2', status: 'ACTIVE', suspendedAt: null, deletedAt: null } },
    ]],
    ['suspended user', [
      { user: { id: 'user-1', status: 'SUSPENDED', suspendedAt: new Date(), deletedAt: null } },
    ]],
    ['deleted user', [
      { user: { id: 'user-1', status: 'DELETED', suspendedAt: null, deletedAt: new Date() } },
    ]],
  ])('rejects a %s before resolving fixture data', async (_name, identities) => {
    const transaction = {
      externalIdentity: {
        findMany: () => Promise.resolve(identities),
        count: () => Promise.resolve(1),
      },
      user: { count: () => Promise.resolve(1) },
    };
    await expect(resolveSyntheticUser(
      transaction as never,
      AUTHENTICATED_FIXTURE_ISSUER,
      '7f43ce60-3dca-4ab0-8fe1-33a2ca9e43ba',
    )).rejects.toThrow();
  });
});

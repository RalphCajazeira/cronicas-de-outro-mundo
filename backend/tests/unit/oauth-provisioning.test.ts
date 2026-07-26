import { describe, expect, it } from 'vitest';
import {
  parseProvisionMode,
  validateOAuthClientPolicyInput,
} from '../../scripts/upsert-oauth-client-policy.js';
import { validateSyntheticIdentityInput } from '../../scripts/provision-synthetic-identity.js';

describe('OAuth staging provisioning guards', () => {
  it('requires one explicit dry-run or apply mode', () => {
    expect(parseProvisionMode(['--dry-run'])).toBe('dry-run');
    expect(parseProvisionMode(['--apply'])).toBe('apply');
    expect(() => parseProvisionMode([])).toThrow();
    expect(() => parseProvisionMode(['--dry-run', '--apply'])).toThrow();
  });

  it('accepts only exact bounded client IDs and the canonical protected resource', () => {
    expect(() => validateOAuthClientPolicyInput(
      'synthetic-client',
      'https://cronicas-de-outro-mundo-staging-api.onrender.com/mcp-auth',
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
});

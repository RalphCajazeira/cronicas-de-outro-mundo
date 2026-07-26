import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classifyMigrationSql } from '../../scripts/classify-migrations.js';

const migrationPath = fileURLToPath(new URL(
  '../../prisma/migrations/20260726150000_oauth_client_resource_policy/migration.sql',
  import.meta.url,
));
const migration = readFileSync(migrationPath, 'utf8');

describe('Phase 2C-B OAuth resource audience migration', () => {
  it('is additive and classified high for the expected security-sensitive reasons', () => {
    expect(migration).not.toMatch(/^\s*(?:DELETE\s+FROM|DROP\s+|TRUNCATE\s+|UPDATE\s+\S+\s+SET|INSERT\s+INTO)\b/imu);
    const classification = classifyMigrationSql(migration);
    expect(classification.risk).toBe('high');
    expect(classification.reasons).toEqual(expect.arrayContaining([
      'privilege_change',
      'procedural_sql',
      'row_level_security',
    ]));
  });

  it('creates a generic client policy without credential or user data', () => {
    expect(migration).toContain('CREATE TABLE "OAuthClientResourcePolicy"');
    expect(migration).toContain('"clientId" VARCHAR(512) NOT NULL');
    expect(migration).toContain('"audience" VARCHAR(2048) NOT NULL');
    expect(migration).toContain('"enabled" BOOLEAN NOT NULL DEFAULT true');
    expect(migration).toContain('CREATE UNIQUE INDEX "OAuthClientResourcePolicy_clientId_key"');
    const tableDefinition = migration.slice(
      migration.indexOf('CREATE TABLE "OAuthClientResourcePolicy"'),
      migration.indexOf('CREATE UNIQUE INDEX'),
    );
    expect(tableDefinition).not.toMatch(/access.?token|refresh.?token|client.?secret|password|campaign|player|actor/iu);
  });

  it('hardens the table and exposes read access only to the Auth hook role', () => {
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('REVOKE ALL PRIVILEGES ON TABLE public."OAuthClientResourcePolicy" FROM PUBLIC');
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect(migration).toContain(`FROM ${role}`);
    }
    expect(migration).not.toMatch(/\bGRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)\b/iu);
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) TO supabase_auth_admin');
    expect(migration).not.toMatch(/\bCREATE\s+POLICY\b/iu);
    expect(migration).not.toMatch(/TO\s+(?:anon|authenticated|service_role|PUBLIC)\s+USING\s+\(true\)/iu);
  });

  it('creates a bounded definer hook with fixed search_path and no dynamic SQL', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)');
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('SET search_path = pg_catalog, public');
    expect(migration).not.toMatch(/\bEXECUTE\s+(?:format|\()/iu);
    expect(migration).toContain('octet_length(oauth_client_id) NOT BETWEEN 1 AND 512');
  });

  it('preserves ordinary audiences and fails closed for unknown or disabled OAuth clients', () => {
    expect(migration).toContain('IF oauth_client_id IS NULL THEN');
    expect(migration).toContain("RETURN jsonb_build_object('claims', claims)");
    expect(migration).toContain('policy."clientId" = oauth_client_id');
    expect(migration).toContain('policy."enabled" = true');
    expect(migration).toContain("claims := jsonb_set(claims, '{aud}', to_jsonb(resource_audience), true)");
    expect(migration).toContain("'http_code', 403");
  });
});

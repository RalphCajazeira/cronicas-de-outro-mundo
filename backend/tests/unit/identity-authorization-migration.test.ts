import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migrationPath = fileURLToPath(new URL(
  '../../prisma/migrations/20260725190000_identity_authorization_foundation/migration.sql',
  import.meta.url,
));
const migration = readFileSync(migrationPath, 'utf8');

describe('Phase 2B identity and authorization migration', () => {
  it('is additive, does not infer links, and hardens the new tables', () => {
    expect(migration).not.toMatch(/^\s*(?:DELETE\s+FROM|DROP\s+|TRUNCATE\s+|UPDATE\s+\S+\s+SET|INSERT\s+INTO)\b/imu);
    expect(migration).toContain('ALTER TABLE "Player" ADD COLUMN "userId" UUID;');
    expect(migration).not.toContain('ALTER TABLE "Player" ADD COLUMN "userId" UUID NOT NULL');
    for (const tableName of [
      'User',
      'ExternalIdentity',
      'CampaignMembership',
      'ActorControl',
      'AuditEvent',
    ]) {
      expect(migration).toContain(`'${tableName}'`);
    }
    expect(migration).toContain('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC');
    expect(migration).toContain('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM anon');
    expect(migration).toContain('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM authenticated');
    expect(migration).toContain('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM service_role');
    expect(migration).not.toMatch(/\b(?:DISABLE|FORCE)\s+ROW\s+LEVEL\s+SECURITY\b/iu);
    expect(migration).not.toMatch(/\bCREATE\s+POLICY\b/iu);
  });

  it('creates the required identity and authorization uniqueness constraints', () => {
    expect(migration).toContain('CREATE UNIQUE INDEX "ExternalIdentity_issuer_subject_key"');
    expect(migration).toContain('CREATE UNIQUE INDEX "Player_userId_key"');
    expect(migration).toContain('CREATE UNIQUE INDEX "CampaignMembership_campaignId_userId_key"');
    expect(migration).toContain('CREATE UNIQUE INDEX "ActorControl_actorId_userId_key"');
    expect(migration).toContain('CONSTRAINT "User_status_timestamps_check"');
    expect(migration).toContain('CONSTRAINT "CampaignMembership_status_revokedAt_check"');
    expect(migration).toContain('CONSTRAINT "AuditEvent_metadata_check"');
  });

  it('contains no credential storage columns', () => {
    expect(migration).not.toMatch(/"(?:accessToken|refreshToken|authorizationCode|clientSecret|password|cookie|headers)"/iu);
    expect(migration).toContain('"email" VARCHAR(320)');
    expect(migration).toContain('"metadata" JSONB NOT NULL DEFAULT');
  });
});

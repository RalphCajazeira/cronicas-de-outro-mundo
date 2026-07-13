import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migrationPath = fileURLToPath(new URL(
  '../../prisma/migrations/20260713174337_engine_v1_ruleset_persistence/migration.sql',
  import.meta.url,
));
const sql = readFileSync(migrationPath, 'utf8');

describe('Phase 1C ruleset persistence migration', () => {
  it('guards clean slate before DDL without deleting functional data', () => {
    const guard = sql.indexOf('DO $clean_slate$');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(sql.indexOf('CREATE TABLE "Ruleset"'));
    expect(sql).toContain('EXISTS (SELECT 1 FROM "World" LIMIT 1)');
    expect(sql).toContain('EXISTS (SELECT 1 FROM "Campaign" LIMIT 1)');
    expect(sql).toContain('Phase 1C migration requires empty World and Campaign tables; clear functional data before rollout');
    expect(sql).not.toMatch(/^\s*(DELETE|TRUNCATE|DROP)\b/gim);
  });

  it('creates required relations and validates published version metadata', () => {
    expect(sql).toContain('CREATE TABLE "Ruleset"');
    expect(sql).toContain('CREATE TABLE "RulesetVersion"');
    expect(sql).toContain('"defaultRulesetVersionId" UUID NOT NULL');
    expect(sql).toContain('"rulesetVersionId" UUID NOT NULL');
    expect(sql).toContain('CONSTRAINT "RulesetVersion_schemaVersion_check"');
    expect(sql).toContain('CONSTRAINT "RulesetVersion_configHash_check"');
    expect(sql).toContain('ON DELETE RESTRICT');
  });

  it('blocks RulesetVersion mutations and only real Campaign binding changes', () => {
    expect(sql).toContain('CREATE FUNCTION "ruleset_version_block_update"()');
    expect(sql).toContain('CREATE FUNCTION "ruleset_version_block_delete"()');
    expect(sql).toContain('CREATE TRIGGER "RulesetVersion_reject_update"');
    expect(sql).toContain('CREATE TRIGGER "RulesetVersion_reject_delete"');
    expect(sql).toContain('CREATE FUNCTION "campaign_guard_ruleset_version_change"()');
    expect(sql).toContain('NEW."rulesetVersionId" IS DISTINCT FROM OLD."rulesetVersionId"');
    expect(sql).toContain('CREATE TRIGGER "Campaign_reject_ruleset_version_change"');
  });

  it('documents structural rollback and applies the existing RLS posture', () => {
    expect(sql).toContain("ARRAY['Ruleset', 'RulesetVersion']");
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('Structural rollback plan');
    expect(sql).toContain('new reviewed corrective migration');
  });
});

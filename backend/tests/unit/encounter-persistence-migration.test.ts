import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL(
  '../../prisma/migrations/20260714120000_add_encounter_persistence/migration.sql',
  import.meta.url,
), 'utf8');

describe('Phase 1L-A encounter persistence migration', () => {
  it('is incremental and additive without a clean-slate guard or data rewrite', () => {
    expect(sql).not.toMatch(/DO \$clean_slate\$|\bDELETE\s+FROM\b|\bTRUNCATE\b|\bDROP\s+(TABLE|COLUMN|TYPE)\b/i);
    expect(sql.indexOf('CREATE TABLE "Encounter"')).toBeGreaterThanOrEqual(0);
    expect(sql).toContain('does not access external databases');
  });

  it('creates the four models and closed catalogs derived from core-v1', () => {
    for (const table of ['Encounter', 'EncounterParticipant', 'EncounterOperation', 'EncounterRoll']) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
    }
    for (const enumName of [
      'EncounterLifecycleStatus', 'EncounterStopReason', 'EncounterCompletionCandidate',
      'EncounterParticipantBindingKind', 'EncounterEphemeralKind', 'EncounterOperationKind',
      'EncounterRollKind',
    ]) expect(sql).toContain(`CREATE TYPE "${enumName}" AS ENUM`);
    expect(sql).toContain("'TIE_BREAK', 'HIT', 'CRITICAL', 'CONCENTRATION'");
    expect(sql).toContain("'BLOCK', 'ACTIVE_DODGE', 'INTERRUPT', 'COUNTER_ATTACK'");
  });

  it('enforces open encounter, participant binding, operation sequence and roll audit rules', () => {
    for (const value of [
      'Encounter_one_open_per_campaign_key', 'EncounterParticipant_binding_check',
      'EncounterParticipant_encounterId_actorId_key', 'EncounterOperation_stateVersionSequence_check',
      'EncounterOperation_idempotencyRecordId_key', 'EncounterRoll_encounterId_rollRef_key',
      'Encounter_stateSnapshot_check', 'Encounter_stateHash_check',
    ]) expect(sql).toContain(value);
    expect(sql).toContain('-- Application limits canonical UTF-8 JSON to 1 MiB; JSONB text may render larger.');
    expect(sql).toContain('-- Keep a 2 MiB physical guard for JSONB formatting overhead.');
    expect(sql).toContain('octet_length("stateSnapshot"::text) <= 2097152');
    expect(sql).not.toContain('octet_length("stateSnapshot"::text) <= 1048576');
    expect(sql).toContain('ON DELETE RESTRICT');
    expect(sql).not.toMatch(/ON DELETE CASCADE/);
  });

  it('makes mappings and audit rows immutable and applies the existing RLS posture', () => {
    for (const trigger of [
      'EncounterParticipant_reject_update', 'EncounterParticipant_reject_delete',
      'EncounterOperation_reject_update', 'EncounterOperation_reject_delete',
      'EncounterRoll_reject_update', 'EncounterRoll_reject_delete',
    ]) expect(sql).toContain(trigger);
    expect(sql).toContain("ARRAY['Encounter', 'EncounterParticipant', 'EncounterOperation', 'EncounterRoll']");
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).not.toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).not.toMatch(/CREATE\s+POLICY/i);
    expect(sql).toContain("rolname = 'anon'");
    expect(sql).toContain("rolname = 'authenticated'");
  });

  it('keeps Encounter campaign and ruleset identity immutable without blocking its normal updates', () => {
    expect(sql).toContain('CREATE FUNCTION "encounter_reject_scope_change"()');
    expect(sql).toContain('NEW."campaignId" IS DISTINCT FROM OLD."campaignId"');
    expect(sql).toContain('NEW."rulesetVersionId" IS DISTINCT FROM OLD."rulesetVersionId"');
    expect(sql).toContain("MESSAGE = 'Encounter campaign and ruleset identity is immutable'");
    expect(sql).toContain('CREATE TRIGGER "Encounter_reject_scope_change" BEFORE UPDATE OF "campaignId", "rulesetVersionId" ON "Encounter"');
    expect(sql).toContain('CREATE TRIGGER "Encounter_validate_ruleset" BEFORE INSERT ON "Encounter"');
    expect(sql).not.toMatch(/CREATE TRIGGER "Encounter_[^"]+" BEFORE UPDATE ON "Encounter"/);
  });

  it('binds persisted participants to their Actor code and protects referenced Actor identity', () => {
    expect(sql).toContain('actor."code" = NEW."actorRef"');
    expect(sql).toContain("MESSAGE = 'EncounterParticipant Actor must match its Encounter Campaign and actorRef'");
    expect(sql).toContain('CREATE FUNCTION "actor_reject_encounter_binding_change"()');
    expect(sql).toContain('NEW."code" IS DISTINCT FROM OLD."code"');
    expect(sql).toContain('NEW."campaignId" IS DISTINCT FROM OLD."campaignId"');
    expect(sql).toContain('participant."bindingKind" = \'PERSISTED_ACTOR\'');
    expect(sql).toContain('participant."actorId" = OLD."id"');
    expect(sql).toContain("MESSAGE = 'Actor code and Campaign are immutable while referenced by an EncounterParticipant'");
    expect(sql).toContain('CREATE TRIGGER "Actor_reject_encounter_binding_change" BEFORE UPDATE OF "code", "campaignId" ON "Actor"');
    expect(sql).not.toContain('CREATE TRIGGER "Actor_reject_encounter_binding_change" BEFORE UPDATE ON "Actor"');
  });
});

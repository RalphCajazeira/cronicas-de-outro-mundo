import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL(
  '../../prisma/migrations/20260720160000_add_encounter_consequences/migration.sql',
  import.meta.url,
), 'utf8');
const gptInstructions = readFileSync(new URL('../../../gpt/instructions.md', import.meta.url), 'utf8');

describe('Phase 1M-A Encounter consequence migration', () => {
  it('is additive, preserves legacy data and never resets or backfills it', () => {
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b|\bTRUNCATE\b|\bDROP\s+(TABLE|COLUMN|TYPE)\b|migrate reset|db push/i);
    expect(sql).toContain('Existing encounter effects and terminal encounters remain valid without backfill');
    expect(sql).toContain('ALTER TABLE "ActiveEffect" ADD COLUMN "originEncounterId" UUID');
    expect(sql).not.toMatch(/UPDATE\s+"ActiveEffect"/i);
  });

  it('adds exact effect ownership without invalidating legacy ENCOUNTER rows', () => {
    expect(sql).toContain('ActiveEffect_originEncounterId_fkey');
    expect(sql).toContain('ON DELETE RESTRICT');
    expect(sql).toContain('ActiveEffect_originEncounterId_targetActorId_idx');
    expect(sql).toContain('Only ENCOUNTER effects may reference an origin Encounter');
    expect(sql).toContain('New ENCOUNTER effects require an origin Encounter');
    expect(sql).toContain('A pre-migration ENCOUNTER effect may remain unowned, but may never be adopted');
    expect(sql).toContain('ActiveEffect Encounter ownership is immutable');
    expect(sql).toContain('ActiveEffect Encounter ownership identity is immutable');
    expect(sql).toContain('OLD."effectRef" IS DISTINCT FROM NEW."effectRef"');
  });

  it('creates a one-to-one append-only ledger with a bounded JSON object', () => {
    expect(sql).toContain('CREATE TABLE "EncounterConsequence"');
    for (const unique of [
      'EncounterConsequence_encounterId_key',
      'EncounterConsequence_encounterOperationId_key',
      'EncounterConsequence_gameEventId_key',
    ]) expect(sql).toContain(unique);
    expect(sql).toContain('"consequenceSchemaVersion" = 1');
    expect(sql).toContain('"rewardPolicyVersion" IS NULL');
    expect(sql).toContain('octet_length("resultSummary"::text) <= 2097152');
    expect(sql).toContain('"resultSummary" - ARRAY');
    expect(sql).toContain('EncounterConsequence_reject_update');
    expect(sql).toContain('EncounterConsequence_reject_delete');
  });

  it('defers terminal integrity until commit and keeps legacy terminals untouched', () => {
    expect(sql).toContain('CREATE CONSTRAINT TRIGGER "Encounter_terminal_requires_consequence"');
    expect(sql).toContain('CREATE CONSTRAINT TRIGGER "Encounter_insert_terminal_requires_consequence"');
    expect(sql).toContain('CREATE TRIGGER "Encounter_terminal_reject_authority_update"');
    expect(sql).toContain('Terminal Encounter authority is immutable');
    expect(sql).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(sql).toContain('OLD."lifecycleStatus" IN');
    expect(sql).toContain('NEW."lifecycleStatus" IN (\'COMPLETED\', \'CANCELLED\')');
    expect(sql).toContain('Terminal Encounter requires an EncounterConsequence in the same transaction');
    expect(sql).toContain('operation."resultSummary" AS operation_summary');
    expect(sql).toContain('operation_state_version <> row_data.encounter_state_version');
    expect(sql).toContain('operation_state_hash <> row_data.encounter_state_hash');
    expect(sql).toContain('OLD."lifecycleStatus" IS DISTINCT FROM NEW."lifecycleStatus"');
    expect(sql).toContain("WHEN 'CANCELLED' THEN 'CANCELLED'::\"EncounterOutcome\"");
  });

  it('applies the private RLS and conditional revoke posture', () => {
    expect(sql).toContain('ALTER TABLE "EncounterConsequence" ENABLE ROW LEVEL SECURITY');
    expect(sql).not.toMatch(/CREATE\s+POLICY/i);
    expect(sql).toContain("rolname = 'anon'");
    expect(sql).toContain("rolname = 'authenticated'");
  });

  it('keeps the versioned GPT Instructions within the editor limit', () => {
    expect(gptInstructions.length).toBeLessThanOrEqual(7_800);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL(
  '../../prisma/migrations/20260715120000_fix_encounter_operation_versions/migration.sql',
  import.meta.url,
), 'utf8');

describe('Phase 1L-B EncounterOperation version migration', () => {
  it('accepts CREATE 0 to 1 and non-CREATE batches with a version jump', () => {
    expect(sql).toContain('"operation" = \'CREATE\' AND "previousStateVersion" = 0');
    expect(sql).toContain('"operation" = \'CREATE\' AND "nextStateVersion" = 1');
    expect(sql).toContain('"operation" <> \'CREATE\' AND "nextStateVersion" > "previousStateVersion"');
    expect(sql).not.toContain('"nextStateVersion" = "previousStateVersion" + 1');
  });

  it('preflights incompatible rows before changing only the two checks', () => {
    expect(sql.indexOf('DO $preflight$')).toBeLessThan(sql.indexOf('DROP CONSTRAINT'));
    expect(sql).toContain('manual data migration is required');
    expect(sql.match(/DROP CONSTRAINT/g)).toHaveLength(2);
    expect(sql).not.toMatch(/CREATE TABLE|ADD COLUMN|DROP TABLE|DELETE FROM|TRUNCATE/i);
  });
});

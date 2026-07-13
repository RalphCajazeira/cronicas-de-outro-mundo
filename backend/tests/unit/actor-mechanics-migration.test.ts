import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migrationPath = fileURLToPath(new URL(
  '../../prisma/migrations/20260713190000_engine_v1_actor_mechanics/migration.sql',
  import.meta.url,
));
const sql = readFileSync(migrationPath, 'utf8');

describe('Phase 1D actor mechanics migration', () => {
  it('guards Actor clean slate before incompatible DDL without deleting data', () => {
    const guard = sql.indexOf('DO $clean_slate$');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(sql.indexOf('CREATE TYPE "ActorAttributeCode"'));
    expect(sql).toContain('EXISTS (SELECT 1 FROM "Actor" LIMIT 1)');
    expect(sql).toContain('Phase 1D migration requires an empty Actor table; clear functional data before rollout');
    expect(sql).not.toMatch(/^\s*(DELETE|TRUNCATE)\b/gim);
  });

  it('replaces legacy Actor mechanics with authoritative normalized state', () => {
    for (const column of ['health', 'maxHealth', 'mana', 'maxMana', 'attributes', 'resistances', 'affinities']) {
      expect(sql).toContain(`DROP COLUMN "${column}"`);
    }
    expect(sql).toContain('CREATE TABLE "ActorAttribute"');
    expect(sql).toContain('CREATE TABLE "ActorResource"');
    expect(sql).toContain('CREATE TABLE "ActorDerivedSnapshot"');
    expect(sql).toContain('ADD COLUMN "mechanicsStateVersion" INTEGER NOT NULL DEFAULT 1');
  });

  it('enforces codes, caps, versions, hashes, uniqueness and cascade ownership', () => {
    expect(sql).toContain("'strength', 'vitality', 'agility', 'dexterity', 'intelligence'");
    expect(sql).toContain("CREATE TYPE \"ActorResourceType\" AS ENUM ('hp', 'mana', 'sp')");
    for (const constraint of [
      'ActorAttribute_effective_cap_check', 'ActorAttribute_actorId_code_key',
      'ActorResource_current_check', 'ActorResource_stateVersion_check', 'ActorResource_actorId_type_key',
      'ActorDerivedSnapshot_actorId_key', 'ActorDerivedSnapshot_inputHash_check',
    ]) expect(sql).toContain(constraint);
    expect(sql.match(/ON DELETE CASCADE/g)?.length).toBeGreaterThanOrEqual(3);
    expect(sql).toContain('REFERENCES "RulesetVersion"("id") ON DELETE RESTRICT');
  });

  it('applies RLS consistently and documents corrective rollback', () => {
    expect(sql).toContain("ARRAY['ActorAttribute', 'ActorResource', 'ActorDerivedSnapshot']");
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('Structural rollback');
    expect(sql).toContain('new reviewed corrective migration');
  });
});

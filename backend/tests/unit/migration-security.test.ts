import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migrationPath = fileURLToPath(new URL('../../prisma/migrations/20260711223000_production_gpt_security/migration.sql', import.meta.url));
const sql = readFileSync(migrationPath, 'utf8');

describe('incremental production security migration', () => {
  it('creates a database-backed idempotency registry with a unique key', () => {
    expect(sql).toContain('CREATE TABLE "IdempotencyRecord"');
    expect(sql).toContain('CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")');
    expect(sql).toContain('CREATE UNIQUE INDEX "IdempotencyRecord_key_key"');
    expect(sql).toMatch(/"createdAt" TIMESTAMP\(3\) NOT NULL DEFAULT CURRENT_TIMESTAMP/);
    expect(sql).toMatch(/"updatedAt" TIMESTAMP\(3\) NOT NULL/);
  });

  it('enables RLS only on Node platform tables', () => {
    expect(sql).toContain("'Player', 'World', 'Campaign', 'Actor', 'ContentDefinition'");
    expect(sql).toContain("'ActorContent', 'GameEvent', 'IdempotencyRecord'");
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).not.toMatch(/legacy|rpg_/i);
    expect(sql).not.toMatch(/FORCE ROW LEVEL SECURITY|\bGRANT\b|\bDROP\b|\bDELETE\b|\bTRUNCATE\b/i);
  });

  it.each(['anon', 'authenticated'])('checks that role %s exists before revoking grants', (role) => {
    expect(sql).toContain(`rolname = '${role}'`);
    expect(sql).toContain(`FROM ${role}`);
  });
});

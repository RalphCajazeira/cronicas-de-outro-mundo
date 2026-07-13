import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL(
  '../../prisma/migrations/20260713230000_engine_v1_content_versioning/migration.sql',
  import.meta.url,
), 'utf8');

describe('Phase 1F content versioning migration', () => {
  it('guards clean slate before incompatible DDL without deleting functional data', () => {
    const guard = sql.indexOf('Phase 1F migration requires empty ContentDefinition and ActorContent tables');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(sql.indexOf('ALTER TYPE "ContentType"'));
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b|\bTRUNCATE\b/i);
  });

  it('creates immutable profile/content versions and reduces the definition to identity and lifecycle', () => {
    expect(sql).toContain("ALTER TYPE \"ContentType\" ADD VALUE 'CLOTHING'");
    expect(sql).toContain("ALTER TYPE \"ContentType\" ADD VALUE 'CONSUMABLE'");
    expect(sql).toContain('CREATE TABLE "ContentProfileVersion"');
    expect(sql).toContain('CREATE TABLE "ContentVersion"');
    for (const column of ['name', 'description', 'mechanics', 'requirements', 'presentation', 'tags', 'schemaVersion', 'metadata']) {
      expect(sql).toContain(`DROP COLUMN "${column}"`);
    }
    expect(sql).toContain('ContentProfileVersion_reject_update');
    expect(sql).toContain('ContentProfileVersion_reject_delete');
    expect(sql).toContain('ContentVersion_reject_update');
    expect(sql).toContain('ContentVersion_reject_delete');
    expect(sql).toContain('ContentDefinition_reject_identity_change');
  });

  it('enforces sequential/hash uniqueness and definition-version ownership for ActorContent', () => {
    expect(sql).toContain('ContentVersion_contentDefinitionId_versionNumber_key');
    expect(sql).toContain('ContentVersion_contentDefinitionId_contentHash_key');
    expect(sql).toContain('ContentVersion_id_contentDefinitionId_key');
    expect(sql).toContain('ActorContent_contentVersionId_contentDefinitionId_fkey');
    expect(sql).toContain('REFERENCES "ContentVersion"("id", "contentDefinitionId") ON DELETE RESTRICT');
  });

  it('uses hash/JSON checks, restricted relations, RLS and a corrective rollback plan', () => {
    expect(sql).toMatch(/configHash.*\^\[0-9a-f\]\{64\}\$/s);
    expect(sql).toMatch(/contentHash.*\^\[0-9a-f\]\{64\}\$/s);
    expect(sql).toContain("jsonb_typeof(\"profile\") = 'object'");
    expect(sql).toContain("ARRAY['ContentProfileVersion', 'ContentVersion']");
    expect(sql).toContain('new reviewed corrective migration');
  });
});

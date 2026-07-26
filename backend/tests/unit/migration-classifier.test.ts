import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_TREE_SHA,
  classifyMigrationSql,
  parseChangedMigrationEntries,
  resolveRequestedBase,
  resolveRepositoryPath,
  stripSqlCommentsAndStrings,
} from '../../scripts/classify-migrations.js';

describe('staging migration classifier', () => {
  it.each([
    ['create table', 'CREATE TABLE "Example" ("id" UUID NOT NULL);'],
    ['create type', 'CREATE TYPE "Mood" AS ENUM (\'CALM\', \'BOLD\');'],
    ['nullable column', 'ALTER TABLE "Actor" ADD COLUMN "nickname" TEXT;'],
    ['foreign key', 'ALTER TABLE "Actor" ADD CONSTRAINT "Actor_world_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE RESTRICT;'],
    ['check constraint', 'ALTER TABLE "Actor" ADD CONSTRAINT "Actor_level_check" CHECK ("level" >= 0);'],
    ['index', 'CREATE INDEX "Actor_world_idx" ON "Actor"("worldId");'],
    ['casing and whitespace', 'cReAtE\n  TaBlE "CaseTest" (\n"id" UUID\n);'],
    ['multiple safe statements', 'CREATE TABLE "One" ("id" UUID); CREATE INDEX "One_id_idx" ON "One"("id");'],
    ['transaction wrapper', 'BEGIN; CREATE TABLE "One" ("id" UUID); COMMIT;'],
  ])('classifies %s as low risk', (_name, sql) => {
    expect(classifyMigrationSql(sql)).toEqual({ risk: 'low', reasons: [] });
  });

  it.each([
    ['drop table', 'DROP TABLE "Actor";', 'destructive_drop'],
    ['drop column', 'ALTER TABLE "Actor" DROP COLUMN "name";', 'destructive_drop'],
    ['set not null', 'ALTER TABLE "Actor" ALTER COLUMN "name" SET NOT NULL;', 'set_not_null'],
    ['alter column type', 'ALTER TABLE "Actor" ALTER COLUMN "level" TYPE BIGINT;', 'column_type_change'],
    ['alter enum', 'ALTER TYPE "Mood" ADD VALUE \'ANGRY\';', 'enum_or_type_change'],
    ['update', 'UPDATE "Actor" SET "level" = 2;', 'data_change'],
    ['insert backfill', 'INSERT INTO "Actor" ("id") VALUES (\'1\');', 'data_change'],
    ['delete', 'DELETE FROM "Actor";', 'data_change'],
    ['truncate', 'TRUNCATE TABLE "Actor";', 'data_change'],
    ['RLS', 'ALTER TABLE "Actor" ENABLE ROW LEVEL SECURITY;', 'row_level_security'],
    ['grant', 'GRANT SELECT ON "Actor" TO authenticated;', 'privilege_change'],
    ['revoke', 'REVOKE ALL ON "Actor" FROM PUBLIC;', 'privilege_change'],
    ['policy', 'CREATE POLICY "actor_read" ON "Actor" FOR SELECT USING (true);', 'policy_change'],
    ['owner', 'ALTER TABLE "Actor" OWNER TO postgres;', 'ownership_change'],
    ['DO block', 'DO $$ BEGIN RAISE NOTICE \'safe-looking\'; END $$;', 'procedural_sql'],
    ['dynamic SQL', 'DO $$ BEGIN EXECUTE \'CREATE TABLE x(id int)\'; END $$;', 'procedural_sql'],
    ['unique index', 'CREATE UNIQUE INDEX "Actor_code_key" ON "Actor"("code");', 'unique_index'],
    ['mixed SQL', 'CREATE TABLE "Safe" ("id" UUID); DROP TABLE "Other";', 'destructive_drop'],
    ['unknown command', 'VACUUM "Actor";', 'administrative_command'],
    ['add column with default', 'ALTER TABLE "Actor" ADD COLUMN "active" BOOLEAN DEFAULT true;', 'nontrivial_column_addition'],
    ['empty migration', '-- comments only', 'no_executable_statement'],
  ])('classifies %s as high risk', (_name, sql, reason) => {
    const result = classifyMigrationSql(sql);
    expect(result.risk).toBe('high');
    expect(result.reasons).toContain(reason);
  });

  it('does not treat comments, quoted identifiers, or strings as executable SQL', () => {
    const result = classifyMigrationSql(`
      -- DROP TABLE "Actor";
      /* UPDATE "Actor" SET "level" = 100; */
      CREATE TABLE "DROP" (
        "DELETE" TEXT DEFAULT 'TRUNCATE TABLE secrets; UPDATE users SET admin = true'
      );
    `);
    expect(result).toEqual({ risk: 'low', reasons: [] });
  });

  it('strips nested comments and dollar-quoted string bodies without splitting statements', () => {
    const sanitized = stripSqlCommentsAndStrings(`
      /* outer /* nested DROP */ comment */
      CREATE TABLE "Example" ("note" TEXT DEFAULT $$DELETE; DROP;$$);
    `);
    expect(sanitized).not.toMatch(/\b(?:DELETE|DROP)\b/u);
    expect(sanitized.split(';').filter((statement) => statement.trim())).toHaveLength(1);
  });

  it('fails closed on unterminated SQL strings', () => {
    expect(classifyMigrationSql('CREATE TABLE "broken ("id" UUID);')).toEqual({
      risk: 'high',
      reasons: ['unparseable_sql'],
    });
    expect(classifyMigrationSql('DO $body$ BEGIN;')).toEqual({
      risk: 'high',
      reasons: ['unparseable_sql'],
    });
  });

  it('returns no migration entries for an empty diff', () => {
    expect(parseChangedMigrationEntries('')).toEqual([]);
  });

  it('resolves repository migration paths independently from the backend npm working directory', () => {
    expect(existsSync(resolveRepositoryPath(
      'backend/prisma/migrations/20260726150000_oauth_client_resource_policy/migration.sql',
    ))).toBe(true);
  });

  it('captures added and modified migration files and flags history changes', () => {
    expect(parseChangedMigrationEntries([
      'A\tbackend/prisma/migrations/20260101000000_add_table/migration.sql',
      'M\tbackend/prisma/migrations/20260102000000_add_index/migration.sql',
      'M\tREADME.md',
      'M\tbackend/prisma/migrations/migration_lock.toml',
    ].join('\n'))).toEqual([
      { status: 'A', path: 'backend/prisma/migrations/20260101000000_add_table/migration.sql' },
      { status: 'M', path: 'backend/prisma/migrations/20260102000000_add_index/migration.sql' },
      { status: 'M', path: 'backend/prisma/migrations/migration_lock.toml' },
    ]);
  });

  it('captures both sides of a migration rename so it cannot bypass review', () => {
    expect(parseChangedMigrationEntries(
      'R100\tbackend/prisma/migrations/old/migration.sql\tbackend/prisma/migrations/new/migration.sql',
    )).toHaveLength(2);
  });

  it('uses the empty tree for a zero push base and requires full explicit SHAs otherwise', () => {
    expect(resolveRequestedBase('0'.repeat(40))).toEqual({
      base: EMPTY_TREE_SHA,
      fallback: 'empty-tree',
    });
    const base = 'a'.repeat(40);
    expect(resolveRequestedBase(base)).toEqual({ base, fallback: 'none' });
    expect(() => resolveRequestedBase('HEAD~1')).toThrow('base SHA must be a full commit SHA');
    expect(() => resolveRequestedBase('')).toThrow('base SHA must be a full commit SHA');
  });
});

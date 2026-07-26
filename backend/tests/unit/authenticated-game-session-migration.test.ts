import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
  '../../prisma/migrations/20260726234500_authenticated_game_session_continuity/migration.sql',
  import.meta.url,
), 'utf8');

describe('authenticated game session migration', () => {
  it('is additive, constrained, indexed, and fail-closed to public roles', () => {
    expect(migration).toContain('CREATE TABLE "GameSession"');
    expect(migration).toContain('"GameSession_userId_campaignId_key"');
    expect(migration).toContain('"GameSession_stateVersion_check"');
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('FROM PUBLIC');
    expect(migration).toContain('FROM anon');
    expect(migration).toContain('FROM authenticated');
    expect(migration).toContain('FROM service_role');
    expect(migration).not.toMatch(/(?:^|\n)\s*(?:DROP|DELETE|TRUNCATE|UPDATE|INSERT)\b/u);
  });

  it('preserves campaign and actor state and links audit without backfill', () => {
    expect(migration).toContain('ON DELETE RESTRICT');
    expect(migration).toContain('ON DELETE SET NULL');
    expect(migration).toContain('ALTER TABLE "AuditEvent" ADD COLUMN "gameSessionId" UUID');
    expect(migration).not.toContain('ALTER TABLE "Campaign"');
    expect(migration).not.toContain('ALTER TABLE "Actor"');
  });
});

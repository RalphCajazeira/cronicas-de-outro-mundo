import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  authorizeHighRiskMigration,
  parseHighRiskMigrationAuthorization,
} from '../../scripts/authorize-high-risk-migration.js';

const migrationPath =
  'backend/prisma/migrations/20260726234500_authenticated_game_session_continuity/migration.sql';
const migrationSql = readFileSync(new URL(
  '../../prisma/migrations/20260726234500_authenticated_game_session_continuity/migration.sql',
  import.meta.url,
), 'utf8');
const authorization = parseHighRiskMigrationAuthorization(JSON.parse(readFileSync(new URL(
  '../../provisioning/staging/authenticated-game-session-migration.v1.json',
  import.meta.url,
), 'utf8')) as unknown);

describe('high-risk migration authorization manifest', () => {
  it('authorizes only the exact classified migration and checksum', () => {
    expect(authorizeHighRiskMigration({
      changedMigrations: [migrationPath],
      risk: 'high',
      reasons: [`${migrationPath}:row_level_security`],
    }, authorization, migrationSql)).toBe(true);
    expect(authorizeHighRiskMigration({
      changedMigrations: [migrationPath, 'backend/prisma/migrations/other/migration.sql'],
      risk: 'high',
      reasons: [],
    }, authorization, migrationSql)).toBe(false);
    expect(authorizeHighRiskMigration({
      changedMigrations: [migrationPath],
      risk: 'high',
      reasons: [],
    }, authorization, `${migrationSql}\n-- changed`)).toBe(false);
  });
});

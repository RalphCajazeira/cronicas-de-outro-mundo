import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { MigrationClassification } from './classify-migrations.js';

export const HIGH_RISK_MIGRATION_AUTHORIZATION_PATH =
  'backend/provisioning/staging/authenticated-game-session-migration.v1.json';
const repositoryRoot = resolve(import.meta.dirname, '../..');

const authorizationSchema = z.object({
  operationId: z.literal('authenticated-game-session-continuity-migration-v1'),
  environment: z.literal('staging'),
  risk: z.literal('high'),
  migrationPath: z.literal(
    'backend/prisma/migrations/20260726234500_authenticated_game_session_continuity/migration.sql',
  ),
  migrationSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  authorizedBy: z.literal('ralph-task-phase-2e'),
  enabled: z.literal(true),
}).strict();

export type HighRiskMigrationAuthorization = z.infer<typeof authorizationSchema>;

export function parseHighRiskMigrationAuthorization(value: unknown): HighRiskMigrationAuthorization {
  return authorizationSchema.parse(value);
}

export function authorizeHighRiskMigration(
  classification: MigrationClassification,
  authorization: HighRiskMigrationAuthorization,
  migrationSql: string,
): boolean {
  const checksum = createHash('sha256').update(migrationSql).digest('hex');
  return classification.risk === 'high'
    && classification.changedMigrations.length === 1
    && classification.changedMigrations[0] === authorization.migrationPath
    && checksum === authorization.migrationSha256;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function main(): void {
  const classificationPath = argument('--classification');
  if (classificationPath === undefined) throw new Error('--classification is required');
  const classification = JSON.parse(readFileSync(classificationPath, 'utf8')) as MigrationClassification;
  const authorization = parseHighRiskMigrationAuthorization(JSON.parse(readFileSync(
    resolve(repositoryRoot, HIGH_RISK_MIGRATION_AUTHORIZATION_PATH),
    'utf8',
  )) as unknown);
  const migrationSql = readFileSync(resolve(repositoryRoot, authorization.migrationPath), 'utf8');
  const authorized = authorizeHighRiskMigration(classification, authorization, migrationSql);
  const output = process.env.GITHUB_OUTPUT;
  if (output !== undefined) {
    appendFileSync(output, [
      `authorized=${String(authorized)}`,
      `operation_id=${authorized ? authorization.operationId : ''}`,
    ].join('\n') + '\n');
  }
  process.stdout.write(`${JSON.stringify({
    authorized,
    operationId: authorized ? authorization.operationId : null,
  })}\n`);
  if (classification.risk === 'high' && !authorized) process.exitCode = 1;
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch {
    console.error('High-risk migration authorization failed closed');
    process.exitCode = 1;
  }
}

import { createHash } from 'node:crypto';
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

interface ExpectedStagingTarget {
  projectRef: string;
  database: string;
  role: string;
  schema: string;
}

interface MigrationRecord {
  migration_name: string;
  checksum: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
}

export interface StagingTargetMetadata {
  hostname: string;
  port: number;
  database: string;
  role: string;
  schema: string;
  projectRef: string;
  sslMode: 'verify-full';
}

export interface MigrationState {
  localMigrations: string[];
  appliedMigrations: string[];
  pendingMigrations: string[];
  incompleteMigrations: number;
}

class SafePipelineError extends Error {}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new SafePipelineError(`Required staging setting is missing: ${name}`);
  return value;
}

export function validateStagingTarget(
  connectionString: string,
  expected: ExpectedStagingTarget,
): StagingTargetMetadata {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new SafePipelineError('Staging database URL is invalid');
  }

  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new SafePipelineError('Staging database protocol is invalid');
  }
  if (decodeURIComponent(url.pathname.replace(/^\//u, '')) !== expected.database) {
    throw new SafePipelineError('Staging database name does not match the allowlist');
  }
  const port = url.port === '' ? 5432 : Number.parseInt(url.port, 10);
  if (port !== 5432 || url.searchParams.get('pgbouncer') === 'true') {
    throw new SafePipelineError('Staging migrations require a direct or session-mode connection');
  }
  if (url.searchParams.get('sslmode') !== 'verify-full') {
    throw new SafePipelineError('Staging migrations require sslmode=verify-full');
  }
  const configuredSchema = url.searchParams.get('schema');
  if (configuredSchema !== null && configuredSchema !== expected.schema) {
    throw new SafePipelineError('Staging database schema does not match the allowlist');
  }

  const username = decodeURIComponent(url.username);
  const directHostname = `db.${expected.projectRef}.supabase.co`;
  const sessionPooler = url.hostname.endsWith('.pooler.supabase.com');
  const directTarget = url.hostname === directHostname && username === expected.role;
  const pooledTarget = sessionPooler && username === `${expected.role}.${expected.projectRef}`;
  if (!directTarget && !pooledTarget) {
    throw new SafePipelineError('Staging database project or migration role does not match the allowlist');
  }

  return {
    hostname: url.hostname,
    port,
    database: expected.database,
    role: expected.role,
    schema: expected.schema,
    projectRef: expected.projectRef,
    sslMode: 'verify-full',
  };
}

function localMigrationChecksums(): Map<string, string> {
  const migrationRoot = resolve(import.meta.dirname, '../prisma/migrations');
  const migrations = readdirSync(migrationRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return new Map(migrations.map((name) => {
    const contents = readFileSync(resolve(migrationRoot, name, 'migration.sql'));
    return [name, createHash('sha256').update(contents).digest('hex')];
  }));
}

export function inspectMigrationState(
  records: MigrationRecord[],
  localChecksums: Map<string, string>,
  requireSynchronized: boolean,
): MigrationState {
  const incomplete = records.filter((record) => record.finished_at === null && record.rolled_back_at === null);
  const rolledBack = records.filter((record) => record.rolled_back_at !== null);
  if (incomplete.length > 0 || rolledBack.length > 0) {
    throw new SafePipelineError('Prisma migration history contains incomplete or rolled-back entries');
  }

  const applied = records
    .filter((record) => record.finished_at !== null)
    .map((record) => record.migration_name);
  const local = [...localChecksums.keys()];

  if (new Set(applied).size !== applied.length) {
    throw new SafePipelineError('Prisma migration history contains duplicate entries');
  }
  for (const record of records) {
    const expectedChecksum = localChecksums.get(record.migration_name);
    if (expectedChecksum === undefined) throw new SafePipelineError('Remote migration history is not present in the commit');
    if (record.checksum !== expectedChecksum) throw new SafePipelineError('An applied migration checksum differs from the commit');
  }
  if (applied.some((name, index) => name !== local[index])) {
    throw new SafePipelineError('Remote migration history is not a prefix of the committed chain');
  }

  const pendingMigrations = local.slice(applied.length);
  if (requireSynchronized && pendingMigrations.length > 0) {
    throw new SafePipelineError('Post-migration verification found pending migrations');
  }

  return {
    localMigrations: local,
    appliedMigrations: applied,
    pendingMigrations,
    incompleteMigrations: incomplete.length,
  };
}

async function inspectDatabase(mode: 'preflight' | 'postflight'): Promise<MigrationState> {
  const connectionString = requiredEnvironment('DATABASE_URL');
  const expected: ExpectedStagingTarget = {
    projectRef: requiredEnvironment('STAGING_SUPABASE_PROJECT_REF'),
    database: requiredEnvironment('STAGING_DATABASE_NAME'),
    role: requiredEnvironment('STAGING_DATABASE_ROLE'),
    schema: requiredEnvironment('STAGING_DATABASE_SCHEMA'),
  };
  validateStagingTarget(connectionString, expected);

  const client = new Client({
    connectionString,
    application_name: 'cronicas-staging-release',
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
  });

  try {
    await client.connect();
    const target = await client.query<{
      database_name: string;
      role_name: string;
      schema_name: string;
      history_exists: boolean;
    }>(`
      SELECT
        current_database() AS database_name,
        current_user AS role_name,
        current_schema() AS schema_name,
        to_regclass('public."_prisma_migrations"') IS NOT NULL AS history_exists
    `);
    const metadata = target.rows[0];
    if (
      metadata === undefined
      || metadata.database_name !== expected.database
      || metadata.role_name !== expected.role
      || metadata.schema_name !== expected.schema
      || !metadata.history_exists
    ) {
      throw new SafePipelineError('Connected staging database metadata does not match the allowlist');
    }

    const history = await client.query<MigrationRecord>(`
      SELECT migration_name, checksum, finished_at, rolled_back_at
      FROM public."_prisma_migrations"
      ORDER BY started_at, migration_name
    `);
    return inspectMigrationState(history.rows, localMigrationChecksums(), mode === 'postflight');
  } finally {
    await client.end().catch(() => undefined);
  }
}

function appendSummary(mode: 'preflight' | 'postflight', state: MigrationState): void {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary === undefined) return;
  appendFileSync(summary, [
    `## Database ${mode}`,
    '',
    '- Target: allowlisted Supabase staging database',
    `- Applied migrations: ${state.appliedMigrations.length}`,
    `- Local migrations: ${state.localMigrations.length}`,
    `- Pending migrations: ${state.pendingMigrations.length}`,
    `- Incomplete migrations: ${state.incompleteMigrations}`,
    ...(state.pendingMigrations.map((name) => `  - Pending: \`${name}\``)),
    '',
  ].join('\n'));
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== 'preflight' && mode !== 'postflight') throw new SafePipelineError('Expected preflight or postflight mode');
  const state = await inspectDatabase(mode);
  console.info(`Staging database ${mode} passed: ${state.appliedMigrations.length}/${state.localMigrations.length} migrations applied`);
  appendSummary(mode, state);
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof SafePipelineError ? error.message : 'Staging database verification failed safely');
    process.exitCode = 1;
  });
}

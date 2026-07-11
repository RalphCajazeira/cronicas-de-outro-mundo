import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import pg from 'pg';
import { createAdminUrl, resolveTestDatabaseConfig } from '../tests/support/test-database.js';

const { Client } = pg;

function runNpm(args: string[], environment: NodeJS.ProcessEnv): void {
  const npmCli = process.env.npm_execpath;
  if (npmCli === undefined) throw new Error('Unable to locate npm CLI');
  const result = spawnSync(process.execPath, [npmCli, ...args], { env: environment, stdio: 'inherit' });
  if (result.error !== undefined) throw new Error('Unable to start integration test command');
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function recreateTestDatabase(adminUrl: URL): Promise<void> {
  const client = new Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', ['game_gpt_test']);
    await client.query('DROP DATABASE IF EXISTS "game_gpt_test"');
    await client.query('CREATE DATABASE "game_gpt_test"');
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const config = resolveTestDatabaseConfig(process.env);
  await recreateTestDatabase(createAdminUrl(config.directUrl));
  console.info('Local test database recreated safely');

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: config.databaseUrl.toString(),
    DIRECT_URL: config.directUrl.toString(),
    RPG_API_KEY: config.apiKey,
  };

  runNpm(['exec', '--', 'prisma', 'migrate', 'deploy'], environment);
  runNpm(['run', 'prisma:seed'], environment);
  runNpm(['exec', '--', 'vitest', 'run', '--config', 'vitest.integration.config.ts'], environment);
}

main().catch(() => {
  console.error('Integration test preparation failed safely');
  process.exitCode = 1;
});

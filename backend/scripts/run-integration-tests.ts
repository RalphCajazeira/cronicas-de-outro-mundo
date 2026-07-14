import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { ensureCoreV1ContentProfileVersion } from '../src/modules/rules/content-profile.registry.js';
import { ensureCoreV1InventoryRulesVersion } from '../src/modules/rules/inventory-rules.registry.js';
import { ensureCoreV1EffectRulesVersion } from '../src/modules/rules/effect-rules.registry.js';
import { ensureCoreV1RulesetVersion } from '../src/modules/rules/ruleset.registry.js';
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

function migrationSql(name: string): string {
  return readFileSync(new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url), 'utf8');
}

async function verifyCleanSlatePrecondition(databaseUrl: URL, adminUrl: URL): Promise<void> {
  await recreateTestDatabase(adminUrl);
  const client = new Client({ connectionString: databaseUrl.toString() });
  await client.connect();
  try {
    await client.query(migrationSql('20260711183000_init'));
    await client.query(migrationSql('20260711223000_production_gpt_security'));
    await client.query(`
      INSERT INTO "Player" ("id", "slug", "displayName", "updatedAt")
      VALUES ('00000000-0000-0000-0000-000000000001', 'precondition-player', 'Precondition Player', CURRENT_TIMESTAMP)
    `);
    await client.query(`
      INSERT INTO "World" ("id", "playerId", "code", "name", "updatedAt")
      VALUES ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'precondition-world', 'Precondition World', CURRENT_TIMESTAMP)
    `);
    await client.query(`
      INSERT INTO "Campaign" ("id", "worldId", "code", "name", "updatedAt")
      VALUES ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000002', 'precondition-campaign', 'Precondition Campaign', CURRENT_TIMESTAMP)
    `);

    let rejected = false;
    try {
      await client.query(migrationSql('20260713174337_engine_v1_ruleset_persistence'));
    } catch (error) {
      rejected = error instanceof Error
        && error.message.includes('Phase 1C migration requires empty World and Campaign tables; clear functional data before rollout');
    }
    if (!rejected) throw new Error('Phase 1C clean-slate precondition was not enforced');

    const persisted = await client.query<{ worlds: number; campaigns: number }>(`
      SELECT
        (SELECT count(*)::int FROM "World") AS worlds,
        (SELECT count(*)::int FROM "Campaign") AS campaigns
    `);
    if (persisted.rows[0]?.worlds !== 1 || persisted.rows[0]?.campaigns !== 1) {
      throw new Error('Phase 1C clean-slate precondition changed functional data');
    }
  } finally {
    await client.end();
  }
  console.info('Phase 1C clean-slate precondition verified safely');
}

async function verifyActorCleanSlatePrecondition(databaseUrl: URL, adminUrl: URL): Promise<void> {
  await recreateTestDatabase(adminUrl);
  const client = new Client({ connectionString: databaseUrl.toString() });
  await client.connect();
  try {
    await client.query(migrationSql('20260711183000_init'));
    await client.query(migrationSql('20260711223000_production_gpt_security'));
    await client.query(migrationSql('20260713174337_engine_v1_ruleset_persistence'));
    await client.query(`
      INSERT INTO "Ruleset" ("id", "code", "name")
      VALUES ('10000000-0000-0000-0000-000000000001', 'precondition-core', 'Precondition Core');
      INSERT INTO "RulesetVersion" ("id", "rulesetId", "code", "revision", "schemaVersion", "configHash", "configSnapshot")
      VALUES ('10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'precondition-v1', 'test', 1, repeat('0', 64), '{}');
      INSERT INTO "Player" ("id", "slug", "displayName", "updatedAt")
      VALUES ('10000000-0000-0000-0000-000000000003', 'actor-precondition-player', 'Actor Precondition Player', CURRENT_TIMESTAMP);
      INSERT INTO "World" ("id", "playerId", "defaultRulesetVersionId", "code", "name", "updatedAt")
      VALUES ('10000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002', 'actor-precondition-world', 'Actor Precondition World', CURRENT_TIMESTAMP);
      INSERT INTO "Campaign" ("id", "worldId", "rulesetVersionId", "code", "name", "updatedAt")
      VALUES ('10000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000002', 'actor-precondition-campaign', 'Actor Precondition Campaign', CURRENT_TIMESTAMP);
      INSERT INTO "Actor" ("id", "campaignId", "code", "name", "actorType", "health", "maxHealth", "mana", "maxMana", "updatedAt")
      VALUES ('10000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000005', 'actor-precondition', 'Actor Precondition', 'NPC', 10, 10, 5, 5, CURRENT_TIMESTAMP);
    `);

    let rejected = false;
    try {
      await client.query(migrationSql('20260713190000_engine_v1_actor_mechanics'));
    } catch (error) {
      rejected = error instanceof Error
        && error.message.includes('Phase 1D migration requires an empty Actor table; clear functional data before rollout');
    }
    if (!rejected) throw new Error('Phase 1D clean-slate precondition was not enforced');
    const persisted = await client.query<{ actors: number; health: number }>(`
      SELECT count(*)::int AS actors, min("health")::int AS health FROM "Actor"
    `);
    if (persisted.rows[0]?.actors !== 1 || persisted.rows[0]?.health !== 10) {
      throw new Error('Phase 1D clean-slate precondition changed functional Actor data');
    }
  } finally {
    await client.end();
  }
  console.info('Phase 1D clean-slate precondition verified safely');
}

async function verifyContentCleanSlatePrecondition(databaseUrl: URL, adminUrl: URL): Promise<void> {
  await recreateTestDatabase(adminUrl);
  const client = new Client({ connectionString: databaseUrl.toString() });
  await client.connect();
  try {
    await client.query(migrationSql('20260711183000_init'));
    await client.query(migrationSql('20260711223000_production_gpt_security'));
    await client.query(migrationSql('20260713174337_engine_v1_ruleset_persistence'));
    await client.query(migrationSql('20260713190000_engine_v1_actor_mechanics'));
    await client.query(`
      INSERT INTO "Ruleset" ("id", "code", "name")
      VALUES ('20000000-0000-0000-0000-000000000001', 'content-precondition', 'Content Precondition');
      INSERT INTO "RulesetVersion" ("id", "rulesetId", "code", "revision", "schemaVersion", "configHash", "configSnapshot")
      VALUES ('20000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'content-precondition-v1', 'test', 1, repeat('0', 64), '{}');
      INSERT INTO "Player" ("id", "slug", "displayName", "updatedAt")
      VALUES ('20000000-0000-0000-0000-000000000003', 'content-precondition-player', 'Content Precondition Player', CURRENT_TIMESTAMP);
      INSERT INTO "World" ("id", "playerId", "defaultRulesetVersionId", "code", "name", "updatedAt")
      VALUES ('20000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000002', 'content-precondition-world', 'Content Precondition World', CURRENT_TIMESTAMP);
      INSERT INTO "Campaign" ("id", "worldId", "rulesetVersionId", "code", "name", "updatedAt")
      VALUES ('20000000-0000-0000-0000-000000000005', '20000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000002', 'content-precondition-campaign', 'Content Precondition Campaign', CURRENT_TIMESTAMP);
      INSERT INTO "Actor" ("id", "campaignId", "code", "name", "actorType", "updatedAt")
      VALUES ('20000000-0000-0000-0000-000000000006', '20000000-0000-0000-0000-000000000005', 'content-precondition-actor', 'Content Precondition Actor', 'NPC', CURRENT_TIMESTAMP);
      INSERT INTO "ContentDefinition" ("id", "worldId", "code", "name", "contentType", "updatedAt")
      VALUES ('20000000-0000-0000-0000-000000000007', '20000000-0000-0000-0000-000000000004', 'content-precondition-skill', 'Content Precondition Skill', 'SKILL', CURRENT_TIMESTAMP);
      INSERT INTO "ActorContent" ("id", "actorId", "contentDefinitionId", "updatedAt")
      VALUES ('20000000-0000-0000-0000-000000000008', '20000000-0000-0000-0000-000000000006', '20000000-0000-0000-0000-000000000007', CURRENT_TIMESTAMP);
    `);

    let rejected = false;
    try {
      await client.query(migrationSql('20260713230000_engine_v1_content_versioning'));
    } catch (error) {
      rejected = error instanceof Error
        && error.message.includes('Phase 1F migration requires empty ContentDefinition and ActorContent tables; clear functional data before rollout');
    }
    if (!rejected) throw new Error('Phase 1F clean-slate precondition was not enforced');
    const persisted = await client.query<{ definitions: number; links: number }>(`
      SELECT (SELECT count(*)::int FROM "ContentDefinition") AS definitions,
             (SELECT count(*)::int FROM "ActorContent") AS links
    `);
    if (persisted.rows[0]?.definitions !== 1 || persisted.rows[0]?.links !== 1) {
      throw new Error('Phase 1F clean-slate precondition changed functional content data');
    }
  } finally {
    await client.end();
  }
  console.info('Phase 1F clean-slate precondition verified safely');
}

async function verifyInventoryCleanSlatePrecondition(databaseUrl: URL, adminUrl: URL): Promise<void> {
  await recreateTestDatabase(adminUrl);
  const client = new Client({ connectionString: databaseUrl.toString() });
  await client.connect();
  try {
    await client.query(migrationSql('20260711183000_init'));
    await client.query(migrationSql('20260711223000_production_gpt_security'));
    await client.query(migrationSql('20260713174337_engine_v1_ruleset_persistence'));
    await client.query(migrationSql('20260713190000_engine_v1_actor_mechanics'));
    await client.query(migrationSql('20260713230000_engine_v1_content_versioning'));
    await client.query(`
      INSERT INTO "Ruleset" ("id", "code", "name")
      VALUES ('30000000-0000-0000-0000-000000000001', 'inventory-precondition', 'Inventory Precondition');
      INSERT INTO "RulesetVersion" ("id", "rulesetId", "code", "revision", "schemaVersion", "configHash", "configSnapshot")
      VALUES ('30000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000001', 'inventory-precondition-v1', 'test', 1, repeat('0', 64), '{}');
      INSERT INTO "Player" ("id", "slug", "displayName", "updatedAt")
      VALUES ('30000000-0000-0000-0000-000000000003', 'inventory-precondition-player', 'Inventory Precondition Player', CURRENT_TIMESTAMP);
      INSERT INTO "World" ("id", "playerId", "defaultRulesetVersionId", "code", "name", "updatedAt")
      VALUES ('30000000-0000-0000-0000-000000000004', '30000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000002', 'inventory-precondition-world', 'Inventory Precondition World', CURRENT_TIMESTAMP);
      INSERT INTO "ContentDefinition" ("id", "worldId", "code", "contentType", "status", "updatedAt")
      VALUES ('30000000-0000-0000-0000-000000000005', '30000000-0000-0000-0000-000000000004', 'inventory-precondition-item', 'ITEM', 'ACTIVE', CURRENT_TIMESTAMP);
    `);

    let rejected = false;
    try {
      await client.query(migrationSql('20260714010000_engine_v1_inventory_persistence'));
    } catch (error) {
      rejected = error instanceof Error
        && error.message.includes('Phase 1H migration requires empty ActorContent, ContentDefinition and ContentVersion tables; clear functional data before rollout');
    }
    if (!rejected) throw new Error('Phase 1H clean-slate precondition was not enforced');
    const persisted = await client.query<{ definitions: number; inventory_table: string | null }>(`
      SELECT count(*)::int AS definitions, to_regclass('public."InventoryEntry"')::text AS inventory_table
      FROM "ContentDefinition"
    `);
    if (persisted.rows[0]?.definitions !== 1 || persisted.rows[0]?.inventory_table !== null) {
      throw new Error('Phase 1H clean-slate precondition changed functional content data or partially applied schema');
    }
  } finally {
    await client.end();
  }
  console.info('Phase 1H clean-slate precondition verified safely');
}

async function verifyEffectsCleanSlatePrecondition(databaseUrl: URL, adminUrl: URL): Promise<void> {
  await recreateTestDatabase(adminUrl);
  const client = new Client({ connectionString: databaseUrl.toString() });
  await client.connect();
  try {
    for (const migration of [
      '20260711183000_init', '20260711223000_production_gpt_security',
      '20260713174337_engine_v1_ruleset_persistence', '20260713190000_engine_v1_actor_mechanics',
      '20260713230000_engine_v1_content_versioning', '20260714010000_engine_v1_inventory_persistence',
    ]) await client.query(migrationSql(migration));
    await client.query(`
      INSERT INTO "Ruleset" ("id", "code", "name")
      VALUES ('40000000-0000-0000-0000-000000000001', 'effects-precondition', 'Effects Precondition');
      INSERT INTO "RulesetVersion" ("id", "rulesetId", "code", "revision", "schemaVersion", "configHash", "configSnapshot")
      VALUES ('40000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000001', 'effects-precondition-v1', 'test', 1, repeat('0', 64), '{}');
      INSERT INTO "Player" ("id", "slug", "displayName", "updatedAt")
      VALUES ('40000000-0000-0000-0000-000000000003', 'effects-precondition-player', 'Effects Precondition Player', CURRENT_TIMESTAMP);
      INSERT INTO "World" ("id", "playerId", "defaultRulesetVersionId", "code", "name", "updatedAt")
      VALUES ('40000000-0000-0000-0000-000000000004', '40000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000002', 'effects-precondition-world', 'Effects Precondition World', CURRENT_TIMESTAMP);
      INSERT INTO "Campaign" ("id", "worldId", "rulesetVersionId", "code", "name", "updatedAt")
      VALUES ('40000000-0000-0000-0000-000000000005', '40000000-0000-0000-0000-000000000004', '40000000-0000-0000-0000-000000000002', 'effects-precondition-campaign', 'Effects Precondition Campaign', CURRENT_TIMESTAMP);
      INSERT INTO "Actor" ("id", "campaignId", "code", "name", "actorType", "updatedAt")
      VALUES ('40000000-0000-0000-0000-000000000006', '40000000-0000-0000-0000-000000000005', 'effects-precondition-actor', 'Effects Precondition Actor', 'NPC', CURRENT_TIMESTAMP);
    `);
    let rejected = false;
    try {
      await client.query(migrationSql('20260714030000_engine_v1_effects_persistence'));
    } catch (error) {
      rejected = error instanceof Error && error.message.includes('Phase 1J migration requires empty Actor, ContentDefinition, ContentVersion, ActorContent, InventoryEntry and ActorEquipmentSlot tables');
    }
    if (!rejected) throw new Error('Phase 1J clean-slate precondition was not enforced');
    const persisted = await client.query<{ actors: number; effect_rules_table: string | null }>(`
      SELECT count(*)::int AS actors, to_regclass('public."EffectRulesVersion"')::text AS effect_rules_table FROM "Actor"
    `);
    if (persisted.rows[0]?.actors !== 1 || persisted.rows[0]?.effect_rules_table !== null) {
      throw new Error('Phase 1J clean-slate precondition changed functional data or partially applied schema');
    }
  } finally {
    await client.end();
  }
  console.info('Phase 1J clean-slate precondition verified safely');
}

async function verifyRulesetRegistryTransactions(databaseUrl: URL): Promise<void> {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl.toString(), max: 5 }) });
  try {
    let rolledBack = false;
    try {
      await prisma.$transaction(async (transaction) => {
        await ensureCoreV1RulesetVersion(transaction);
        throw new Error('intentional ruleset registry rollback');
      });
    } catch (error) {
      rolledBack = error instanceof Error && error.message === 'intentional ruleset registry rollback';
    }
    if (!rolledBack || await prisma.ruleset.count() !== 0 || await prisma.rulesetVersion.count() !== 0) {
      throw new Error('Ruleset registry transaction did not roll back completely');
    }

    const versions = await Promise.all([
      prisma.$transaction((transaction) => ensureCoreV1RulesetVersion(transaction)),
      prisma.$transaction((transaction) => ensureCoreV1RulesetVersion(transaction)),
    ]);
    const [rulesets, persistedVersions] = await Promise.all([
      prisma.ruleset.count({ where: { code: 'core' } }),
      prisma.rulesetVersion.count({ where: { code: 'core-v1' } }),
    ]);
    if (rulesets !== 1 || persistedVersions !== 1 || versions[0].id !== versions[1].id) {
      throw new Error('Concurrent ruleset registry creation was not idempotent');
    }
  } finally {
    await prisma.$disconnect();
  }
  console.info('Phase 1C registry rollback and concurrency verified safely');
}

async function verifyContentProfileRegistryTransactions(databaseUrl: URL): Promise<void> {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl.toString(), max: 5 }) });
  try {
    let rolledBack = false;
    try {
      await prisma.$transaction(async (transaction) => {
        await ensureCoreV1ContentProfileVersion(transaction);
        throw new Error('intentional content profile registry rollback');
      });
    } catch (error) {
      rolledBack = error instanceof Error && error.message === 'intentional content profile registry rollback';
    }
    if (!rolledBack || await prisma.contentProfileVersion.count() !== 0) {
      throw new Error('Content profile registry transaction did not roll back completely');
    }
    const versions = await Promise.all([
      prisma.$transaction((transaction) => ensureCoreV1ContentProfileVersion(transaction)),
      prisma.$transaction((transaction) => ensureCoreV1ContentProfileVersion(transaction)),
    ]);
    const persistedVersions = await prisma.contentProfileVersion.count({ where: { code: 'core-v1-content-v1' } });
    if (persistedVersions !== 1 || versions[0].id !== versions[1].id) {
      throw new Error('Concurrent content profile registry creation was not idempotent');
    }
  } finally {
    await prisma.$disconnect();
  }
  console.info('Phase 1F profile registry rollback and concurrency verified safely');
}

async function verifyInventoryRulesRegistryTransactions(databaseUrl: URL): Promise<void> {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl.toString(), max: 5 }) });
  try {
    let rolledBack = false;
    try {
      await prisma.$transaction(async (transaction) => {
        await ensureCoreV1InventoryRulesVersion(transaction);
        throw new Error('intentional inventory rules registry rollback');
      });
    } catch (error) {
      rolledBack = error instanceof Error && error.message === 'intentional inventory rules registry rollback';
    }
    if (!rolledBack || await prisma.inventoryRulesVersion.count() !== 0) {
      throw new Error('Inventory rules registry transaction did not roll back completely');
    }
    const versions = await Promise.all([
      prisma.$transaction((transaction) => ensureCoreV1InventoryRulesVersion(transaction)),
      prisma.$transaction((transaction) => ensureCoreV1InventoryRulesVersion(transaction)),
    ]);
    const persistedVersions = await prisma.inventoryRulesVersion.count({ where: { code: 'core-v1-inventory-v1' } });
    if (persistedVersions !== 1 || versions[0].id !== versions[1].id) {
      throw new Error('Concurrent inventory rules registry creation was not idempotent');
    }
  } finally {
    await prisma.$disconnect();
  }
  console.info('Phase 1H inventory registry rollback and concurrency verified safely');
}

async function verifyEffectRulesRegistryTransactions(databaseUrl: URL): Promise<void> {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl.toString(), max: 5 }) });
  try {
    let rolledBack = false;
    try {
      await prisma.$transaction(async (transaction) => {
        await ensureCoreV1EffectRulesVersion(transaction);
        throw new Error('intentional effect rules registry rollback');
      });
    } catch (error) {
      rolledBack = error instanceof Error && error.message === 'intentional effect rules registry rollback';
    }
    if (!rolledBack || await prisma.effectRulesVersion.count() !== 0) {
      throw new Error('Effect rules registry transaction did not roll back completely');
    }
    const versions = await Promise.all([
      prisma.$transaction((transaction) => ensureCoreV1EffectRulesVersion(transaction)),
      prisma.$transaction((transaction) => ensureCoreV1EffectRulesVersion(transaction)),
    ]);
    const persistedVersions = await prisma.effectRulesVersion.count({ where: { code: 'core-v1-effects-v1' } });
    if (persistedVersions !== 1 || versions[0].id !== versions[1].id) {
      throw new Error('Concurrent effect rules registry creation was not idempotent');
    }
  } finally {
    await prisma.$disconnect();
  }
  console.info('Phase 1J effect registry rollback and concurrency verified safely');
}

async function main(): Promise<void> {
  const config = resolveTestDatabaseConfig(process.env);
  const adminUrl = createAdminUrl(config.directUrl);
  await verifyCleanSlatePrecondition(config.directUrl, adminUrl);
  await verifyActorCleanSlatePrecondition(config.directUrl, adminUrl);
  await verifyContentCleanSlatePrecondition(config.directUrl, adminUrl);
  await verifyInventoryCleanSlatePrecondition(config.directUrl, adminUrl);
  await verifyEffectsCleanSlatePrecondition(config.directUrl, adminUrl);
  await recreateTestDatabase(adminUrl);
  console.info('Local test database recreated safely');

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: config.databaseUrl.toString(),
    DIRECT_URL: config.directUrl.toString(),
    RPG_API_KEY: config.apiKey,
  };

  runNpm(['exec', '--', 'prisma', 'migrate', 'deploy'], environment);
  runNpm(['exec', '--', 'prisma', 'migrate', 'status'], environment);
  runNpm([
    'exec', '--', 'prisma', 'migrate', 'diff', '--from-config-datasource',
    '--to-schema=prisma/schema.prisma', '--exit-code',
  ], environment);
  await verifyRulesetRegistryTransactions(config.databaseUrl);
  await verifyContentProfileRegistryTransactions(config.databaseUrl);
  await verifyInventoryRulesRegistryTransactions(config.databaseUrl);
  await verifyEffectRulesRegistryTransactions(config.databaseUrl);
  runNpm(['run', 'prisma:seed'], environment);
  runNpm(['exec', '--', 'vitest', 'run', '--config', 'vitest.integration.config.ts'], environment);
}

main().catch(() => {
  console.error('Integration test preparation failed safely');
  process.exitCode = 1;
});

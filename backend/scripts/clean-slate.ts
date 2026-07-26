import 'dotenv/config';
import process from 'node:process';
import pg, { type ClientBase } from 'pg';

const { Client } = pg;

/**
 * Application-owned public objects created by the committed Prisma migrations.
 * Keep this list explicit: clean-slate must never infer ownership from a prefix.
 */
export const cleanSlateObjects = {
  tables: [
    'ActiveEffect', 'Actor', 'ActorAttribute', 'ActorContent', 'ActorControl',
    'ActorDerivedSnapshot', 'ActorEquipmentSlot', 'ActorResource', 'AuditEvent',
    'Campaign', 'CampaignMembership', 'ContentDefinition',
    'ContentEffectBinding', 'ContentProfileVersion', 'ContentVersion', 'EffectResolution',
    'EffectRoll', 'EffectRulesVersion', 'Encounter', 'EncounterConsequence',
    'EncounterOperation', 'EncounterParticipant', 'EncounterRoll', 'ExternalIdentity', 'GameEvent',
    'IdempotencyRecord', 'InventoryEntry', 'InventoryRulesVersion', 'OAuthClientResourcePolicy', 'Player', 'Ruleset',
    'RulesetVersion', 'User', 'World',
  ],
  enums: [
    'ActiveEffectDurationType', 'ActiveEffectKind', 'ActorAttributeCode', 'ActorContentState',
    'ActorControlPermission', 'ActorEquipmentSlotRef', 'ActorResourceType', 'ActorStatus',
    'ActorType', 'AuditDecision', 'CampaignMembershipRole', 'CampaignMembershipStatus',
    'CampaignStatus', 'ContentEffectBindingKind', 'ContentProfileMode', 'ContentStatus', 'ContentType',
    'EffectResolutionOperation', 'EffectRollKind', 'EncounterCompletionCandidate',
    'EncounterEphemeralKind', 'EncounterLifecycleStatus', 'EncounterOperationKind',
    'EncounterOutcome', 'EncounterParticipantBindingKind', 'EncounterRollKind',
    'EncounterStopReason', 'InventoryEntryKind', 'InventoryInstanceLifecycle', 'UserStatus',
  ],
  functions: [
    ['active_effect_validate', ''], ['active_effect_validate_encounter_origin', ''],
    ['actor_equipment_slot_validate', ''], ['actor_reject_encounter_binding_change', ''],
    ['campaign_guard_ruleset_version_change', ''], ['content_definition_guard_identity_change', ''],
    ['custom_access_token_hook', 'jsonb'],
    ['content_effect_binding_validate', ''], ['content_profile_version_block_mutation', ''],
    ['content_version_block_mutation', ''], ['effect_resolution_validate', ''],
    ['encounter_consequence_reject_invalid', ''], ['encounter_consequence_validate', 'uuid'],
    ['encounter_participant_validate_actor', ''], ['encounter_reject_scope_change', ''],
    ['encounter_terminal_reject_authority_update', ''], ['encounter_terminal_requires_consequence', ''],
    ['encounter_validate_ruleset', ''], ['inventory_entry_block_equipped_delete', ''],
    ['inventory_entry_validate', ''], ['inventory_rules_version_block_mutation', ''],
    ['phase1j_immutable_record', ''], ['phase1la_immutable_record', ''],
    ['ruleset_version_block_delete', ''], ['ruleset_version_block_update', ''],
  ] as const,
  // The committed migrations do not create standalone views, materialized views, procedures,
  // domains, composite types, or sequences. Their presence is reported, never guessed away.
  standaloneRelations: [] as string[],
} as const;

type CleanSlateSummary = {
  droppedTriggers: number;
  droppedFunctions: number;
  droppedTables: number;
  droppedEnums: number;
  droppedPrismaHistory: boolean;
};

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function assertSubset(actual: readonly string[], expected: readonly string[], kind: string): void {
  const unexpected = actual.filter((value) => !expected.includes(value));
  if (unexpected.length > 0) {
    throw new Error(`Refusing clean-slate: unexpected public ${kind} present (${unexpected.join(', ')})`);
  }
}

async function existingNames(client: ClientBase, query: string, values: readonly string[]): Promise<string[]> {
  const result = await client.query<{ name: string }>(query, [values]);
  return result.rows.map((row) => row.name);
}

export async function inspectCleanSlateObjects(client: ClientBase): Promise<Record<string, number>> {
  const tables = await existingNames(client, `
    SELECT relname AS name FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public' AND relation.relkind IN ('r', 'p') AND relname = ANY($1::text[])
  `, cleanSlateObjects.tables);
  const enums = await existingNames(client, `
    SELECT type_name.typname AS name FROM pg_type type_name
    JOIN pg_namespace namespace ON namespace.oid = type_name.typnamespace
    WHERE namespace.nspname = 'public' AND type_name.typtype = 'e' AND type_name.typname = ANY($1::text[])
  `, cleanSlateObjects.enums);
  const functions = await existingNames(client, `
    SELECT routine.proname AS name FROM pg_proc routine
    JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = 'public' AND routine.proname = ANY($1::text[])
  `, cleanSlateObjects.functions.map(([name]) => name));
  const prismaHistory = await client.query<{ exists: boolean }>(
    `SELECT to_regclass('public."_prisma_migrations"') IS NOT NULL AS exists`,
  );
  return { tables: tables.length, enums: enums.length, functions: functions.length, prismaHistory: prismaHistory.rows[0]?.exists ? 1 : 0 };
}

/** Drops only the enumerated application objects, in one database transaction. */
export async function cleanSlateApplicationSchema(client: ClientBase): Promise<CleanSlateSummary> {
  const allowedTables = [...cleanSlateObjects.tables, '_prisma_migrations'];
  const triggerRows = await client.query<{ tableName: string; triggerName: string }>(`
    SELECT table_relation.relname AS "tableName", trigger_relation.tgname AS "triggerName"
    FROM pg_trigger trigger_relation
    JOIN pg_class table_relation ON table_relation.oid = trigger_relation.tgrelid
    JOIN pg_namespace namespace ON namespace.oid = table_relation.relnamespace
    WHERE namespace.nspname = 'public' AND NOT trigger_relation.tgisinternal
  `);
  assertSubset(triggerRows.rows.map((row) => row.tableName), allowedTables, 'trigger table');

  const summary: CleanSlateSummary = { droppedTriggers: 0, droppedFunctions: 0, droppedTables: 0, droppedEnums: 0, droppedPrismaHistory: false };
  await client.query('BEGIN');
  try {
    for (const trigger of triggerRows.rows) {
      await client.query(`DROP TRIGGER IF EXISTS ${quoteIdentifier(trigger.triggerName)} ON public.${quoteIdentifier(trigger.tableName)}`);
      summary.droppedTriggers += 1;
    }
    for (const [name, argumentsSql] of cleanSlateObjects.functions) {
      await client.query(`DROP FUNCTION IF EXISTS public.${quoteIdentifier(name)}(${argumentsSql}) RESTRICT`);
      summary.droppedFunctions += 1;
    }
    for (const table of cleanSlateObjects.tables) {
      await client.query(`DROP TABLE IF EXISTS public.${quoteIdentifier(table)} CASCADE`);
      summary.droppedTables += 1;
    }
    await client.query('DROP TABLE IF EXISTS public."_prisma_migrations" CASCADE');
    summary.droppedPrismaHistory = true;
    for (const typeName of cleanSlateObjects.enums) {
      await client.query(`DROP TYPE IF EXISTS public.${quoteIdentifier(typeName)} RESTRICT`);
      summary.droppedEnums += 1;
    }
    await client.query('COMMIT');
    return summary;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

function parseEnvironment(): 'local' | 'staging' {
  const value = process.argv.find((argument) => argument.startsWith('--environment='))?.split('=')[1];
  if (value === 'local' || value === 'staging') return value;
  throw new Error('Pass --environment=local or --environment=staging');
}

function assertTarget(url: URL, environment: 'local' | 'staging'): void {
  const host = url.hostname;
  if (environment === 'local') {
    if (!['localhost', '127.0.0.1'].includes(host) || url.pathname !== '/game_gpt_test') {
      throw new Error('Local clean-slate accepts only localhost game_gpt_test');
    }
    return;
  }
  if (host !== 'db.udqwzvhlwwfnngiipacj.supabase.co' || url.pathname !== '/postgres') {
    throw new Error('Staging clean-slate target mismatch');
  }
}

async function main(): Promise<void> {
  const environment = parseEnvironment();
  const directUrl = process.env.DIRECT_URL;
  if (directUrl === undefined) throw new Error('DIRECT_URL is required');
  const target = new URL(directUrl);
  assertTarget(target, environment);
  const execute = process.argv.includes('--execute');
  const confirmation = `--confirm=${environment}-clean-slate`;
  if (execute && !process.argv.includes(confirmation)) throw new Error(`Pass ${confirmation} to execute`);
  console.info(`Clean-slate plan: ${environment}; target verified; application allowlist only; execute=${execute}`);
  const database = new Client({ connectionString: target.toString() });
  await database.connect();
  try {
    const before = await inspectCleanSlateObjects(database);
    console.info(`Catalog before: tables=${before.tables}, enums=${before.enums}, functions=${before.functions}, prismaHistory=${before.prismaHistory}`);
    if (!execute) return;
    const summary = await cleanSlateApplicationSchema(database);
    const after = await inspectCleanSlateObjects(database);
    if (after.tables !== 0 || after.enums !== 0 || after.functions !== 0 || after.prismaHistory !== 0) {
      throw new Error('Clean-slate postcondition failed: application objects remain');
    }
    console.info(`Clean-slate complete: triggers=${summary.droppedTriggers}, functions=${summary.droppedFunctions}, tables=${summary.droppedTables}, enums=${summary.droppedEnums}, prismaHistory=${summary.droppedPrismaHistory}`);
  } finally {
    await database.end();
  }
}

if (process.argv[1]?.endsWith('clean-slate.ts')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Clean-slate failed safely');
    process.exitCode = 1;
  });
}

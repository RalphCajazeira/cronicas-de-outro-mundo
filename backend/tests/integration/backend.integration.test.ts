import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import pg from 'pg';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ActorContentState,
  ActorEquipmentSlotRef,
  ActorType,
  CampaignStatus,
  ContentStatus,
  ContentType,
  EncounterEphemeralKind,
  EncounterLifecycleStatus,
  EncounterOperationKind,
  EncounterParticipantBindingKind,
  EncounterRollKind,
  InventoryEntryKind,
  InventoryInstanceLifecycle,
  Prisma,
} from '../../src/generated/prisma/client.js';
import { createApp } from '../../src/app.js';
import { parseConfig } from '../../src/config/env.js';
import { prismaActorRepository } from '../../src/modules/actors/actors.repository.js';
import { createActorMechanicalState, recomputeActorDerivedSnapshot } from '../../src/modules/actors/actor-mechanics.service.js';
import type { ActorRepository } from '../../src/modules/actors/actors.types.js';
import { prismaContentRepository } from '../../src/modules/content/content.repository.js';
import { publishContentVersion } from '../../src/modules/content/content-publication.service.js';
import { prismaGptRepository } from '../../src/modules/gpt/gpt.repository.js';
import { canonicalize, jsonByteSize } from '../../src/modules/gpt/gpt.start-game.js';
import { prismaReadinessCheck } from '../../src/modules/health/health.repository.js';
import { encounterService } from '../../src/modules/encounters/encounter.service.js';
import { lockActorAuthorities } from '../../src/modules/encounters/encounter.repository.js';
import {
  createCoreV1EncounterSnapshotHash,
  parseCoreV1EncounterSnapshot,
  serializeCoreV1EncounterState,
} from '../../src/modules/encounters/encounter-state-snapshot.js';
import { ensureCoreV1RulesetVersion } from '../../src/modules/rules/ruleset.registry.js';
import { CORE_V1_CONFIG_HASH, CORE_V1_CONFIG_SNAPSHOT } from '../../src/modules/rules/core-v1/core-v1.manifest.js';
import {
  calculateSecondaryAttributes,
  createCoreV1EmptyEquipmentLoadout,
  getInitialAttributePreset,
} from '../../src/modules/rules/core-v1/index.js';
import { disconnectPrisma, prisma } from '../../src/shared/database/prisma.js';
import { canonicalJson } from '../../src/shared/json/canonical-json.js';

const config = parseConfig(process.env);
const { Client } = pg;
const dependencies = { actorRepository: prismaActorRepository, contentRepository: prismaContentRepository, gptRepository: prismaGptRepository, readiness: prismaReadinessCheck };
const app = createApp(config, dependencies);
const authenticated = (path: string) => request(app).get(path).set('x-rpg-key', config.RPG_API_KEY);
const post = (path: string, body: object) => request(app).post(path).set('x-rpg-key', config.RPG_API_KEY).send({ ...seedScope, ...body });
function bodyRecord(response: { body: unknown }): Record<string, unknown> {
  return response.body !== null && typeof response.body === 'object' ? response.body as Record<string, unknown> : {};
}
function responseErrorMessage(response: { body: unknown }): unknown {
  const error = bodyRecord(response).error;
  return error !== null && typeof error === 'object' ? (error as Record<string, unknown>).message : undefined;
}
const seedScope = { playerRef: 'ralph', worldRef: 'elarion', campaignRef: 'main-campaign' };
const seedScopeQuery = 'playerRef=ralph&worldRef=elarion&campaignRef=main-campaign';
const balancedPrimaryAttributes = getInitialAttributePreset('balanced');

type PostgreSqlClient = InstanceType<typeof Client>;
type ActorIdentityField = 'code' | 'campaignId';

async function openPostgreSqlClient(applicationName: string): Promise<PostgreSqlClient> {
  const client = new Client({ connectionString: config.DATABASE_URL, application_name: applicationName });
  await client.connect();
  return client;
}

async function waitForPostgreSqlLock(observer: PostgreSqlClient, applicationName: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await observer.query<{ wait_event_type: string | null }>(`
      SELECT wait_event_type
      FROM pg_stat_activity
      WHERE application_name = $1
    `, [applicationName]);
    if (result.rows[0]?.wait_event_type === 'Lock') return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Expected PostgreSQL transaction to wait on a row lock');
}

async function sessionTimeouts(client: PostgreSqlClient): Promise<{ lock: string; statement: string }> {
  const lock = await client.query<{ lock_timeout: string }>('SHOW lock_timeout');
  const statement = await client.query<{ statement_timeout: string }>('SHOW statement_timeout');
  return {
    lock: lock.rows[0]?.lock_timeout ?? '',
    statement: statement.rows[0]?.statement_timeout ?? '',
  };
}

async function setLocalConcurrencyTimeouts(client: PostgreSqlClient): Promise<void> {
  await client.query("SET LOCAL lock_timeout = '2s'");
  await client.query("SET LOCAL statement_timeout = '5s'");
}

async function insertPersistedParticipant(
  client: PostgreSqlClient,
  encounterId: string,
  actorId: string,
  actorRef: string,
): Promise<void> {
  await client.query(`
    INSERT INTO "EncounterParticipant" (
      "id", "encounterId", "actorId", "actorRef", "bindingKind",
      "initialMechanicsStateVersion", "initialInventoryStateVersion", "initialEffectsStateVersion"
    ) VALUES ($1, $2, $3, $4, 'PERSISTED_ACTOR', 1, 1, 1)
  `, [randomUUID(), encounterId, actorId, actorRef]);
}

function updateActorIdentity(
  client: PostgreSqlClient,
  field: ActorIdentityField,
  actorId: string,
  value: string,
): Promise<pg.QueryResult> {
  return field === 'code'
    ? client.query('UPDATE "Actor" SET "code" = $2 WHERE "id" = $1', [actorId, value])
    : client.query('UPDATE "Actor" SET "campaignId" = $2 WHERE "id" = $1', [actorId, value]);
}

async function expectNoInconsistentEncounterParticipants(): Promise<void> {
  const inconsistent = await prisma.$queryRaw<Array<{ count: number }>>`
    SELECT COUNT(*)::integer AS count
    FROM "EncounterParticipant" participant
    JOIN "Encounter" encounter ON encounter."id" = participant."encounterId"
    LEFT JOIN "Actor" actor ON actor."id" = participant."actorId"
    WHERE participant."bindingKind" = 'PERSISTED_ACTOR'
      AND (
        actor."id" IS NULL
        OR actor."campaignId" IS DISTINCT FROM encounter."campaignId"
        OR actor."code" IS DISTINCT FROM participant."actorRef"
      )
  `;
  expect(inconsistent).toEqual([{ count: 0 }]);
}

interface EncounterConcurrencyClients {
  readonly first: PostgreSqlClient;
  readonly second: PostgreSqlClient;
  readonly readerOne: PostgreSqlClient;
  readonly readerTwo: PostgreSqlClient;
  readonly secondApplicationName: string;
}

async function withEncounterConcurrencyClients(
  label: string,
  run: (clients: EncounterConcurrencyClients) => Promise<void>,
): Promise<void> {
  const secondApplicationName = `${label}-second`;
  const [first, second, readerOne, readerTwo] = await Promise.all([
    openPostgreSqlClient(`${label}-first`),
    openPostgreSqlClient(secondApplicationName),
    openPostgreSqlClient(`${label}-reader-1`),
    openPostgreSqlClient(`${label}-reader-2`),
  ]);
  const clients = [first, second, readerOne, readerTwo];
  try {
    await run({ first, second, readerOne, readerTwo, secondApplicationName });
  } finally {
    for (const client of clients) {
      try { await client.query('ROLLBACK'); } catch { /* connection cleanup is best-effort */ }
      await client.end();
    }
  }
}

const inventorySpecBase = {
  schemaVersion: 1 as const,
  rulesetCode: 'core-v1' as const,
  inventoryRulesCode: 'core-v1-inventory-v1' as const,
};

function uniqueInventorySpec(unitWeight = 10, physical?: Record<string, unknown>) {
  return { ...inventorySpecBase, unitWeight, stacking: { mode: 'unique' as const }, ...physical };
}

function stackInventorySpec(unitWeight = 1, maxStack = 20) {
  return { ...inventorySpecBase, unitWeight, stacking: { mode: 'stackable' as const, maxStack } };
}

function canonicalInventorySpec(contentType: string): object | undefined {
  if (contentType === 'weapon') return uniqueInventorySpec(10, { equipmentSlots: ['main_hand', 'off_hand'], handedness: 'two_handed' });
  if (contentType === 'armor') return uniqueInventorySpec(20, { equipmentSlots: ['chest'] });
  if (contentType === 'shield') return uniqueInventorySpec(15, { equipmentSlots: ['off_hand'] });
  if (contentType === 'clothing') return uniqueInventorySpec(5);
  if (contentType === 'consumable' || contentType === 'material') return stackInventorySpec();
  return undefined;
}

async function createMechanicalActor(input: {
  campaignId: string;
  code: string;
  name: string;
  actorType: ActorType;
  level?: number;
}) {
  return prisma.$transaction(async (transaction) => {
    const actor = await transaction.actor.create({ data: input });
    await createActorMechanicalState(transaction, { actorId: actor.id, primaryAttributes: balancedPrimaryAttributes });
    return actor;
  });
}

function weaponProfile(code: string, name: string, description = 'Arma inicial.') {
  return {
    schemaVersion: 1 as const, rulesetCode: 'core-v1' as const, profileMode: 'mechanical' as const,
    contentKind: 'weapon' as const, code, name, description, presentation: {}, tags: ['weapon'],
    tier: 1, rarity: 'common' as const, activation: { type: 'active' as const }, cost: { type: 'none' as const },
    actionProfile: 'normal' as const, targeting: { type: 'single_target' as const, rangeBand: 'near' as const, maxTargets: 1 },
    damageComponents: [{ id: `${code}-physical`, channel: 'physical' as const, element: null, baseDamage: 4, scaling: 'full' as const, canCrit: true }],
    handedness: 'two_handed' as const, weaponTags: ['weapon'],
  };
}

function passiveProfile(contentKind: 'talent' | 'class', code: string, name: string) {
  return {
    schemaVersion: 1 as const, rulesetCode: 'core-v1' as const, profileMode: 'mechanical' as const,
    contentKind, code, name, tier: 1, rarity: 'common' as const,
    activation: { type: 'passive' as const }, cost: { type: 'none' as const },
    ...(contentKind === 'class'
      ? { grants: [{ contentKind: 'skill' as const, code: 'quiet_step' }] }
      : { passiveModifiers: [{ target: 'accuracy' as const, amount: 1, sourceRule: 'content_intrinsic' as const }] }),
  };
}

function activeProfile(contentKind: 'skill' | 'spell', code: string, name: string, requirements?: Record<string, unknown>) {
  return {
    schemaVersion: 1 as const, rulesetCode: 'core-v1' as const, profileMode: 'mechanical' as const,
    contentKind, code, name, tier: 1, rarity: 'common' as const,
    activation: { type: 'active' as const }, cost: { type: 'sp' as const, amount: 3 }, actionProfile: 'quick' as const,
    effects: [{ type: 'movement' as const, from: 'near' as const, to: 'engaged' as const, maximumTransitions: 1 }],
    ...(requirements === undefined ? {} : { requirements }),
  };
}

function canonicalProfile(contentKind: string, code: string, name: string): unknown {
  const identity = { schemaVersion: 1, rulesetCode: 'core-v1', profileMode: 'mechanical', contentKind, code, name };
  const passive = { tier: 1, rarity: 'common', activation: { type: 'passive' }, cost: { type: 'none' } };
  if (contentKind === 'weapon') return weaponProfile(code, name, 'Canonical test content.');
  if (contentKind === 'spell' || contentKind === 'skill') return activeProfile(contentKind, code, name);
  if (contentKind === 'armor') return { ...identity, ...passive, defense: { physicalFlatDefense: 3 }, equipmentSlots: ['chest'] };
  if (contentKind === 'shield') return { ...identity, ...passive, rarity: 'uncommon', defense: { blockValue: 3 }, equipmentSlots: ['off_hand'], effects: [{ type: 'grant_reaction', reactionKind: 'block', reactionDepth: 1 }] };
  if (contentKind === 'clothing') return { ...identity, profileMode: 'narrative' };
  if (contentKind === 'talent') return { ...identity, ...passive, passiveModifiers: [{ target: 'accuracy', amount: 1, sourceRule: 'content_intrinsic' }] };
  if (contentKind === 'item') return { ...identity, ...passive, passiveModifiers: [{ target: 'carryingCapacity', amount: 10, sourceRule: 'equipped_content' }] };
  if (contentKind === 'consumable') return {
    ...identity, tier: 1, rarity: 'common', activation: { type: 'active' }, cost: { type: 'none' },
    actionProfile: 'normal', consumable: true,
    effects: [{ type: 'restore_resource', resource: 'hp', amount: 20, targeting: { type: 'self', rangeBand: 'self' } }],
  };
  if (contentKind === 'status_effect') return {
    ...identity, ...passive, duration: { type: 'actions', value: 2 }, stacking: { type: 'refresh' },
    passiveModifiers: [{ target: 'attackSpeedBps', amount: -100, sourceRule: 'status_effect' }],
  };
  if (contentKind === 'race') return { ...identity, ...passive, passiveModifiers: [{ target: 'vitality', amount: 1, sourceRule: 'content_intrinsic' }] };
  if (contentKind === 'class') return { ...identity, ...passive, grants: [{ contentKind: 'skill', code: 'canonical_skill' }] };
  if (contentKind === 'creature_template') return {
    ...identity, ...passive,
    template: { role: 'standard', primaryAttributeBudget: 81, contentRefs: [{ contentKind: 'skill', code: 'canonical_skill' }], tags: ['test'], limits: { maxContentRefs: 4, maxActiveAbilities: 2 } },
  };
  throw new Error(`Unsupported canonical fixture: ${contentKind}`);
}

async function publishTestContent(input: {
  worldId: string; campaignId?: string | null; contentType: ContentType; code: string; name: string;
  description?: string | null; profile?: unknown; inventorySpec?: unknown; tags?: readonly string[]; status?: ContentStatus;
}) {
  return prisma.$transaction((transaction) => publishContentVersion(transaction, {
    worldId: input.worldId, campaignId: input.campaignId ?? null, contentType: input.contentType,
    code: input.code, name: input.name, description: input.description ?? null, profile: input.profile, inventorySpec: input.inventorySpec,
    presentation: {}, tags: input.tags ?? [], status: input.status ?? ContentStatus.ACTIVE, metadata: {},
  }));
}

function structuredStart(prefix: string, genre = 'fantasy') {
  const cyberpunk = genre === 'cyberpunk';
  return {
    idempotencyKey: `integration-start-${prefix}-001`, playerMode: 'create', playerRef: `${prefix}-player`, playerDisplayName: `${prefix} Player`,
    worldMode: 'create', worldRef: `${prefix}-world`, worldName: `${prefix} World`, worldDescription: cyberpunk ? 'Uma cidade tecnológica.' : 'Um reino fantástico.',
    worldConfiguration: {
      schemaVersion: 1, genres: [genre], setting: cyberpunk ? 'Megacidade vertical.' : 'Reinos e ruínas.', era: cyberpunk ? 'futuro próximo' : 'medieval',
      technologyLevel: { grade: cyberpunk ? 'advanced' : 'preindustrial' }, magicLevel: { grade: cyberpunk ? 'none' : 'high' },
      worldTone: cyberpunk ? ['noir'] : ['heroic'], peoples: cyberpunk ? ['humanos', 'androides'] : ['humanos', 'elfos'],
    },
    campaignRef: `${prefix}-campaign`, campaignName: `${prefix} Campaign`,
    campaignConfiguration: {
      schemaVersion: 1, difficulty: { preset: 'standard', overrides: { opponentCunning: 4 } }, progressionPace: cyberpunk ? 'slow' : 'standard',
      narrativeTone: cyberpunk ? ['noir'] : ['heroic'], focus: cyberpunk ? ['investigation'] : ['exploration'], playerFreedom: 'open', consequenceLevel: 'serious',
      classModel: { mode: 'none', startingClass: 'unassigned', progressionBasis: ['content', 'proficiencies'], description: 'Progressão por conteúdos.' },
    },
    protagonist: {
      code: `${prefix}-player`, name: `${prefix} Hero`, actorType: 'character', className: null,
      primaryAttributes: balancedPrimaryAttributes, appearance: { summary: cyberpunk ? 'Jaqueta urbana.' : 'Manto de viagem.' },
      personality: { traits: cyberpunk ? ['cético'] : ['curioso'] }, origin: { label: 'Sobrevivente', summary: 'Sobreviveu a um acontecimento incomum.' },
    },
    initialContentPackages: [{
      definition: {
        mode: 'create', scope: 'world', contentType: 'weapon', code: cyberpunk ? 'smart-pistol' : 'longbow', name: cyberpunk ? 'Pistola Inteligente' : 'Arco Longo',
        description: 'Arma inicial.', profile: weaponProfile(cyberpunk ? 'smart-pistol' : 'longbow', cyberpunk ? 'Pistola Inteligente' : 'Arco Longo'),
        inventorySpec: uniqueInventorySpec(10, { equipmentSlots: ['main_hand', 'off_hand'], handedness: 'two_handed' }),
        presentation: {}, tags: ['weapon'], status: 'active', metadata: {},
      },
      protagonistLink: { state: 'known', rank: 0, progress: 0, mastery: 0, metadata: { slotHint: 'hands' } },
    }],
    initialInventory: [{
      scope: 'world', contentType: 'weapon', code: cyberpunk ? 'smart-pistol' : 'longbow', quantity: 1,
      entryRefs: [`${cyberpunk ? 'smart-pistol' : 'longbow'}-1`], equip: { targetSlotRef: 'main_hand' },
    }],
    initialPremise: cyberpunk ? 'Um sinal clandestino chega ao protagonista.' : 'Um dragão desperta além da fronteira.',
  };
}

function campaignInNewWorld(prefix: string, initialContentPackages: object[] = []) {
  const body = structuredStart(prefix);
  return {
    ...body, playerMode: 'reuse', playerRef: 'new-player', playerDisplayName: undefined,
    worldMode: 'reuse', worldRef: 'new-world', worldName: undefined, worldDescription: undefined, worldConfiguration: undefined,
    protagonist: { ...body.protagonist, code: 'new-player' }, initialContentPackages, initialInventory: [],
  };
}

async function expectNoCreatedIntent(body: { playerRef: string; worldRef: string; campaignRef: string; idempotencyKey: string }) {
  const [players, worlds, campaigns, actors, attributes, resources, snapshots, definitions, links, events, idempotency] = await Promise.all([
    prisma.player.count({ where: { slug: body.playerRef } }),
    prisma.world.count({ where: { code: body.worldRef, player: { slug: body.playerRef } } }),
    prisma.campaign.count({ where: { code: body.campaignRef, world: { code: body.worldRef, player: { slug: body.playerRef } } } }),
    prisma.actor.count({ where: { campaign: { code: body.campaignRef, world: { code: body.worldRef, player: { slug: body.playerRef } } } } }),
    prisma.actorAttribute.count({ where: { actor: { campaign: { code: body.campaignRef, world: { code: body.worldRef } } } } }),
    prisma.actorResource.count({ where: { actor: { campaign: { code: body.campaignRef, world: { code: body.worldRef } } } } }),
    prisma.actorDerivedSnapshot.count({ where: { actor: { campaign: { code: body.campaignRef, world: { code: body.worldRef } } } } }),
    prisma.contentDefinition.count({ where: { world: { code: body.worldRef, player: { slug: body.playerRef } } } }),
    prisma.actorContent.count({ where: { actor: { campaign: { code: body.campaignRef, world: { code: body.worldRef, player: { slug: body.playerRef } } } } } }),
    prisma.gameEvent.count({ where: { campaign: { code: body.campaignRef, world: { code: body.worldRef, player: { slug: body.playerRef } } } } }),
    prisma.idempotencyRecord.count({ where: { key: body.idempotencyKey } }),
  ]);
  expect({ players, worlds, campaigns, actors, attributes, resources, snapshots, definitions, links, events, idempotency }).toEqual({
    players: 0, worlds: 0, campaigns: 0, actors: 0, attributes: 0, resources: 0, snapshots: 0,
    definitions: 0, links: 0, events: 0, idempotency: 0,
  });
}

async function createAlternateRulesetVersion(suffix: string) {
  const ruleset = await prisma.ruleset.create({ data: { code: `test-${suffix}`, name: `Test ${suffix}` } });
  return prisma.rulesetVersion.create({
    data: {
      rulesetId: ruleset.id, code: `test-${suffix}-v1`, revision: 'TEST', schemaVersion: 1,
      configHash: '0'.repeat(64), configSnapshot: { testVersion: suffix },
    },
  });
}

async function createEncounterFixture(
  suffix: string,
  lifecycleStatus: EncounterLifecycleStatus = EncounterLifecycleStatus.AWAITING_INTENT,
) {
  const rulesetVersion = await prisma.$transaction((transaction) => ensureCoreV1RulesetVersion(transaction));
  const player = await prisma.player.create({
    data: { slug: `encounter-${suffix}-player`, displayName: `Encounter ${suffix} Player` },
  });
  const world = await prisma.world.create({
    data: {
      playerId: player.id,
      defaultRulesetVersionId: rulesetVersion.id,
      code: `encounter-${suffix}-world`,
      name: `Encounter ${suffix} World`,
    },
  });
  const campaign = await prisma.campaign.create({
    data: {
      worldId: world.id,
      rulesetVersionId: rulesetVersion.id,
      code: `encounter-${suffix}-campaign`,
      name: `Encounter ${suffix} Campaign`,
      status: CampaignStatus.ACTIVE,
    },
  });
  const actor = await createMechanicalActor({
    campaignId: campaign.id,
    code: `encounter-${suffix}-actor`,
    name: `Encounter ${suffix} Actor`,
    actorType: ActorType.CHARACTER,
  });
  const encounter = await prisma.encounter.create({
    data: {
      campaignId: campaign.id,
      rulesetVersionId: rulesetVersion.id,
      encounterRef: `encounter-${suffix}`,
      lifecycleStatus,
      stateVersion: 1,
      currentTick: 0n,
      snapshotSchemaVersion: 1,
      stateSnapshot: { snapshotSchemaVersion: 1, fixture: suffix },
      stateHash: 'a'.repeat(64),
    },
  });
  return { rulesetVersion, player, world, campaign, actor, encounter };
}

afterAll(async () => {
  await disconnectPrisma();
});

describe('migration and PostgreSQL schema', () => {
  it('records the initial migration as successfully applied', async () => {
    const rows = await prisma.$queryRaw<Array<{ migration_name: string; finished_at: Date | null }>>`
      SELECT migration_name, finished_at FROM "_prisma_migrations" WHERE rolled_back_at IS NULL
    `;
    const migration = rows.find((row) => row.migration_name === '20260711183000_init');
    expect(migration?.finished_at).toBeInstanceOf(Date);
  });

  it('records the production GPT security migration as successfully applied', async () => {
    const migration = await prisma.$queryRaw<Array<{ finished_at: Date | null }>>`
      SELECT finished_at FROM "_prisma_migrations"
      WHERE migration_name = '20260711223000_production_gpt_security' AND rolled_back_at IS NULL
    `;
    expect(migration[0]?.finished_at).toBeInstanceOf(Date);
  });

  it('records the Phase 1C ruleset persistence migration as successfully applied', async () => {
    const migration = await prisma.$queryRaw<Array<{ finished_at: Date | null }>>`
      SELECT finished_at FROM "_prisma_migrations"
      WHERE migration_name = '20260713174337_engine_v1_ruleset_persistence' AND rolled_back_at IS NULL
    `;
    expect(migration[0]?.finished_at).toBeInstanceOf(Date);
  });

  it('records the Phase 1D actor mechanics migration as successfully applied', async () => {
    const migration = await prisma.$queryRaw<Array<{ finished_at: Date | null }>>`
      SELECT finished_at FROM "_prisma_migrations"
      WHERE migration_name = '20260713190000_engine_v1_actor_mechanics' AND rolled_back_at IS NULL
    `;
    expect(migration[0]?.finished_at).toBeInstanceOf(Date);
  });

  it('records the Phase 1F content versioning migration as successfully applied', async () => {
    const migration = await prisma.$queryRaw<Array<{ finished_at: Date | null }>>`
      SELECT finished_at FROM "_prisma_migrations"
      WHERE migration_name = '20260713230000_engine_v1_content_versioning' AND rolled_back_at IS NULL
    `;
    expect(migration[0]?.finished_at).toBeInstanceOf(Date);
  });

  it('records the Phase 1H inventory persistence migration as successfully applied', async () => {
    const migration = await prisma.$queryRaw<Array<{ finished_at: Date | null }>>`
      SELECT finished_at FROM "_prisma_migrations"
      WHERE migration_name = '20260714010000_engine_v1_inventory_persistence' AND rolled_back_at IS NULL
    `;
    expect(migration[0]?.finished_at).toBeInstanceOf(Date);
  });

  it('records the Phase 1J effect persistence migration as successfully applied', async () => {
    const migration = await prisma.$queryRaw<Array<{ finished_at: Date | null }>>`
      SELECT finished_at FROM "_prisma_migrations"
      WHERE migration_name = '20260714030000_engine_v1_effects_persistence' AND rolled_back_at IS NULL
    `;
    expect(migration[0]?.finished_at).toBeInstanceOf(Date);
  });

  it('records the Phase 1L-A encounter persistence migration as successfully applied', async () => {
    const migration = await prisma.$queryRaw<Array<{ finished_at: Date | null }>>`
      SELECT finished_at FROM "_prisma_migrations"
      WHERE migration_name = '20260714120000_add_encounter_persistence' AND rolled_back_at IS NULL
    `;
    expect(migration[0]?.finished_at).toBeInstanceOf(Date);
  });

  it('contains every principal table', async () => {
    const rows = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('Player', 'Ruleset', 'RulesetVersion', 'InventoryRulesVersion', 'EffectRulesVersion', 'World', 'Campaign', 'Actor', 'ActorAttribute', 'ActorResource', 'ActorDerivedSnapshot', 'ContentDefinition', 'ContentProfileVersion', 'ContentVersion', 'ContentEffectBinding', 'ActorContent', 'InventoryEntry', 'ActorEquipmentSlot', 'ActiveEffect', 'EffectResolution', 'EffectRoll', 'GameEvent', 'IdempotencyRecord', 'Encounter', 'EncounterParticipant', 'EncounterOperation', 'EncounterRoll')
    `;
    expect(rows.map((row) => row.table_name).sort()).toEqual(['ActiveEffect', 'Actor', 'ActorAttribute', 'ActorContent', 'ActorDerivedSnapshot', 'ActorEquipmentSlot', 'ActorResource', 'Campaign', 'ContentDefinition', 'ContentEffectBinding', 'ContentProfileVersion', 'ContentVersion', 'EffectResolution', 'EffectRoll', 'EffectRulesVersion', 'Encounter', 'EncounterOperation', 'EncounterParticipant', 'EncounterRoll', 'GameEvent', 'IdempotencyRecord', 'InventoryEntry', 'InventoryRulesVersion', 'Player', 'Ruleset', 'RulesetVersion', 'World']);
  });

  it('contains the principal foreign keys', async () => {
    const rows = await prisma.$queryRaw<Array<{ constraint_name: string }>>`
      SELECT constraint_name FROM information_schema.table_constraints
      WHERE constraint_schema = 'public' AND constraint_type = 'FOREIGN KEY'
    `;
    expect(rows.map((row) => row.constraint_name)).toEqual(expect.arrayContaining([
      'World_playerId_fkey', 'Campaign_worldId_fkey', 'Actor_campaignId_fkey',
      'RulesetVersion_rulesetId_fkey', 'World_defaultRulesetVersionId_fkey', 'Campaign_rulesetVersionId_fkey',
      'ActorAttribute_actorId_fkey', 'ActorResource_actorId_fkey',
      'ActorDerivedSnapshot_actorId_fkey', 'ActorDerivedSnapshot_rulesetVersionId_fkey',
      'ActorContent_actorId_fkey', 'ActorContent_contentDefinitionId_fkey',
      'ContentProfileVersion_rulesetVersionId_fkey', 'ContentVersion_contentDefinitionId_fkey',
      'ContentVersion_rulesetVersionId_fkey', 'ContentVersion_contentProfileVersionId_fkey',
      'ActorContent_contentVersionId_contentDefinitionId_fkey',
      'InventoryRulesVersion_rulesetVersionId_fkey', 'ContentVersion_inventoryRulesVersionId_fkey',
      'InventoryEntry_actorId_fkey', 'InventoryEntry_contentVersionId_fkey', 'InventoryEntry_inventoryRulesVersionId_fkey',
      'ActorEquipmentSlot_actorId_fkey', 'ActorEquipmentSlot_inventoryEntryId_actorId_fkey',
      'EffectRulesVersion_rulesetVersionId_fkey', 'ContentEffectBinding_sourceContentVersionId_fkey',
      'ContentEffectBinding_targetContentDefinitionId_fkey', 'ContentEffectBinding_targetContentVersionId_targetContentD_fkey',
      'ActiveEffect_targetActorId_fkey', 'ActiveEffect_sourceActorId_fkey', 'ActiveEffect_sourceContentVersionId_fkey',
      'ActiveEffect_effectContentVersionId_fkey', 'ActiveEffect_effectRulesVersionId_fkey',
      'EffectResolution_campaignId_fkey', 'EffectResolution_sourceActorId_fkey', 'EffectResolution_targetActorId_fkey',
      'EffectResolution_sourceContentVersionId_fkey', 'EffectResolution_effectRulesVersionId_fkey',
      'EffectRoll_effectResolutionId_fkey',
      'Encounter_campaignId_fkey', 'Encounter_rulesetVersionId_fkey',
      'EncounterParticipant_encounterId_fkey', 'EncounterParticipant_actorId_fkey',
      'EncounterOperation_encounterId_fkey', 'EncounterOperation_idempotencyRecordId_fkey',
      'EncounterRoll_encounterId_fkey', 'EncounterRoll_encounterOperationId_encounterId_fkey',
    ]));
  });

  it('installs Phase 1L-A checks, partial uniqueness and append-only triggers', async () => {
    const constraints = await prisma.$queryRaw<Array<{ conname: string }>>`
      SELECT conname FROM pg_constraint WHERE conname IN (
        'Encounter_stateVersion_check', 'Encounter_currentTick_check',
        'Encounter_snapshotSchemaVersion_check', 'Encounter_stateSnapshot_check',
        'EncounterParticipant_binding_check', 'EncounterOperation_stateVersionSequence_check',
        'EncounterRoll_ordinal_check', 'EncounterRoll_targetOrdinal_check'
      )
    `;
    expect(constraints).toHaveLength(8);
    const indexes = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'Encounter_one_open_per_campaign_key'
    `;
    expect(indexes).toHaveLength(1);
    expect(indexes[0]?.indexdef).toContain('WHERE ("lifecycleStatus" = ANY');
    const triggers = await prisma.$queryRaw<Array<{ tgname: string }>>`
      SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname IN (
        'Encounter_validate_ruleset', 'Encounter_reject_scope_change', 'EncounterParticipant_validate_actor',
        'Actor_reject_encounter_binding_change',
        'EncounterParticipant_reject_update', 'EncounterOperation_reject_update',
        'EncounterRoll_reject_update'
      )
    `;
    expect(triggers).toHaveLength(7);
  });

  it('installs Phase 1J clocks, optimistic versions, constraints and immutable triggers', async () => {
    const columns = await prisma.$queryRaw<Array<{ table_name: string; column_name: string; column_default: string | null }>>`
      SELECT table_name, column_name, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND (table_name, column_name) IN (
        ('Campaign', 'engineTick'), ('Campaign', 'engineStateVersion'),
        ('Actor', 'effectsStateVersion'), ('ActorDerivedSnapshot', 'effectsStateVersion'),
        ('ContentVersion', 'effectBindingHash')
      )
    `;
    expect(columns).toHaveLength(5);
    expect(columns.find((column) => column.table_name === 'Actor' && column.column_name === 'effectsStateVersion')?.column_default).toContain('1');
    const constraints = await prisma.$queryRaw<Array<{ conname: string }>>`
      SELECT conname FROM pg_constraint WHERE conname IN (
        'ActiveEffect_duration_check', 'ActiveEffect_kind_content_check', 'ActiveEffect_stacks_check',
        'EffectRoll_rollBps_check', 'EffectRoll_chanceBps_check',
        'EffectResolution_resultSnapshot_check', 'ContentVersion_effectBindingHash_check'
      )
    `;
    expect(constraints).toHaveLength(7);
    const triggers = await prisma.$queryRaw<Array<{ tgname: string }>>`
      SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname IN (
        'EffectRulesVersion_reject_update', 'ContentEffectBinding_reject_update',
        'EffectResolution_reject_update', 'EffectRoll_reject_update',
        'ActiveEffect_validate_write'
      )
    `;
    expect(triggers).toHaveLength(5);
  });

  it('contains the partial global ContentDefinition index', async () => {
    const rows = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ContentDefinition_global_scope_key'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain('WHERE ("campaignId" IS NULL)');
  });

  it('contains partial inventory-spec deduplication indexes', async () => {
    const rows = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname IN ('ContentVersion_without_inventory_spec_key', 'ContentVersion_with_inventory_spec_key')
    `;
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.indexname === 'ContentVersion_without_inventory_spec_key')?.indexdef).toContain('"inventorySpecHash" IS NULL');
    expect(rows.find((row) => row.indexname === 'ContentVersion_with_inventory_spec_key')?.indexdef).toContain('"inventorySpecHash" IS NOT NULL');
    expect(rows.every((row) => row.indexdef.includes('"effectBindingHash"'))).toBe(true);
  });

  it('enables RLS without public policies on every Node platform table', async () => {
    const tables = await prisma.$queryRaw<Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>>`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN ('Player', 'Ruleset', 'RulesetVersion', 'InventoryRulesVersion', 'EffectRulesVersion', 'World', 'Campaign', 'Actor', 'ActorAttribute', 'ActorResource', 'ActorDerivedSnapshot', 'ContentDefinition', 'ContentProfileVersion', 'ContentVersion', 'ContentEffectBinding', 'ActorContent', 'InventoryEntry', 'ActorEquipmentSlot', 'ActiveEffect', 'EffectResolution', 'EffectRoll', 'GameEvent', 'IdempotencyRecord', 'Encounter', 'EncounterParticipant', 'EncounterOperation', 'EncounterRoll')
    `;
    expect(tables).toHaveLength(27);
    expect(tables.every((table) => table.relrowsecurity)).toBe(true);
    expect(tables.every((table) => !table.relforcerowsecurity)).toBe(true);
    await expect(prisma.$queryRaw<Array<{ tablename: string }>>`SELECT tablename::text FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('Player', 'Ruleset', 'RulesetVersion', 'InventoryRulesVersion', 'EffectRulesVersion', 'World', 'Campaign', 'Actor', 'ActorAttribute', 'ActorResource', 'ActorDerivedSnapshot', 'ContentDefinition', 'ContentProfileVersion', 'ContentVersion', 'ContentEffectBinding', 'ActorContent', 'InventoryEntry', 'ActorEquipmentSlot', 'ActiveEffect', 'EffectResolution', 'EffectRoll', 'GameEvent', 'IdempotencyRecord', 'Encounter', 'EncounterParticipant', 'EncounterOperation', 'EncounterRoll')`).resolves.toHaveLength(0);
  });

  it('does not grant table privileges to PUBLIC', async () => {
    const rows = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) privilege
      WHERE n.nspname = 'public'
        AND c.relname IN ('Player', 'Ruleset', 'RulesetVersion', 'InventoryRulesVersion', 'EffectRulesVersion', 'World', 'Campaign', 'Actor', 'ActorAttribute', 'ActorResource', 'ActorDerivedSnapshot', 'ContentDefinition', 'ContentProfileVersion', 'ContentVersion', 'ContentEffectBinding', 'ActorContent', 'InventoryEntry', 'ActorEquipmentSlot', 'ActiveEffect', 'EffectResolution', 'EffectRoll', 'GameEvent', 'IdempotencyRecord', 'Encounter', 'EncounterParticipant', 'EncounterOperation', 'EncounterRoll')
        AND privilege.grantee = 0
    `;
    expect(rows[0]?.count).toBe(0);
  });

  it('removes legacy Actor columns and installs authoritative mechanics constraints', async () => {
    const legacyColumns = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'Actor'
        AND column_name IN ('health', 'maxHealth', 'mana', 'maxMana', 'attributes', 'resistances', 'affinities')
    `;
    expect(legacyColumns).toHaveLength(0);
    const constraints = await prisma.$queryRaw<Array<{ constraint_name: string }>>`
      SELECT constraint_name FROM information_schema.table_constraints
      WHERE constraint_schema = 'public'
        AND constraint_name IN ('ActorAttribute_effective_cap_check', 'ActorResource_current_check', 'ActorDerivedSnapshot_inputHash_check')
    `;
    expect(constraints.map((item) => item.constraint_name).sort()).toEqual([
      'ActorAttribute_effective_cap_check', 'ActorDerivedSnapshot_inputHash_check', 'ActorResource_current_check',
    ]);
  });

  it('keeps conditional Supabase revocations compatible when local roles do not exist', async () => {
    const roles = await prisma.$queryRaw<Array<{ rolname: string }>>`SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')`;
    expect(roles.map((role) => role.rolname).every((role) => ['anon', 'authenticated'].includes(role))).toBe(true);
    await expect(prisma.player.count()).resolves.toBeGreaterThanOrEqual(1);
  });
});

function encounterPersistenceConstraintTests(): void {
describe('encounter persistence constraints', () => {
  it('allows one open encounter per Campaign, multiple final encounters and unique refs per Campaign', async () => {
    const fixture = await createEncounterFixture('open-unique');
    const common = {
      campaignId: fixture.campaign.id,
      rulesetVersionId: fixture.rulesetVersion.id,
      stateVersion: 1,
      currentTick: 0n,
      snapshotSchemaVersion: 1,
      stateSnapshot: { snapshotSchemaVersion: 1 },
      stateHash: 'b'.repeat(64),
    };
    await expect(prisma.encounter.create({
      data: { ...common, encounterRef: 'second-open', lifecycleStatus: EncounterLifecycleStatus.PROCESSING_PAUSED },
    })).rejects.toMatchObject({ code: 'P2002' });

    await expect(prisma.encounter.create({
      data: { ...common, encounterRef: 'completed-one', lifecycleStatus: EncounterLifecycleStatus.COMPLETED },
    })).resolves.toBeTruthy();
    await expect(prisma.encounter.create({
      data: { ...common, encounterRef: 'failed-two', lifecycleStatus: EncounterLifecycleStatus.FAILED },
    })).resolves.toBeTruthy();
    await expect(prisma.encounter.create({
      data: { ...common, encounterRef: 'completed-one', lifecycleStatus: EncounterLifecycleStatus.CANCELLED },
    })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('rejects moving an Encounter with a persisted participant to another Campaign using the same RulesetVersion', async () => {
    const fixture = await createEncounterFixture('scope-participant');
    const target = await createEncounterFixture('scope-participant-target');
    await prisma.encounterParticipant.create({
      data: {
        encounterId: fixture.encounter.id,
        actorId: fixture.actor.id,
        actorRef: fixture.actor.code,
        bindingKind: EncounterParticipantBindingKind.PERSISTED_ACTOR,
        initialMechanicsStateVersion: 1,
        initialInventoryStateVersion: 1,
        initialEffectsStateVersion: 1,
      },
    });

    await expect(prisma.encounter.update({
      where: { id: fixture.encounter.id }, data: { campaignId: target.campaign.id },
    })).rejects.toThrow(/identity is immutable/);
  });

  it('rejects replacing both Encounter scope identities with another valid Campaign and RulesetVersion pair', async () => {
    const fixture = await createEncounterFixture('scope-pair');
    const alternateRulesetVersion = await createAlternateRulesetVersion('encounter-scope-pair');
    const alternateCampaign = await prisma.campaign.create({
      data: {
        worldId: fixture.world.id,
        rulesetVersionId: alternateRulesetVersion.id,
        code: 'encounter-scope-pair-target',
        name: 'Encounter Scope Pair Target',
        status: CampaignStatus.ACTIVE,
      },
    });

    await expect(prisma.encounter.update({
      where: { id: fixture.encounter.id },
      data: { campaignId: alternateCampaign.id, rulesetVersionId: alternateRulesetVersion.id },
    })).rejects.toThrow(/identity is immutable/);
  });

  it('rejects moving an Encounter without participants to another Campaign', async () => {
    const fixture = await createEncounterFixture('scope-empty');
    const target = await createEncounterFixture('scope-empty-target');

    await expect(prisma.encounter.update({
      where: { id: fixture.encounter.id }, data: { campaignId: target.campaign.id },
    })).rejects.toThrow(/identity is immutable/);
  });

  it('allows normal Encounter state updates and scope updates that keep both identities unchanged', async () => {
    const fixture = await createEncounterFixture('scope-normal');
    await expect(prisma.encounter.update({
      where: { id: fixture.encounter.id },
      data: {
        lifecycleStatus: EncounterLifecycleStatus.PROCESSING_PAUSED,
        stateVersion: 2,
        currentTick: 1n,
        stateSnapshot: { snapshotSchemaVersion: 1, updated: true },
        stateHash: 'b'.repeat(64),
      },
    })).resolves.toMatchObject({
      lifecycleStatus: EncounterLifecycleStatus.PROCESSING_PAUSED,
      stateVersion: 2,
      currentTick: 1n,
    });
    await expect(prisma.encounter.update({
      where: { id: fixture.encounter.id },
      data: { campaignId: fixture.campaign.id, rulesetVersionId: fixture.rulesetVersion.id },
    })).resolves.toMatchObject({ campaignId: fixture.campaign.id, rulesetVersionId: fixture.rulesetVersion.id });
  });

  it.each([
    ['initialMechanicsStateVersion', 'mechanics'],
    ['initialInventoryStateVersion', 'inventory'],
    ['initialEffectsStateVersion', 'effects'],
  ] as const)('rejects a persisted Actor with %s as NULL', async (missingVersion, slug) => {
    const fixture = await createEncounterFixture(`participant-missing-${slug}`);
    await expect(prisma.encounterParticipant.create({
      data: {
        encounterId: fixture.encounter.id,
        actorId: fixture.actor.id,
        actorRef: `missing-${slug}`,
        bindingKind: EncounterParticipantBindingKind.PERSISTED_ACTOR,
        initialMechanicsStateVersion: missingVersion === 'initialMechanicsStateVersion' ? null : 1,
        initialInventoryStateVersion: missingVersion === 'initialInventoryStateVersion' ? null : 1,
        initialEffectsStateVersion: missingVersion === 'initialEffectsStateVersion' ? null : 1,
      },
    })).rejects.toThrow();
  });

  it('binds persisted Actor refs to the matching Actor code while preserving ephemeral participants', async () => {
    const fixture = await createEncounterFixture('participant-binding');
    const persisted = await prisma.encounterParticipant.create({
      data: {
        encounterId: fixture.encounter.id,
        actorId: fixture.actor.id,
        actorRef: fixture.actor.code,
        bindingKind: EncounterParticipantBindingKind.PERSISTED_ACTOR,
        initialMechanicsStateVersion: fixture.actor.mechanicsStateVersion,
        initialInventoryStateVersion: fixture.actor.inventoryStateVersion,
        initialEffectsStateVersion: fixture.actor.effectsStateVersion,
      },
    });
    expect(persisted.initialMechanicsStateVersion).toBeGreaterThanOrEqual(1);
    expect(persisted.initialInventoryStateVersion).toBeGreaterThanOrEqual(1);
    expect(persisted.initialEffectsStateVersion).toBeGreaterThanOrEqual(1);
    await expect(prisma.encounterParticipant.create({
      data: {
        encounterId: fixture.encounter.id,
        actorId: fixture.actor.id,
        actorRef: fixture.actor.code,
        bindingKind: EncounterParticipantBindingKind.PERSISTED_ACTOR,
        initialMechanicsStateVersion: 1,
        initialInventoryStateVersion: 1,
        initialEffectsStateVersion: 1,
      },
    })).rejects.toMatchObject({ code: 'P2002' });
    const otherActor = await createMechanicalActor({
      campaignId: fixture.campaign.id,
      code: 'participant-binding-other-actor',
      name: 'Participant Binding Other Actor',
      actorType: ActorType.NPC,
    });
    const mismatchedRefError = await prisma.encounterParticipant.create({
      data: {
        encounterId: fixture.encounter.id,
        actorId: fixture.actor.id,
        actorRef: otherActor.code,
        bindingKind: EncounterParticipantBindingKind.PERSISTED_ACTOR,
        initialMechanicsStateVersion: 1,
        initialInventoryStateVersion: 1,
        initialEffectsStateVersion: 1,
      },
    }).then(() => undefined, (error: unknown) => error);
    expect(String(mismatchedRefError)).toContain('Actor must match its Encounter Campaign and actorRef');
    expect(String(mismatchedRefError)).not.toContain(fixture.actor.id);
    expect(String(mismatchedRefError)).not.toContain('SELECT 1');
    await expect(prisma.encounterParticipant.create({
      data: {
        encounterId: fixture.encounter.id,
        actorId: otherActor.id,
        actorRef: 'participant-binding-missing-code',
        bindingKind: EncounterParticipantBindingKind.PERSISTED_ACTOR,
        initialMechanicsStateVersion: 1,
        initialInventoryStateVersion: 1,
        initialEffectsStateVersion: 1,
      },
    })).rejects.toThrow(/Actor must match its Encounter Campaign and actorRef/);
    await expect(prisma.encounterParticipant.create({
      data: {
        encounterId: fixture.encounter.id,
        actorRef: 'invalid-ephemeral',
        bindingKind: EncounterParticipantBindingKind.EPHEMERAL,
      },
    })).rejects.toThrow();
    await expect(prisma.encounterParticipant.create({
      data: {
        encounterId: fixture.encounter.id,
        actorRef: 'summoned-wolf',
        bindingKind: EncounterParticipantBindingKind.EPHEMERAL,
        ephemeralKind: EncounterEphemeralKind.SUMMON,
      },
    })).resolves.toBeTruthy();

    const foreign = await createEncounterFixture('participant-foreign');
    await expect(prisma.encounterParticipant.create({
      data: {
        encounterId: fixture.encounter.id,
        actorId: foreign.actor.id,
        actorRef: foreign.actor.code,
        bindingKind: EncounterParticipantBindingKind.PERSISTED_ACTOR,
        initialMechanicsStateVersion: 1,
        initialInventoryStateVersion: 1,
        initialEffectsStateVersion: 1,
      },
    })).rejects.toThrow(/Actor must match its Encounter Campaign and actorRef/);
  });

  it('prevents referenced Actors from changing their encounter binding identity', async () => {
    const fixture = await createEncounterFixture('participant-actor-identity');
    const target = await createEncounterFixture('participant-actor-identity-target');
    await prisma.encounterParticipant.create({
      data: {
        encounterId: fixture.encounter.id,
        actorId: fixture.actor.id,
        actorRef: fixture.actor.code,
        bindingKind: EncounterParticipantBindingKind.PERSISTED_ACTOR,
        initialMechanicsStateVersion: 1,
        initialInventoryStateVersion: 1,
        initialEffectsStateVersion: 1,
      },
    });

    await expect(prisma.actor.update({
      where: { id: fixture.actor.id }, data: { code: 'participant-actor-identity-renamed' },
    })).rejects.toThrow(/Actor code and Campaign are immutable/);
    await expect(prisma.actor.update({
      where: { id: fixture.actor.id }, data: { campaignId: target.campaign.id },
    })).rejects.toThrow(/Actor code and Campaign are immutable/);
    await expect(prisma.actor.update({
      where: { id: fixture.actor.id },
      data: {
        name: 'Participant Actor Identity Narrative Update',
        mechanicsStateVersion: fixture.actor.mechanicsStateVersion + 1,
      },
    })).resolves.toMatchObject({
      name: 'Participant Actor Identity Narrative Update',
      mechanicsStateVersion: fixture.actor.mechanicsStateVersion + 1,
    });
    await expect(prisma.actor.update({
      where: { id: fixture.actor.id }, data: { code: fixture.actor.code, campaignId: fixture.campaign.id },
    })).resolves.toMatchObject({ code: fixture.actor.code, campaignId: fixture.campaign.id });
  });

  it.each([
    ['code', 'code'],
    ['campaignId', 'campaign'],
  ] as const)('serializes an Actor %s update after a participant insert and rejects the update', async (field, slug) => {
    const fixture = await createEncounterFixture(`participant-lock-insert-${slug}`);
    const target = await createEncounterFixture(`participant-lock-insert-${slug}-target`);
    const newValue = field === 'code' ? `${fixture.actor.code}-changed` : target.campaign.id;

    await withEncounterConcurrencyClients(`1la-i-${slug}`, async ({
      first, second, readerOne, readerTwo, secondApplicationName,
    }) => {
      const firstDefaults = await sessionTimeouts(first);
      const secondDefaults = await sessionTimeouts(second);
      await first.query('BEGIN');
      await second.query('BEGIN');
      await setLocalConcurrencyTimeouts(first);
      await setLocalConcurrencyTimeouts(second);
      await insertPersistedParticipant(first, fixture.encounter.id, fixture.actor.id, fixture.actor.code);

      const pendingUpdate = updateActorIdentity(second, field, fixture.actor.id, newValue).then(
        () => ({ ok: true as const, error: undefined }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await waitForPostgreSqlLock(readerOne, secondApplicationName);
      const reads = await Promise.all([
        readerOne.query<{ code: string }>('SELECT "code" FROM "Actor" WHERE "id" = $1', [fixture.actor.id]),
        readerTwo.query<{ code: string }>('SELECT "code" FROM "Actor" WHERE "id" = $1', [fixture.actor.id]),
      ]);
      expect(reads.map((result) => result.rows[0]?.code)).toEqual([fixture.actor.code, fixture.actor.code]);

      await first.query('COMMIT');
      const update = await pendingUpdate;
      expect(update.ok).toBe(false);
      expect(String(update.error)).toContain('Actor code and Campaign are immutable');
      await second.query('ROLLBACK');
      expect(await sessionTimeouts(first)).toEqual(firstDefaults);
      expect(await sessionTimeouts(second)).toEqual(secondDefaults);
    });

    await expect(prisma.encounterParticipant.count({
      where: { encounterId: fixture.encounter.id, actorId: fixture.actor.id },
    })).resolves.toBe(1);
    await expect(prisma.actor.findUniqueOrThrow({ where: { id: fixture.actor.id } })).resolves.toMatchObject({
      code: fixture.actor.code,
      campaignId: fixture.campaign.id,
    });
    await expectNoInconsistentEncounterParticipants();
  });

  it.each([
    ['code', 'code'],
    ['campaignId', 'campaign'],
  ] as const)('revalidates a participant insert after a concurrent Actor %s update and rejects the insert', async (field, slug) => {
    const fixture = await createEncounterFixture(`participant-lock-update-${slug}`);
    const target = await createEncounterFixture(`participant-lock-update-${slug}-target`);
    const newValue = field === 'code' ? `${fixture.actor.code}-changed` : target.campaign.id;

    await withEncounterConcurrencyClients(`1la-u-${slug}`, async ({
      first, second, readerOne, readerTwo, secondApplicationName,
    }) => {
      const firstDefaults = await sessionTimeouts(first);
      const secondDefaults = await sessionTimeouts(second);
      await first.query('BEGIN');
      await second.query('BEGIN');
      await setLocalConcurrencyTimeouts(first);
      await setLocalConcurrencyTimeouts(second);
      await updateActorIdentity(first, field, fixture.actor.id, newValue);

      const pendingInsert = insertPersistedParticipant(
        second,
        fixture.encounter.id,
        fixture.actor.id,
        fixture.actor.code,
      ).then(
        () => ({ ok: true as const, error: undefined }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await waitForPostgreSqlLock(readerOne, secondApplicationName);
      const reads = await Promise.all([
        readerOne.query<{ code: string }>('SELECT "code" FROM "Actor" WHERE "id" = $1', [fixture.actor.id]),
        readerTwo.query<{ code: string }>('SELECT "code" FROM "Actor" WHERE "id" = $1', [fixture.actor.id]),
      ]);
      expect(reads.map((result) => result.rows[0]?.code)).toEqual([fixture.actor.code, fixture.actor.code]);

      await first.query('COMMIT');
      const insert = await pendingInsert;
      expect(insert.ok).toBe(false);
      expect(String(insert.error)).toContain('Actor must match its Encounter Campaign and actorRef');
      await second.query('ROLLBACK');
      expect(await sessionTimeouts(first)).toEqual(firstDefaults);
      expect(await sessionTimeouts(second)).toEqual(secondDefaults);
    });

    await expect(prisma.encounterParticipant.count({
      where: { encounterId: fixture.encounter.id, actorId: fixture.actor.id },
    })).resolves.toBe(0);
    const actor = await prisma.actor.findUniqueOrThrow({ where: { id: fixture.actor.id } });
    expect(field === 'code' ? actor.code : actor.campaignId).toBe(newValue);
    await expectNoInconsistentEncounterParticipants();
  });

  it('enforces operation sequencing, next-version uniqueness and one use per IdempotencyRecord', async () => {
    const fixture = await createEncounterFixture('operation-sequence');
    const firstIdempotency = await prisma.idempotencyRecord.create({
      data: { key: 'encounter-operation-sequence-001', operation: 'encounter-create', requestHash: 'c'.repeat(64) },
    });
    const operation = await prisma.encounterOperation.create({
      data: {
        encounterId: fixture.encounter.id,
        idempotencyRecordId: firstIdempotency.id,
        operation: EncounterOperationKind.CREATE,
        previousStateVersion: 0,
        nextStateVersion: 1,
        inputHash: 'c'.repeat(64),
        beforeStateHash: 'a'.repeat(64),
        afterStateHash: 'b'.repeat(64),
        resultSummary: { created: true },
      },
    });
    expect(operation.nextStateVersion).toBe(1);

    const invalidIdempotency = await prisma.idempotencyRecord.create({
      data: { key: 'encounter-operation-sequence-002', operation: 'encounter-continue', requestHash: 'd'.repeat(64) },
    });
    const batch = await prisma.encounterOperation.create({
      data: {
        encounterId: fixture.encounter.id,
        idempotencyRecordId: invalidIdempotency.id,
        operation: EncounterOperationKind.CONTINUE,
        previousStateVersion: 1,
        nextStateVersion: 4,
        inputHash: 'd'.repeat(64), beforeStateHash: 'b'.repeat(64), afterStateHash: 'e'.repeat(64),
        resultSummary: {},
      },
    });
    expect(batch.nextStateVersion).toBe(4);
    await expect(prisma.encounterOperation.create({
      data: {
        encounterId: fixture.encounter.id,
        idempotencyRecordId: firstIdempotency.id,
        operation: EncounterOperationKind.CONTINUE,
        previousStateVersion: 4,
        nextStateVersion: 5,
        inputHash: 'd'.repeat(64), beforeStateHash: 'b'.repeat(64), afterStateHash: 'e'.repeat(64),
        resultSummary: {},
      },
    })).rejects.toMatchObject({ code: 'P2002' });

    const duplicateVersionIdempotency = await prisma.idempotencyRecord.create({
      data: { key: 'encounter-operation-sequence-003', operation: 'encounter-replay', requestHash: 'e'.repeat(64) },
    });
    await expect(prisma.encounterOperation.create({
      data: {
        encounterId: fixture.encounter.id,
        idempotencyRecordId: duplicateVersionIdempotency.id,
        operation: EncounterOperationKind.SUBMIT_INTENT,
        previousStateVersion: 1,
        nextStateVersion: 4,
        inputHash: 'e'.repeat(64), beforeStateHash: 'a'.repeat(64), afterStateHash: 'f'.repeat(64),
        resultSummary: {},
      },
    })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('fails the Phase 1L-B migration preflight before changing checks when incompatible rows exist', async () => {
    const fixture = await createEncounterFixture('operation-preflight');
    const idempotency = await prisma.idempotencyRecord.create({
      data: { key: 'encounter-operation-preflight-001', operation: 'encounter-create', requestHash: '9'.repeat(64) },
    });
    const migration = readFileSync(new URL(
      '../../prisma/migrations/20260715120000_fix_encounter_operation_versions/migration.sql',
      import.meta.url,
    ), 'utf8');
    const preflight = migration.slice(0, migration.indexOf('ALTER TABLE "EncounterOperation"'));
    const client = await openPostgreSqlClient('phase-1l-b-migration-preflight');
    await client.query('BEGIN');
    try {
      await client.query(`
        ALTER TABLE "EncounterOperation"
          DROP CONSTRAINT "EncounterOperation_previousStateVersion_check",
          DROP CONSTRAINT "EncounterOperation_stateVersionSequence_check"
      `);
      await client.query(`
        INSERT INTO "EncounterOperation" (
          "id", "encounterId", "idempotencyRecordId", "operation",
          "previousStateVersion", "nextStateVersion", "inputHash",
          "beforeStateHash", "afterStateHash", "resultSummary"
        ) VALUES ($1, $2, $3, 'CREATE', 1, 2, $4, $5, $6, '{}'::jsonb)
      `, [randomUUID(), fixture.encounter.id, idempotency.id, '9'.repeat(64), '8'.repeat(64), '7'.repeat(64)]);
      await expect(client.query(preflight)).rejects.toThrow(/manual data migration is required/i);
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });

  it('rejects duplicate roll refs, invalid ordinals and cross-Encounter operation links', async () => {
    const fixture = await createEncounterFixture('roll-audit');
    const idempotency = await prisma.idempotencyRecord.create({
      data: { key: 'encounter-roll-audit-001', operation: 'encounter-create', requestHash: '1'.repeat(64) },
    });
    const operation = await prisma.encounterOperation.create({
      data: {
        encounterId: fixture.encounter.id,
        idempotencyRecordId: idempotency.id,
        operation: EncounterOperationKind.CREATE,
        previousStateVersion: 0,
        nextStateVersion: 1,
        inputHash: '1'.repeat(64), beforeStateHash: '2'.repeat(64), afterStateHash: '3'.repeat(64),
        resultSummary: {},
      },
    });
    const rollData = {
      encounterId: fixture.encounter.id,
      encounterOperationId: operation.id,
      rollRef: 'roll-audit-hit-0',
      kind: EncounterRollKind.HIT,
      ordinal: 0,
      actionRef: 'action-audit-1',
      sourceActorRef: fixture.actor.code,
      targetActorRef: 'audit-target',
      targetOrdinal: 0,
      inputHash: '4'.repeat(64),
      resultSnapshot: { rollBps: 5000 },
      resultHash: '5'.repeat(64),
    };
    await prisma.encounterRoll.create({ data: rollData });
    await expect(prisma.encounterRoll.create({ data: rollData })).rejects.toMatchObject({ code: 'P2002' });
    await expect(prisma.encounterRoll.create({
      data: { ...rollData, rollRef: 'roll-negative', ordinal: -1 },
    })).rejects.toThrow();

    const foreign = await createEncounterFixture('roll-foreign');
    await expect(prisma.encounterRoll.create({
      data: { ...rollData, encounterId: foreign.encounter.id, rollRef: 'roll-cross-encounter' },
    })).rejects.toThrow();
  });

  it('enforces Encounter versions, ticks, snapshot schema and lowercase SHA-256 hashes', async () => {
    const fixture = await createEncounterFixture('encounter-checks', EncounterLifecycleStatus.COMPLETED);
    const base = {
      campaignId: fixture.campaign.id,
      rulesetVersionId: fixture.rulesetVersion.id,
      lifecycleStatus: EncounterLifecycleStatus.COMPLETED,
      stateVersion: 1,
      currentTick: 0n,
      snapshotSchemaVersion: 1,
      stateSnapshot: { snapshotSchemaVersion: 1 },
      stateHash: 'a'.repeat(64),
    };
    await expect(prisma.encounter.create({ data: { ...base, encounterRef: 'invalid-version', stateVersion: 0 } })).rejects.toThrow();
    await expect(prisma.encounter.create({ data: { ...base, encounterRef: 'invalid-tick', currentTick: -1n } })).rejects.toThrow();
    await expect(prisma.encounter.create({ data: { ...base, encounterRef: 'invalid-schema', snapshotSchemaVersion: 2 } })).rejects.toThrow();
    await expect(prisma.encounter.create({ data: { ...base, encounterRef: 'invalid-hash', stateHash: 'A'.repeat(64) } })).rejects.toThrow();
  });

  it('accepts canonical JSON within 1 MiB despite JSONB rendering, but rejects physical JSONB text above 2 MiB', async () => {
    const fixture = await createEncounterFixture('snapshot-size', EncounterLifecycleStatus.COMPLETED);
    const payload = { payload: 'x'.repeat(1_048_576 - Buffer.byteLength(canonicalJson({ payload: '' }), 'utf8')) };
    const canonical = canonicalJson(payload);
    const jsonbBytes = await prisma.$queryRaw<Array<{ bytes: number }>>`
      SELECT octet_length((${canonical}::jsonb)::text)::int AS bytes
    `;

    expect(Buffer.byteLength(canonical, 'utf8')).toBe(1_048_576);
    expect(jsonbBytes[0]?.bytes).toBeGreaterThan(1_048_576);
    await expect(prisma.encounter.update({
      where: { id: fixture.encounter.id }, data: { stateSnapshot: payload },
    })).resolves.toBeTruthy();

    const overPhysicalGuard = { payload: 'x'.repeat(2_097_152) };
    await expect(prisma.encounter.update({
      where: { id: fixture.encounter.id }, data: { stateSnapshot: overPhysicalGuard },
    })).rejects.toThrow();
  });

  it('restricts deletes and makes participant mappings, operations and rolls append-only', async () => {
    const fixture = await createEncounterFixture('delete-restrict');
    const participant = await prisma.encounterParticipant.create({
      data: {
        encounterId: fixture.encounter.id,
        actorId: fixture.actor.id,
        actorRef: fixture.actor.code,
        bindingKind: EncounterParticipantBindingKind.PERSISTED_ACTOR,
        initialMechanicsStateVersion: 1,
        initialInventoryStateVersion: 1,
        initialEffectsStateVersion: 1,
      },
    });
    const idempotency = await prisma.idempotencyRecord.create({
      data: { key: 'encounter-delete-restrict-001', operation: 'encounter-create', requestHash: '6'.repeat(64) },
    });
    const operation = await prisma.encounterOperation.create({
      data: {
        encounterId: fixture.encounter.id,
        idempotencyRecordId: idempotency.id,
        operation: EncounterOperationKind.CREATE,
        previousStateVersion: 0, nextStateVersion: 1,
        inputHash: '6'.repeat(64), beforeStateHash: '7'.repeat(64), afterStateHash: '8'.repeat(64),
        resultSummary: {},
      },
    });
    const roll = await prisma.encounterRoll.create({
      data: {
        encounterId: fixture.encounter.id,
        encounterOperationId: operation.id,
        rollRef: 'delete-restrict-roll',
        kind: EncounterRollKind.TIE_BREAK,
        ordinal: 0,
        sourceActorRef: fixture.actor.code,
        inputHash: '9'.repeat(64),
        resultSnapshot: { tieBreak: 42 },
        resultHash: '0'.repeat(64),
      },
    });

    await expect(prisma.encounterParticipant.update({
      where: { id: participant.id }, data: { actorRef: 'changed-participant' },
    })).rejects.toThrow(/append-only/);
    await expect(prisma.encounterOperation.update({
      where: { id: operation.id }, data: { resultSummary: { changed: true } },
    })).rejects.toThrow(/append-only/);
    await expect(prisma.encounterRoll.update({
      where: { id: roll.id }, data: { resultSnapshot: { changed: true } },
    })).rejects.toThrow(/append-only/);
    await expect(prisma.actor.delete({ where: { id: fixture.actor.id } })).rejects.toThrow();
    await expect(prisma.idempotencyRecord.delete({ where: { id: idempotency.id } })).rejects.toThrow();
    await expect(prisma.encounter.delete({ where: { id: fixture.encounter.id } })).rejects.toThrow();
  });
});
}

describe('idempotent seed', () => {
  async function counts() {
    const [rulesets, rulesetVersions, contentProfileVersions, inventoryRulesVersions, effectRulesVersions, players, worlds, campaigns, actors, attributes, resources, snapshots, definitions, contentVersions, links, inventoryEntries, effectBindings, activeEffects, effectResolutions, effectRolls] = await Promise.all([
      prisma.ruleset.count(), prisma.rulesetVersion.count(), prisma.contentProfileVersion.count(), prisma.inventoryRulesVersion.count(), prisma.effectRulesVersion.count(),
      prisma.player.count(), prisma.world.count(), prisma.campaign.count(), prisma.actor.count(),
      prisma.actorAttribute.count(), prisma.actorResource.count(), prisma.actorDerivedSnapshot.count(),
      prisma.contentDefinition.count(), prisma.contentVersion.count(), prisma.actorContent.count(), prisma.inventoryEntry.count(),
      prisma.contentEffectBinding.count(), prisma.activeEffect.count(), prisma.effectResolution.count(), prisma.effectRoll.count(),
    ]);
    return { rulesets, rulesetVersions, contentProfileVersions, inventoryRulesVersions, effectRulesVersions, players, worlds, campaigns, actors, attributes, resources, snapshots, definitions, contentVersions, links, inventoryEntries, effectBindings, activeEffects, effectResolutions, effectRolls };
  }

  it('creates the expected initial records', async () => {
    await expect(counts()).resolves.toEqual({
      rulesets: 1, rulesetVersions: 1, contentProfileVersions: 1, inventoryRulesVersions: 1, effectRulesVersions: 1,
      players: 1, worlds: 1, campaigns: 1, actors: 2, attributes: 18, resources: 6, snapshots: 2,
      definitions: 4, contentVersions: 4, links: 2, inventoryEntries: 1, effectBindings: 1,
      activeEffects: 0, effectResolutions: 0, effectRolls: 0,
    });
  });

  it('keeps counts and the Ralph content link unchanged on a second seed', async () => {
    const before = await counts();
    const npmCli = process.env.npm_execpath;
    expect(npmCli).toBeDefined();
    const result = spawnSync(process.execPath, [npmCli ?? '', 'run', 'prisma:seed'], { env: process.env, stdio: 'pipe', encoding: 'utf8' });
    expect(result.status).toBe(0);
    await expect(counts()).resolves.toEqual(before);

    const ralph = await prisma.actor.findFirstOrThrow({ where: { code: 'ralph' }, include: { attributes: true, resources: true, derivedSnapshot: true, content: { include: { contentDefinition: true, contentVersion: true } } } });
    const lyraCount = await prisma.actor.count({ where: { code: 'lyra' } });
    const definitionCount = await prisma.contentDefinition.count({ where: { code: 'wind_breeze_step' } });
    expect(lyraCount).toBe(1);
    expect(definitionCount).toBe(1);
    expect(ralph.content).toHaveLength(2);
    expect(ralph.attributes).toHaveLength(9);
    expect(ralph.resources).toHaveLength(3);
    expect(ralph.derivedSnapshot).not.toBeNull();
    const breeze = ralph.content.find((link) => link.contentDefinition.code === 'wind_breeze_step');
    if (breeze === undefined) throw new Error('Seed breeze content link is required');
    expect(breeze).toMatchObject({ state: 'LEARNING', rank: 1, progress: 10, mastery: 0, notes: 'Treino inicial com Lyra' });
    expect(breeze?.contentVersion).toMatchObject({ contentDefinitionId: breeze.contentDefinitionId, versionNumber: 1 });
  });
});

encounterPersistenceConstraintTests();

describe('Phase 1L-B transactional encounter adapter', () => {
  it('creates, loads, replays, advances, submits content, persists effects and cancels without consequences', async () => {
    const actorBefore = await prisma.actor.findUniqueOrThrow({
      where: { campaignId_code: {
        campaignId: (await prisma.campaign.findUniqueOrThrow({
          where: { worldId_code: {
            worldId: (await prisma.world.findFirstOrThrow({ where: { code: seedScope.worldRef } })).id,
            code: seedScope.campaignRef,
          } },
        })).id,
        code: 'ralph',
      } },
      select: { xp: true, gold: true },
    });
    const createInput = {
      ...seedScope,
      idempotencyKey: 'phase-1l-b-create-0001',
      encounterRef: 'phase-1l-b-service',
      partySideRef: 'party',
      participants: [{
        bindingKind: 'persisted_actor' as const,
        actorRef: 'ralph',
        sideRef: 'party',
        zone: 'near' as const,
      }, {
        bindingKind: 'persisted_actor' as const,
        actorRef: 'lyra',
        sideRef: 'hostile',
        zone: 'near' as const,
      }],
      relations: [
        { leftActorRef: 'lyra', rightActorRef: 'lyra', relation: 'self' as const },
        { leftActorRef: 'lyra', rightActorRef: 'ralph', relation: 'hostile' as const },
        { leftActorRef: 'ralph', rightActorRef: 'ralph', relation: 'self' as const },
      ],
    };
    const created = await encounterService.create(createInput);
    expect(created).toMatchObject({
      operation: 'create', encounterRef: createInput.encounterRef,
      stateVersion: 1, lifecycleStatus: 'processing_paused',
    });
    expect(canonicalJson(created)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}|stateHash|stateSnapshot/i);

    const replay = await encounterService.create({
      ...createInput,
      participants: [...createInput.participants].reverse(),
      relations: [...createInput.relations].reverse().map((relation) => (
        relation.relation === 'hostile'
          ? { ...relation, leftActorRef: relation.rightActorRef, rightActorRef: relation.leftActorRef }
          : relation
      )),
    });
    expect(replay).toEqual(created);
    expect(await prisma.encounterOperation.count({
      where: { encounter: { encounterRef: createInput.encounterRef } },
    })).toBe(1);
    await expect(encounterService.create({ ...createInput, partySideRef: 'other' }))
      .rejects.toMatchObject({ code: 'ENCOUNTER_IDEMPOTENCY_KEY_REUSED' });

    const prematureIntentKey = 'phase-1l-b-premature-intent';
    await expect(encounterService.submitIntent({
      ...seedScope,
      encounterRef: createInput.encounterRef,
      idempotencyKey: prematureIntentKey,
      expectedStateVersion: created.stateVersion,
      intent: {
        intentRef: 'premature-mark-intent', sourceActorRef: 'ralph', slotRef: 'primary',
        actionSource: 'content', targetSelector: 'explicit', requestedTargetRefs: ['ralph'],
        contentRef: { scope: 'campaign', contentType: 'spell', code: 'seed-mark-spell', versionNumber: 1 },
      },
    })).rejects.toMatchObject({ code: 'ENCOUNTER_LIFECYCLE_CONFLICT' });
    await expect(prisma.idempotencyRecord.count({ where: { key: `encounter:${prematureIntentKey}` } })).resolves.toBe(0);

    const staleContinueKey = 'phase-1l-b-stale-continue';
    await expect(encounterService.continue({
      ...seedScope,
      encounterRef: createInput.encounterRef,
      idempotencyKey: staleContinueKey,
      expectedStateVersion: created.stateVersion + 100,
    })).rejects.toMatchObject({ code: 'ENCOUNTER_EXPECTED_VERSION_CONFLICT' });
    await expect(prisma.idempotencyRecord.count({ where: { key: `encounter:${staleContinueKey}` } })).resolves.toBe(0);

    const loaded = await encounterService.load({ ...seedScope, encounterRef: createInput.encounterRef });
    expect(loaded).toMatchObject({ operation: 'load', stateVersion: 1 });
    expect(await prisma.encounterOperation.count({
      where: { encounter: { encounterRef: createInput.encounterRef } },
    })).toBe(1);

    const ready = await encounterService.continue({
      ...seedScope,
      encounterRef: createInput.encounterRef,
      idempotencyKey: 'phase-1l-b-continue-0001',
      expectedStateVersion: created.stateVersion,
    });
    expect(ready.lifecycleStatus).toBe('awaiting_intent');

    const submitted = await encounterService.submitIntent({
      ...seedScope,
      encounterRef: createInput.encounterRef,
      idempotencyKey: 'phase-1l-b-submit-0001',
      expectedStateVersion: ready.stateVersion,
      intent: {
        intentRef: 'phase-1l-b-mark-intent',
        sourceActorRef: 'ralph',
        slotRef: 'primary',
        actionSource: 'content',
        targetSelector: 'explicit',
        requestedTargetRefs: ['ralph'],
        contentRef: {
          scope: 'campaign', contentType: 'spell', code: 'seed-mark-spell', versionNumber: 1,
        },
      },
    });
    expect(submitted.lifecycleStatus).toBe('processing_paused');

    const resolved = await encounterService.continue({
      ...seedScope,
      encounterRef: createInput.encounterRef,
      idempotencyKey: 'phase-1l-b-continue-0002',
      expectedStateVersion: submitted.stateVersion,
    });
    expect(resolved.stateVersion).toBeGreaterThan(submitted.stateVersion + 1);
    const persistedEffect = await prisma.activeEffect.findFirstOrThrow({
      where: {
        targetActor: { code: 'ralph' },
        sourceContentVersion: { contentDefinition: { code: 'seed-mark-spell' } },
      },
    });

    const cancelled = await encounterService.cancel({
      ...seedScope,
      encounterRef: createInput.encounterRef,
      idempotencyKey: 'phase-1l-b-cancel-0001',
      expectedStateVersion: resolved.stateVersion,
    });
    expect(cancelled).toMatchObject({ lifecycleStatus: 'cancelled', completionCandidate: 'cancelled' });
    await expect(prisma.activeEffect.findUnique({ where: { id: persistedEffect.id } })).resolves.not.toBeNull();
    const actorAfter = await prisma.actor.findFirstOrThrow({
      where: { code: 'ralph', campaign: { code: seedScope.campaignRef } },
      select: { xp: true, gold: true },
    });
    expect(actorAfter).toEqual(actorBefore);
  });

  it('detects drift and serializes concurrent creates and same-version operations safely', async () => {
    const base = {
      ...seedScope,
      partySideRef: 'party',
      participants: [{
        bindingKind: 'persisted_actor' as const, actorRef: 'ralph', sideRef: 'party', zone: 'near' as const,
      }, {
        bindingKind: 'persisted_actor' as const, actorRef: 'lyra', sideRef: 'hostile', zone: 'near' as const,
      }],
      relations: [
        { leftActorRef: 'lyra', rightActorRef: 'lyra', relation: 'self' as const },
        { leftActorRef: 'lyra', rightActorRef: 'ralph', relation: 'hostile' as const },
        { leftActorRef: 'ralph', rightActorRef: 'ralph', relation: 'self' as const },
      ],
    };
    const attempts = await Promise.allSettled([
      encounterService.create({ ...base, encounterRef: 'phase-1l-b-race-a', idempotencyKey: 'phase-1l-b-race-create-a' }),
      encounterService.create({ ...base, encounterRef: 'phase-1l-b-race-b', idempotencyKey: 'phase-1l-b-race-create-b' }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    const rejectedCreate = attempts.find((attempt) => attempt.status === 'rejected');
    if (rejectedCreate?.status !== 'rejected') throw new Error('Concurrent create loser is required');
    expect(rejectedCreate.reason).toMatchObject({ code: 'ENCOUNTER_ALREADY_OPEN' });
    const created = attempts.find((attempt) => attempt.status === 'fulfilled');
    if (created?.status !== 'fulfilled') throw new Error('Concurrent create winner is required');
    const encounterRef = created.value.encounterRef;
    const encounter = await prisma.encounter.findFirstOrThrow({ where: { encounterRef } });
    const actor = await prisma.actor.findFirstOrThrow({
      where: { code: 'ralph', campaignId: encounter.campaignId },
      include: { resources: { orderBy: { type: 'asc' } } },
    });

    for (const resource of actor.resources) {
      await prisma.actorResource.update({ where: { id: resource.id }, data: { stateVersion: { increment: 1 } } });
      await expect(encounterService.load({ ...seedScope, encounterRef }))
        .rejects.toMatchObject({ code: 'ENCOUNTER_RESOURCE_DRIFT' });
      await prisma.actorResource.update({ where: { id: resource.id }, data: { stateVersion: { decrement: 1 } } });
    }
    for (const [field, code] of [
      ['mechanicsStateVersion', 'ENCOUNTER_MECHANICS_DRIFT'],
      ['inventoryStateVersion', 'ENCOUNTER_INVENTORY_DRIFT'],
      ['effectsStateVersion', 'ENCOUNTER_EFFECTS_DRIFT'],
    ] as const) {
      await prisma.actor.update({ where: { id: actor.id }, data: { [field]: { increment: 1 } } });
      await expect(encounterService.load({ ...seedScope, encounterRef }))
        .rejects.toMatchObject({ code });
      await prisma.actor.update({ where: { id: actor.id }, data: { [field]: { decrement: 1 } } });
    }
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: encounter.campaignId } });
    await prisma.campaign.update({ where: { id: campaign.id }, data: { engineTick: { increment: 1n } } });
    await expect(encounterService.load({ ...seedScope, encounterRef }))
      .rejects.toMatchObject({ code: 'ENCOUNTER_CAMPAIGN_TICK_DRIFT' });
    await prisma.campaign.update({ where: { id: campaign.id }, data: { engineTick: campaign.engineTick } });

    const originalHash = encounter.stateHash;
    await prisma.encounter.update({ where: { id: encounter.id }, data: { stateHash: 'f'.repeat(64) } });
    await expect(encounterService.load({ ...seedScope, encounterRef }))
      .rejects.toMatchObject({ code: 'ENCOUNTER_SNAPSHOT_HASH_INVALID' });
    await prisma.encounter.update({ where: { id: encounter.id }, data: { stateHash: originalHash } });

    await prisma.encounter.update({ where: { id: encounter.id }, data: { currentTick: { increment: 1n } } });
    await expect(encounterService.load({ ...seedScope, encounterRef }))
      .rejects.toMatchObject({ code: 'ENCOUNTER_DENORMALIZED_DRIFT' });
    await prisma.encounter.update({ where: { id: encounter.id }, data: { currentTick: encounter.currentTick } });

    const sameVersion = await Promise.allSettled([
      encounterService.continue({
        ...seedScope, encounterRef, idempotencyKey: 'phase-1l-b-race-continue', expectedStateVersion: 1,
      }),
      encounterService.cancel({
        ...seedScope, encounterRef, idempotencyKey: 'phase-1l-b-race-cancel', expectedStateVersion: 1,
      }),
    ]);
    expect(sameVersion.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(sameVersion.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    const current = await encounterService.load({ ...seedScope, encounterRef });
    if (current.lifecycleStatus !== 'cancelled') {
      await encounterService.cancel({
        ...seedScope,
        encounterRef,
        idempotencyKey: 'phase-1l-b-race-cleanup',
        expectedStateVersion: current.stateVersion,
      });
    }

    const actorIds = await prisma.actor.findMany({
      where: { campaignId: encounter.campaignId, code: { in: ['ralph', 'lyra'] } },
      select: { id: true },
    });
    await expect(Promise.all([
      prisma.$transaction((transaction) => lockActorAuthorities(transaction, actorIds.map((actor) => actor.id))),
      prisma.$transaction((transaction) => lockActorAuthorities(transaction, actorIds.map((actor) => actor.id).reverse())),
    ])).resolves.toHaveLength(2);
  });

  it('confirms a valid completion candidate without rewards or encounter-effect cleanup', async () => {
    const encounterScopedEffect = await prisma.activeEffect.findFirstOrThrow({
      where: {
        targetActor: { code: 'ralph', campaign: { code: seedScope.campaignRef } },
        sourceContentVersion: { contentDefinition: { code: 'seed-mark-spell' } },
      },
    });
    await prisma.$transaction(async (transaction) => {
      await transaction.activeEffect.update({
        where: { id: encounterScopedEffect.id },
        data: { durationType: 'ENCOUNTER', expiresAtTick: null, remainingActions: null },
      });
      await transaction.actor.update({
        where: { id: encounterScopedEffect.targetActorId },
        data: { effectsStateVersion: { increment: 1 }, mechanicsStateVersion: { increment: 1 } },
      });
      await recomputeActorDerivedSnapshot(transaction, encounterScopedEffect.targetActorId);
    });
    const before = await prisma.actor.findFirstOrThrow({
      where: { code: 'ralph', campaign: { code: seedScope.campaignRef } },
      select: { xp: true, gold: true },
    });
    const created = await encounterService.create({
      ...seedScope,
      encounterRef: 'phase-1l-b-confirm',
      idempotencyKey: 'phase-1l-b-confirm-create',
      partySideRef: 'party',
      participants: [{
        bindingKind: 'persisted_actor', actorRef: 'ralph', sideRef: 'party', zone: 'near',
      }, {
        bindingKind: 'persisted_actor', actorRef: 'lyra', sideRef: 'hostile', zone: 'near',
      }],
      relations: [
        { leftActorRef: 'lyra', rightActorRef: 'lyra', relation: 'self' },
        { leftActorRef: 'lyra', rightActorRef: 'ralph', relation: 'hostile' },
        { leftActorRef: 'ralph', rightActorRef: 'ralph', relation: 'self' },
      ],
    });
    const record = await prisma.encounter.findFirstOrThrow({
      where: { encounterRef: created.encounterRef },
      include: { operations: { orderBy: { nextStateVersion: 'desc' }, take: 1 } },
    });
    const candidate = {
      ...parseCoreV1EncounterSnapshot(record.stateSnapshot),
      stateVersion: 2,
      completionCandidate: 'party_victory_candidate' as const,
    };
    const snapshot = serializeCoreV1EncounterState(candidate);
    const hash = createCoreV1EncounterSnapshotHash(snapshot);
    const idempotency = await prisma.idempotencyRecord.create({
      data: {
        key: 'phase-1l-b-confirm-preparation', operation: 'encounter.continue', requestHash: 'a'.repeat(64),
      },
    });
    await prisma.$transaction(async (transaction) => {
      await transaction.encounter.update({
        where: { id: record.id },
        data: {
          lifecycleStatus: EncounterLifecycleStatus.COMPLETION_PENDING,
          stateVersion: 2,
          completionCandidate: 'PARTY_VICTORY_CANDIDATE',
          stateSnapshot: snapshot,
          stateHash: hash,
        },
      });
      await transaction.encounterOperation.create({
        data: {
          encounterId: record.id,
          idempotencyRecordId: idempotency.id,
          operation: EncounterOperationKind.CONTINUE,
          previousStateVersion: 1,
          nextStateVersion: 2,
          inputHash: 'a'.repeat(64),
          beforeStateHash: record.stateHash,
          afterStateHash: hash,
          resultSummary: record.operations[0]!.resultSummary as Prisma.InputJsonValue,
        },
      });
    });
    const completed = await encounterService.confirmCompletion({
      ...seedScope,
      encounterRef: created.encounterRef,
      idempotencyKey: 'phase-1l-b-confirm-operation',
      expectedStateVersion: 2,
    });
    expect(completed).toMatchObject({
      lifecycleStatus: 'completed', completionCandidate: 'party_victory_candidate', stateVersion: 3,
    });
    const after = await prisma.actor.findFirstOrThrow({
      where: { code: 'ralph', campaign: { code: seedScope.campaignRef } },
      select: { xp: true, gold: true },
    });
    expect(after).toEqual(before);
    await expect(prisma.activeEffect.findUnique({ where: { id: encounterScopedEffect.id } })).resolves.not.toBeNull();
    const closed = await prisma.encounter.findUniqueOrThrow({ where: { id: record.id } });
    expect(closed.lifecycleStatus).toBe(EncounterLifecycleStatus.COMPLETED);
    expect(closed.closedAt).toBeInstanceOf(Date);
  });

  it('resolves an ephemeral active dodge deterministically without reaction or damage rolls', async () => {
    const dagger = await prisma.inventoryEntry.findFirstOrThrow({
      where: { actor: { code: 'ralph', campaign: { code: seedScope.campaignRef } }, entryRef: 'starter-dagger-1' },
    });
    const equipped = await prisma.actorEquipmentSlot.findFirst({ where: { inventoryEntryId: dagger.id } });
    const equippedForTest = equipped === null;
    if (equipped === null) {
      await prisma.$transaction(async (transaction) => {
        await transaction.actorEquipmentSlot.create({
          data: { actorId: dagger.actorId, inventoryEntryId: dagger.id, slotRef: ActorEquipmentSlotRef.MAIN_HAND },
        });
        await transaction.actor.update({
          where: { id: dagger.actorId },
          data: { inventoryStateVersion: { increment: 1 }, mechanicsStateVersion: { increment: 1 } },
        });
        await recomputeActorDerivedSnapshot(transaction, dagger.actorId);
      });
    }
    const attributes = getInitialAttributePreset('balanced');
    const secondary = calculateSecondaryAttributes({
      attributes, weaponFamilyRank: 0, magicSchoolRank: 0,
      accuracyRank: 0, evasionRank: 0, encumbrancePenalty: 0,
    });
    const encounterRef = 'phase-1l-b-reaction';
    const created = await encounterService.create({
      ...seedScope,
      encounterRef,
      idempotencyKey: 'phase-1l-b-reaction-create',
      partySideRef: 'party',
      participants: [{
        bindingKind: 'persisted_actor', actorRef: 'ralph', sideRef: 'party', zone: 'engaged',
      }, {
        bindingKind: 'ephemeral',
        ephemeralKind: 'ephemeral_creature',
        participant: {
          actorRef: 'training-phantom',
          sideRef: 'hostile',
          actorStateVersion: 1,
          mechanicsStateVersion: 1,
          inventoryStateVersion: 1,
          effectsStateVersion: 1,
          zone: 'engaged',
          combatState: 'ready',
          primaryAttributes: attributes,
          resources: {
            hp: { current: 100, maximum: 100 }, mana: { current: 0, maximum: 0 },
            sp: { current: 20, maximum: 20 }, customResources: [],
          },
          secondaryAttributes: secondary,
          activeEffects: [],
          reactionCapabilities: [{
            capabilityRef: 'phantom-dodge', kind: 'active_dodge', tier: 1,
            cost: { type: 'special_dodge', sp: 3 },
          }],
          equipmentContext: {
            inventory: { entries: [] },
            loadout: createCoreV1EmptyEquipmentLoadout(),
            requirements: {
              level: 1, primaryAttributes: attributes, knownContentRefs: [],
              equippedWeaponTags: [], equippedEquipmentTags: [], rulesetCode: 'core-v1',
            },
          },
          initiative: { tieBreak: 50, surprised: false },
        },
      }],
      relations: [
        { leftActorRef: 'ralph', rightActorRef: 'ralph', relation: 'self' },
        { leftActorRef: 'ralph', rightActorRef: 'training-phantom', relation: 'hostile' },
        { leftActorRef: 'training-phantom', rightActorRef: 'training-phantom', relation: 'self' },
      ],
    });
    const ready = await encounterService.continue({
      ...seedScope, encounterRef, idempotencyKey: 'phase-1l-b-reaction-ready', expectedStateVersion: created.stateVersion,
    });
    const submitted = await encounterService.submitIntent({
      ...seedScope,
      encounterRef,
      idempotencyKey: 'phase-1l-b-reaction-submit',
      expectedStateVersion: ready.stateVersion,
      intent: {
        intentRef: 'phantom-attack', sourceActorRef: 'ralph', slotRef: 'primary',
        actionSource: 'basic_weapon_attack', targetSelector: 'explicit',
        requestedTargetRefs: ['training-phantom'], weaponEntryRef: 'starter-dagger-1',
        contentRef: { scope: 'campaign', contentType: 'weapon', code: 'starter-dagger', versionNumber: 1 },
        reactionPolicy: { mode: 'require', preferredReaction: 'active_dodge', allowCounterAttack: false },
      },
    });
    const reactionPending = await encounterService.continue({
      ...seedScope,
      encounterRef,
      idempotencyKey: 'phase-1l-b-reaction-boundary',
      expectedStateVersion: submitted.stateVersion,
    });
    expect(reactionPending.lifecycleStatus).toBe('awaiting_reaction');
    const reaction = await encounterService.resolveReaction({
      ...seedScope,
      encounterRef,
      idempotencyKey: 'phase-1l-b-reaction-resolve',
      expectedStateVersion: reactionPending.stateVersion,
      reactorActorRef: 'training-phantom',
      reactionKind: 'active_dodge',
    });
    const final = await encounterService.continue({
      ...seedScope,
      encounterRef,
      idempotencyKey: 'phase-1l-b-reaction-finish',
      expectedStateVersion: reaction.stateVersion,
    });
    const persisted = await prisma.encounter.findFirstOrThrow({
      where: { encounterRef }, include: { rolls: true },
    });
    const damageRollKinds = new Set<EncounterRollKind>([EncounterRollKind.HIT, EncounterRollKind.CRITICAL]);
    expect(persisted.rolls.filter((roll) => damageRollKinds.has(roll.kind))).toEqual([]);
    await encounterService.cancel({
      ...seedScope,
      encounterRef,
      idempotencyKey: 'phase-1l-b-reaction-cancel',
      expectedStateVersion: final.stateVersion,
    });
    if (equippedForTest) {
      await prisma.$transaction(async (transaction) => {
        await transaction.actorEquipmentSlot.deleteMany({ where: { inventoryEntryId: dagger.id } });
        await transaction.actor.update({
          where: { id: dagger.actorId },
          data: { inventoryStateVersion: { increment: 1 }, mechanicsStateVersion: { increment: 1 } },
        });
        await recomputeActorDerivedSnapshot(transaction, dagger.actorId);
      });
    }
  });

  it('rolls back resource and inventory writes when operation audit persistence fails, then retries safely', async () => {
    const actor = await prisma.actor.findFirstOrThrow({
      where: { code: 'ralph', campaign: { code: seedScope.campaignRef } },
      include: { campaign: { include: { world: true } } },
    });
    const potion = await prisma.$transaction((transaction) => publishContentVersion(transaction, {
      worldId: actor.campaign.world.id,
      campaignId: actor.campaignId,
      contentType: ContentType.CONSUMABLE,
      code: 'phase-1l-b-rollback-potion',
      name: 'Poção de rollback 1L-B',
      description: 'Consumível interno de teste transacional.',
      profile: {
        schemaVersion: 1, rulesetCode: 'core-v1', profileMode: 'mechanical', contentKind: 'consumable',
        code: 'phase-1l-b-rollback-potion', name: 'Poção de rollback 1L-B',
        tier: 1, rarity: 'common', activation: { type: 'active' }, cost: { type: 'none' },
        actionProfile: 'potion', consumable: true,
        effects: [{ type: 'restore_resource', resource: 'hp', amount: 10, targeting: { type: 'self', rangeBand: 'self' } }],
      },
      inventorySpec: { ...inventorySpecBase, unitWeight: 1, stacking: { mode: 'stackable', maxStack: 20 } },
      presentation: {}, tags: ['phase-1l-b'], status: ContentStatus.ACTIVE, metadata: {},
    }));
    const version = potion.versions[0];
    if (version?.inventoryRulesVersionId === null || version?.inventoryRulesVersionId === undefined) {
      throw new Error('Encounter rollback potion requires inventory rules');
    }
    const hp = await prisma.actorResource.findUniqueOrThrow({
      where: { actorId_type: { actorId: actor.id, type: 'HP' } },
    });
    const reducedHp = Math.max(0, hp.current - 10);
    await prisma.$transaction(async (transaction) => {
      await transaction.inventoryEntry.create({
        data: {
          actorId: actor.id, entryRef: 'phase-1l-b-rollback-potion-stack',
          contentVersionId: version.id, inventoryRulesVersionId: version.inventoryRulesVersionId as string,
          entryKind: InventoryEntryKind.STACK, quantity: 1,
        },
      });
      await transaction.actorResource.update({
        where: { id: hp.id }, data: { current: reducedHp, stateVersion: { increment: 1 } },
      });
      await transaction.actor.update({
        where: { id: actor.id },
        data: { inventoryStateVersion: { increment: 1 }, mechanicsStateVersion: { increment: 1 } },
      });
      await recomputeActorDerivedSnapshot(transaction, actor.id);
    });
    const encounterRef = 'phase-1l-b-rollback';
    const created = await encounterService.create({
      ...seedScope, encounterRef, idempotencyKey: 'phase-1l-b-rollback-create', partySideRef: 'party',
      participants: [
        { bindingKind: 'persisted_actor', actorRef: 'ralph', sideRef: 'party', zone: 'near' },
        { bindingKind: 'persisted_actor', actorRef: 'lyra', sideRef: 'hostile', zone: 'near' },
      ],
      relations: [
        { leftActorRef: 'lyra', rightActorRef: 'lyra', relation: 'self' },
        { leftActorRef: 'lyra', rightActorRef: 'ralph', relation: 'hostile' },
        { leftActorRef: 'ralph', rightActorRef: 'ralph', relation: 'self' },
      ],
    });
    const ready = await encounterService.continue({
      ...seedScope, encounterRef, idempotencyKey: 'phase-1l-b-rollback-ready',
      expectedStateVersion: created.stateVersion,
    });
    const submitted = await encounterService.submitIntent({
      ...seedScope, encounterRef, idempotencyKey: 'phase-1l-b-rollback-submit',
      expectedStateVersion: ready.stateVersion,
      intent: {
        intentRef: 'phase-1l-b-use-rollback-potion', sourceActorRef: 'ralph', slotRef: 'primary',
        actionSource: 'consumable', targetSelector: 'self', requestedTargetRefs: [],
        weaponEntryRef: 'phase-1l-b-rollback-potion-stack',
        contentRef: {
          scope: 'campaign', contentType: 'consumable', code: potion.code, versionNumber: version.versionNumber,
        },
      },
    });
    const retryKey = 'phase-1l-b-rollback-continue';
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION phase1lb_test_reject_operation() RETURNS TRIGGER LANGUAGE plpgsql AS $function$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM "IdempotencyRecord"
          WHERE "id" = NEW."idempotencyRecordId" AND "key" = 'encounter:${retryKey}'
        ) THEN
          RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'phase1lb rollback injection';
        END IF;
        RETURN NEW;
      END
      $function$;
      CREATE TRIGGER phase1lb_test_reject_operation
        BEFORE INSERT ON "EncounterOperation"
        FOR EACH ROW EXECUTE FUNCTION phase1lb_test_reject_operation();
    `);
    try {
      await expect(encounterService.continue({
        ...seedScope, encounterRef, idempotencyKey: retryKey, expectedStateVersion: submitted.stateVersion,
      })).rejects.toMatchObject({ code: 'ENCOUNTER_CONSTRAINT_CONFLICT' });
    } finally {
      await prisma.$executeRawUnsafe(`
        DROP TRIGGER IF EXISTS phase1lb_test_reject_operation ON "EncounterOperation";
        DROP FUNCTION IF EXISTS phase1lb_test_reject_operation();
      `);
    }
    await expect(prisma.actorResource.findUniqueOrThrow({ where: { id: hp.id } }))
      .resolves.toMatchObject({ current: reducedHp });
    await expect(prisma.inventoryEntry.findUnique({
      where: { actorId_entryRef: { actorId: actor.id, entryRef: 'phase-1l-b-rollback-potion-stack' } },
    })).resolves.not.toBeNull();
    await expect(prisma.idempotencyRecord.count({ where: { key: `encounter:${retryKey}` } })).resolves.toBe(0);
    await expect(encounterService.load({ ...seedScope, encounterRef })).resolves.toMatchObject({
      stateVersion: submitted.stateVersion,
    });

    const retried = await encounterService.continue({
      ...seedScope, encounterRef, idempotencyKey: retryKey, expectedStateVersion: submitted.stateVersion,
    });
    await expect(prisma.actorResource.findUniqueOrThrow({ where: { id: hp.id } }))
      .resolves.toMatchObject({ current: hp.current });
    await expect(prisma.inventoryEntry.findUnique({
      where: { actorId_entryRef: { actorId: actor.id, entryRef: 'phase-1l-b-rollback-potion-stack' } },
    })).resolves.toBeNull();
    await encounterService.cancel({
      ...seedScope, encounterRef, idempotencyKey: 'phase-1l-b-rollback-cancel',
      expectedStateVersion: retried.stateVersion,
    });
  });
});

describe('ruleset persistence and database immutability', () => {
  it('binds the seeded World and Campaign to the official immutable version', async () => {
    const world = await prisma.world.findFirstOrThrow({
      where: { code: 'elarion' },
      include: { defaultRulesetVersion: { include: { ruleset: true } }, campaigns: true },
    });
    expect(world.defaultRulesetVersion).toMatchObject({
      code: 'core-v1', revision: 'RC1.1', schemaVersion: 1, configHash: CORE_V1_CONFIG_HASH,
      configSnapshot: CORE_V1_CONFIG_SNAPSHOT, ruleset: { code: 'core' },
    });
    expect(world.campaigns).toHaveLength(1);
    expect(world.campaigns[0]?.rulesetVersionId).toBe(world.defaultRulesetVersionId);
  });

  it('enforces hash format and positive schema versions in PostgreSQL', async () => {
    const ruleset = await prisma.ruleset.create({ data: { code: 'constraint-test', name: 'Constraint Test' } });
    await expect(prisma.rulesetVersion.create({ data: {
      rulesetId: ruleset.id, code: 'invalid-hash-v1', revision: 'TEST', schemaVersion: 1,
      configHash: 'invalid', configSnapshot: {},
    } })).rejects.toThrow();
    await expect(prisma.rulesetVersion.create({ data: {
      rulesetId: ruleset.id, code: 'invalid-schema-v1', revision: 'TEST', schemaVersion: 0,
      configHash: '0'.repeat(64), configSnapshot: {},
    } })).rejects.toThrow();
    await expect(prisma.rulesetVersion.count({ where: { rulesetId: ruleset.id } })).resolves.toBe(0);
  });

  it('blocks every RulesetVersion update and delete in PostgreSQL', async () => {
    const version = await prisma.rulesetVersion.findUniqueOrThrow({ where: { code: 'core-v1' } });
    await expect(prisma.rulesetVersion.update({ where: { id: version.id }, data: { revision: 'changed' } }))
      .rejects.toThrow(/RulesetVersion is immutable and cannot be updated/);
    await expect(prisma.rulesetVersion.delete({ where: { id: version.id } }))
      .rejects.toThrow(/RulesetVersion is immutable and cannot be deleted/);
    await expect(prisma.rulesetVersion.findUniqueOrThrow({ where: { id: version.id } })).resolves.toMatchObject({
      revision: 'RC1.1', configHash: CORE_V1_CONFIG_HASH,
    });
  });

  it('accepts the same Campaign rulesetVersionId and rejects a real change', async () => {
    const campaign = await prisma.campaign.findFirstOrThrow({ where: { code: 'main-campaign' } });
    const alternate = await createAlternateRulesetVersion('campaign-immutability');
    await expect(prisma.campaign.update({
      where: { id: campaign.id }, data: { rulesetVersionId: campaign.rulesetVersionId },
    })).resolves.toMatchObject({ rulesetVersionId: campaign.rulesetVersionId });
    await expect(prisma.campaign.update({
      where: { id: campaign.id }, data: { rulesetVersionId: alternate.id },
    })).rejects.toThrow(/Campaign rulesetVersionId is immutable after creation/);
    await expect(prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).resolves.toMatchObject({
      rulesetVersionId: campaign.rulesetVersionId,
    });
  });
});

describe('content publication and database immutability', () => {
  it('blocks profile/version mutation and stable identity changes in PostgreSQL', async () => {
    const profileVersion = await prisma.contentProfileVersion.findUniqueOrThrow({ where: { code: 'core-v1-content-v1' } });
    const content = await prisma.contentDefinition.findFirstOrThrow({
      where: { code: 'wind_breeze_step' }, include: { versions: { orderBy: { versionNumber: 'desc' } } },
    });
    const version = content.versions[0]!;
    await expect(prisma.contentProfileVersion.update({ where: { id: profileVersion.id }, data: { schemaVersion: 2 } }))
      .rejects.toThrow(/ContentProfileVersion is immutable and cannot be updated or deleted/);
    await expect(prisma.contentProfileVersion.delete({ where: { id: profileVersion.id } }))
      .rejects.toThrow(/ContentProfileVersion is immutable and cannot be updated or deleted/);
    await expect(prisma.contentVersion.update({ where: { id: version.id }, data: { name: 'Mutated' } }))
      .rejects.toThrow(/ContentVersion is immutable and cannot be updated or deleted/);
    await expect(prisma.contentVersion.delete({ where: { id: version.id } }))
      .rejects.toThrow(/ContentVersion is immutable and cannot be updated or deleted/);
    await expect(prisma.contentDefinition.update({ where: { id: content.id }, data: { code: 'mutated-code' } }))
      .rejects.toThrow(/ContentDefinition identity fields are immutable/);
    await expect(prisma.contentDefinition.update({ where: { id: content.id }, data: { status: ContentStatus.INACTIVE } }))
      .resolves.toMatchObject({ status: ContentStatus.INACTIVE });
    await prisma.contentDefinition.update({ where: { id: content.id }, data: { status: ContentStatus.ACTIVE } });
  });

  it('deduplicates equal snapshots and serializes different concurrent publications into sequential versions', async () => {
    const world = await prisma.world.findFirstOrThrow({ where: { code: 'elarion' } });
    const identicalInput = {
      worldId: world.id, contentType: ContentType.SKILL, code: 'concurrent-identical', name: 'Concurrent Identical',
      profile: activeProfile('skill', 'concurrent-identical', 'Concurrent Identical'),
    };
    const identical = await Promise.all([publishTestContent(identicalInput), publishTestContent(identicalInput)]);
    expect(identical[0].id).toBe(identical[1].id);
    await expect(prisma.contentVersion.count({ where: { contentDefinitionId: identical[0].id } })).resolves.toBe(1);
    const lifecycle = await publishTestContent({ ...identicalInput, status: ContentStatus.ARCHIVED });
    expect(lifecycle.status).toBe(ContentStatus.ARCHIVED);
    await expect(prisma.contentVersion.count({ where: { contentDefinitionId: identical[0].id } })).resolves.toBe(1);

    const code = 'concurrent-different';
    const different = await Promise.all([
      publishTestContent({ worldId: world.id, contentType: ContentType.SKILL, code, name: 'Concurrent A', profile: activeProfile('skill', code, 'Concurrent A') }),
      publishTestContent({ worldId: world.id, contentType: ContentType.SKILL, code, name: 'Concurrent B', profile: activeProfile('skill', code, 'Concurrent B') }),
    ]);
    expect(different[0].id).toBe(different[1].id);
    const versions = await prisma.contentVersion.findMany({ where: { contentDefinitionId: different[0].id }, orderBy: { versionNumber: 'asc' } });
    expect(versions.map((item) => item.versionNumber)).toEqual([1, 2]);
    expect(new Set(versions.map((item) => item.name))).toEqual(new Set(['Concurrent A', 'Concurrent B']));
  });

  it('keeps an actor on v1 while a new link receives v2 and rejects a mismatched definition/version pair', async () => {
    const world = await prisma.world.findFirstOrThrow({ where: { code: 'elarion' } });
    const [ralph, lyra] = await Promise.all([
      prisma.actor.findFirstOrThrow({ where: { code: 'ralph', campaign: { code: 'main-campaign' } } }),
      prisma.actor.findFirstOrThrow({ where: { code: 'lyra', campaign: { code: 'main-campaign' } } }),
    ]);
    const code = 'actor-version-pin';
    const v1 = await publishTestContent({ worldId: world.id, contentType: ContentType.SKILL, code, name: 'Pinned V1', profile: activeProfile('skill', code, 'Pinned V1') });
    const v1Version = v1.versions[0]!;
    const lyraLink = await prisma.actorContent.create({ data: {
      actorId: lyra.id, contentDefinitionId: v1.id, contentVersionId: v1Version.id, state: ActorContentState.KNOWN,
    } });
    const v2 = await publishTestContent({ worldId: world.id, contentType: ContentType.SKILL, code, name: 'Pinned V2', profile: activeProfile('skill', code, 'Pinned V2') });
    const v2Version = v2.versions[0]!;
    expect(v2Version.versionNumber).toBe(2);
    const ralphLink = await prisma.actorContent.create({ data: {
      actorId: ralph.id, contentDefinitionId: v2.id, contentVersionId: v2Version.id, state: ActorContentState.LEARNING,
    } });
    await prisma.actorContent.update({ where: { id: lyraLink.id }, data: { rank: 2 } });
    await expect(prisma.actorContent.findUniqueOrThrow({ where: { id: lyraLink.id } })).resolves.toMatchObject({ contentVersionId: v1Version.id });
    await expect(prisma.actorContent.findUniqueOrThrow({ where: { id: ralphLink.id } })).resolves.toMatchObject({ contentVersionId: v2Version.id });
    const [lyraGet, ralphGet] = await Promise.all([
      post('/api/v1/actors/lyra/content/manage', { operation: 'get', contentRef: code, contentType: 'skill' }),
      post('/api/v1/actors/ralph/content/manage', { operation: 'get', contentRef: code, contentType: 'skill' }),
    ]);
    expect(lyraGet.body).toMatchObject({ code, name: 'Pinned V1', versionNumber: 1 });
    expect(ralphGet.body).toMatchObject({ code, name: 'Pinned V2', versionNumber: 2 });
    const updated = await post('/api/v1/actors/lyra/content/manage', {
      operation: 'update', contentRef: code, contentType: 'skill', idempotencyKey: 'actor-pin-update-001', changes: { progress: 1 },
    });
    expect(updated.body).toMatchObject({ name: 'Pinned V1', versionNumber: 1, progress: 1 });
    await expect(prisma.actorContent.findUniqueOrThrow({ where: { id: lyraLink.id } })).resolves.toMatchObject({ contentVersionId: v1Version.id });

    const foreign = await publishTestContent({
      worldId: world.id, contentType: ContentType.SKILL, code: 'actor-version-foreign', name: 'Foreign Version',
      profile: activeProfile('skill', 'actor-version-foreign', 'Foreign Version'),
    });
    await expect(prisma.actorContent.create({ data: {
      actorId: lyra.id, contentDefinitionId: foreign.id, contentVersionId: v2Version.id, state: ActorContentState.KNOWN,
    } })).rejects.toThrow();
  });

  it('deduplicates physical publication by content and inventory spec hashes independently', async () => {
    const world = await prisma.world.findFirstOrThrow({ where: { code: 'elarion' } });
    const input = {
      worldId: world.id, contentType: ContentType.ITEM, code: 'spec-hash-item', name: 'Item com Spec',
      profile: canonicalProfile('item', 'spec-hash-item', 'Item com Spec'), inventorySpec: uniqueInventorySpec(1),
    };
    const first = await publishTestContent(input);
    const retry = await publishTestContent(input);
    const changed = await publishTestContent({ ...input, inventorySpec: uniqueInventorySpec(2) });
    expect(first.id).toBe(retry.id);
    expect(changed.versions[0]?.versionNumber).toBe(2);
    expect((changed.versions[0]?.inventorySpec as { unitWeight?: unknown } | null)?.unitWeight).toBe(2);
    await expect(prisma.contentVersion.count({ where: { contentDefinitionId: first.id } })).resolves.toBe(2);
    const hashes = await prisma.contentVersion.findMany({ where: { contentDefinitionId: first.id }, select: { contentHash: true, inventorySpecHash: true } });
    expect(new Set(hashes.map((version) => version.contentHash)).size).toBe(1);
    expect(new Set(hashes.map((version) => version.inventorySpecHash)).size).toBe(2);
  });
});

describe('complete API with real repositories', () => {
  it('serves health in memory without authentication', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('reports database readiness without leaking connection details', async () => {
    const response = await request(app).get('/health/ready');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ready' });
    expect(JSON.stringify(response.body)).not.toMatch(/postgres|Prisma|game_gpt_test/i);
  });

  it('enforces authentication without exposing the configured key', async () => {
    const absent = await request(app).get('/api/v1/characters/ralph');
    const wrong = await request(app).get('/api/v1/characters/ralph').set('x-rpg-key', 'wrong-key');
    expect(absent.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(JSON.stringify([absent.body, wrong.body])).not.toContain(config.RPG_API_KEY);
  });

  it('returns Ralph by code and rejects an internal UUID reference', async () => {
    const byCode = await authenticated(`/api/v1/characters/ralph?${seedScopeQuery}`);
    const byId = await authenticated(`/api/v1/characters/11111111-1111-4111-8111-111111111111?${seedScopeQuery}`);
    expect(byCode.status).toBe(200);
    expect(byId.status).toBe(400);
    expect(byCode.body).toMatchObject({ code: 'ralph', actorType: 'character', status: 'active' });
    expect(byCode.body).not.toHaveProperty('id');
  });

  it('returns Ralph content with the database enum normalized', async () => {
    const response = await authenticated(`/api/v1/characters/ralph/content?${seedScopeQuery}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'wind_breeze_step', state: 'learning', rank: 1, progress: 10, mastery: 0, notes: 'Treino inicial com Lyra' })]));
    expect(JSON.stringify(response.body)).not.toContain('contentDefinition');
  });

  it('returns Lyra and Passo da Brisa through real queries', async () => {
    const lyra = await authenticated(`/api/v1/actors/lyra?${seedScopeQuery}`);
    const content = await authenticated(`/api/v1/content/wind_breeze_step?${seedScopeQuery}&contentType=skill`);
    expect(lyra.body).toMatchObject({ code: 'lyra', actorType: 'spirit', status: 'active' });
    expect(content.body).toMatchObject({ code: 'wind_breeze_step', name: 'Passo da Brisa', contentType: 'skill', status: 'active' });
    expect(content.body).not.toHaveProperty('worldId');
  });

  it('rejects definitions without a version and versions incompatible with the Campaign ruleset', async () => {
    const world = await prisma.world.findFirstOrThrow({ where: { code: 'elarion' } });
    await prisma.contentDefinition.create({ data: {
      worldId: world.id, code: 'http-missing-version', contentType: ContentType.SKILL, status: ContentStatus.ACTIVE,
    } });
    const missing = await authenticated(`/api/v1/content/http-missing-version?${seedScopeQuery}&contentType=skill`);
    expect(missing.status).toBe(409);
    expect(responseErrorMessage(missing)).toBe('Content definition has no published version');

    const [alternate, profileVersion] = await Promise.all([
      createAlternateRulesetVersion('content-read-incompatible'),
      prisma.contentProfileVersion.findUniqueOrThrow({ where: { code: 'core-v1-content-v1' } }),
    ]);
    const profile = activeProfile('skill', 'http-incompatible-version', 'Incompatible Version');
    await prisma.contentDefinition.create({ data: {
      worldId: world.id, code: profile.code, contentType: ContentType.SKILL, status: ContentStatus.ACTIVE,
      versions: { create: {
        rulesetVersionId: alternate.id, contentProfileVersionId: profileVersion.id, versionNumber: 1,
        schemaVersion: 1, profileMode: 'MECHANICAL', name: profile.name, profile: profile as unknown as Prisma.InputJsonValue,
        presentation: {}, tags: [], metadata: {}, contentHash: 'd'.repeat(64),
      } },
    } });
    const incompatible = await authenticated(`/api/v1/content/http-incompatible-version?${seedScopeQuery}&contentType=skill`);
    expect(incompatible.status).toBe(409);
    expect(responseErrorMessage(incompatible)).toBe('Content version is not compatible with the Campaign ruleset');
  });

  it.each([
    'weapon', 'armor', 'shield', 'clothing', 'spell', 'skill', 'talent', 'item', 'consumable',
    'status_effect', 'race', 'class', 'creature_template',
  ] as const)('publishes canonical %s content through the HTTP contract', async (contentType) => {
    const code = `http-${contentType.replaceAll('_', '-')}`;
    const name = `HTTP ${contentType}`;
    const response = await post('/api/v1/content/upsert', {
      ...seedScope, campaignRef: null, idempotencyKey: `http-canonical-${contentType}-001`,
      contentType, code, name, description: 'Canonical test content.',
      profile: canonicalProfile(contentType, code, name), presentation: {},
      inventorySpec: canonicalInventorySpec(contentType),
      tags: contentType === 'weapon' ? ['weapon'] : [], status: 'draft', metadata: {},
    });
    expect(response.status).toBe(200);
    const responseBody = bodyRecord(response);
    expect(responseBody).toMatchObject({ code, contentType, versionNumber: 1 });
    expect(responseBody.profile).toMatchObject({ contentKind: contentType });
    expect(JSON.stringify(response.body)).not.toMatch(/contentHash|configHash|contentDefinitionId|contentVersionId|rulesetVersionId|[0-9a-f]{8}-[0-9a-f-]{27}/i);
  });

  it('publishes generic narrative content with a null profile and rejects parallel free mechanics', async () => {
    const generic = await post('/api/v1/content/upsert', {
      ...seedScope, campaignRef: null, idempotencyKey: 'http-generic-material-001', contentType: 'material',
      code: 'http-iron', name: 'Ferro', description: 'Material narrativo.', profile: null,
      inventorySpec: stackInventorySpec(),
      presentation: { appearance: 'Metal escuro.' }, tags: ['metal'], status: 'active', metadata: {},
    });
    expect(generic.status).toBe(200);
    expect(generic.body).toMatchObject({ code: 'http-iron', contentType: 'material', profile: null, versionNumber: 1 });

    const invalid = await post('/api/v1/content/upsert', {
      ...seedScope, campaignRef: null, idempotencyKey: 'http-free-mechanics-001', contentType: 'skill',
      code: 'http-free-mechanics', name: 'Free Mechanics', description: 'Inválido.',
      profile: activeProfile('skill', 'http-free-mechanics', 'Free Mechanics'), presentation: {}, tags: [], status: 'draft',
      mechanics: { damage: 999 }, requirements: { level: 1 }, schemaVersion: 99,
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    expect(JSON.stringify(invalid.body)).not.toContain('999');
  });

  it('returns structured profile issue paths for incompatible kinds and forbidden derived fields', async () => {
    const base = {
      ...seedScope, campaignRef: null, contentType: 'skill', code: 'http-invalid-profile', name: 'Invalid Profile',
      description: 'Inválido.', presentation: {}, tags: [], status: 'draft', metadata: {},
    };
    const mismatch = await post('/api/v1/content/upsert', {
      ...base, idempotencyKey: 'http-kind-mismatch-001', profile: activeProfile('spell', base.code, base.name),
    });
    const forbidden = await post('/api/v1/content/upsert', {
      ...base, idempotencyKey: 'http-derived-field-001', profile: { ...activeProfile('skill', base.code, base.name), finalDamage: 999 },
    });
    expect(mismatch.status).toBe(400);
    expect(forbidden.status).toBe(400);
    expect(JSON.stringify(mismatch.body)).toContain('profile.contentKind');
    expect(JSON.stringify(forbidden.body)).toContain('profile.finalDamage');
    expect(JSON.stringify(forbidden.body)).not.toContain('999');
  });

  it('distinguishes invalid, internal UUID and valid missing code references', async () => {
    const invalid = await authenticated(`/api/v1/actors/not%20valid?${seedScopeQuery}`);
    const internalUuid = await authenticated(`/api/v1/actors/11111111-1111-4111-8111-111111111111?${seedScopeQuery}`);
    const missing = await authenticated(`/api/v1/actors/missing-actor?${seedScopeQuery}`);
    expect(invalid.status).toBe(400);
    expect(internalUuid.status).toBe(400);
    expect(missing.status).toBe(404);
  });

  it('converts a real PostgreSQL failure to a safe HTTP error', async () => {
    const failingRepository: ActorRepository = {
      async findByReference() {
        await prisma.$queryRawUnsafe('SELECT * FROM "table_that_does_not_exist"');
        return null;
      },
      listContent: () => Promise.resolve([]),
    };
    const failingApp = createApp(config, { ...dependencies, actorRepository: failingRepository });
    const response = await request(failingApp).get(`/api/v1/actors/ralph?${seedScopeQuery}`).set('x-rpg-key', config.RPG_API_KEY);
    const serialized = JSON.stringify(response.body);
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
    expect(serialized).not.toMatch(/Prisma|SELECT|postgresql:\/\/|game_gpt_test|secret|stack/i);
  });
});

describe('GPT v1 persistence with real transactions', () => {
  const patch = (path: string, body: object) => request(app).patch(path).set('x-rpg-key', config.RPG_API_KEY).send({ ...seedScope, ...body });

  it('does not infer the only persisted save when scope refs are absent', async () => {
    const response = await request(app).post('/api/v1/game/load').set('x-rpg-key', config.RPG_API_KEY).send({});
    expect(response.status).toBe(400);
    const body = response.body as { error: { code: string; issues: Array<{ path: string }> } };
    expect(body.error.code).toBe('INVALID_INPUT');
    expect(body.error.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining(['playerRef', 'worldRef', 'campaignRef']));
  });

  it('loads normalized state with protagonist, actors, linked content and limited events', async () => {
    const response = await post('/api/v1/game/load', {});
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      player: { ref: 'ralph' }, world: { ref: 'elarion' }, campaign: { ref: 'main-campaign', status: 'active' },
      protagonist: { code: 'ralph', actorType: 'character' },
    });
    const body = response.body as Record<string, unknown>;
    expect(body.mainActors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'lyra', actorType: 'spirit' })]));
    expect(body.linkedContent).toEqual(expect.arrayContaining([expect.objectContaining({ actorRef: 'ralph', code: 'wind_breeze_step', state: 'learning' })]));
    expect(Array.isArray(body.recentEvents)).toBe(true);
    if (Array.isArray(body.recentEvents)) expect(body.recentEvents.length).toBeLessThanOrEqual(20);
    expect(JSON.stringify(response.body)).not.toMatch(/"id"|campaignId|worldId|actorId/);
  });

  it('starts a complete new scope idempotently and refuses incompatible reuse', async () => {
    const template = structuredStart('new');
    const body = { ...template, worldConfiguration: { ...template.worldConfiguration, worldTone: ['heroic', 'mysterious'] } };
    const first = await post('/api/v1/game/start', body);
    const retry = await post('/api/v1/game/start', body);
    expect(first.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    expect(first.body).toMatchObject({
      player: { ref: 'new-player' }, world: { ref: 'new-world' }, campaign: { ref: 'new-campaign', status: 'active' },
      protagonist: {
        code: 'new-player', actorType: 'character', level: 1, xp: 0,
        primaryAttributes: balancedPrimaryAttributes,
        resources: { hp: { current: 45, max: 45 }, mana: { current: 35, max: 35 }, sp: { current: 35, max: 35 } },
        mechanicsStateVersion: 3, ruleset: { code: 'core-v1', revision: 'RC1.1' },
        appearance: { summary: 'Manto de viagem.' }, personality: { traits: ['curioso'] },
      },
      mainActors: [], linkedContent: [expect.objectContaining({ actorRef: 'new-player', code: 'longbow' })],
      recentEvents: [expect.objectContaining({ eventType: 'campaign-started', actorRef: 'new-player' })],
    });
    await expect(prisma.player.count({ where: { slug: 'new-player' } })).resolves.toBe(1);
    await expect(prisma.idempotencyRecord.count({ where: { key: body.idempotencyKey } })).resolves.toBe(1);
    const createdActor = await prisma.actor.findFirstOrThrow({ where: { code: body.playerRef, campaign: { code: body.campaignRef } } });
    await expect(prisma.actorAttribute.count({ where: { actorId: createdActor.id } })).resolves.toBe(9);
    await expect(prisma.actorResource.count({ where: { actorId: createdActor.id } })).resolves.toBe(3);
    await expect(prisma.actorDerivedSnapshot.count({ where: { actorId: createdActor.id } })).resolves.toBe(1);
    await expect(prisma.inventoryEntry.count({ where: { actorId: createdActor.id, entryRef: 'longbow-1' } })).resolves.toBe(1);
    await expect(prisma.actorEquipmentSlot.count({ where: { actorId: createdActor.id, inventoryEntry: { entryRef: 'longbow-1' } } })).resolves.toBe(2);
    await expect(prisma.gameEvent.count({ where: { campaign: { code: body.campaignRef, world: { code: body.worldRef } }, eventType: 'campaign-started' } })).resolves.toBe(1);
    await expect(prisma.gameEvent.findFirstOrThrow({ where: { campaign: { code: body.campaignRef, world: { code: body.worldRef } }, eventType: 'campaign-started' } })).resolves.toMatchObject({ idempotencyKey: null });
    const persistedWorld = await prisma.world.findFirstOrThrow({
      where: { code: body.worldRef, player: { slug: body.playerRef } },
      include: { defaultRulesetVersion: { select: { code: true, revision: true, configHash: true } } },
    });
    const persistedCampaign = await prisma.campaign.findUniqueOrThrow({
      where: { worldId_code: { worldId: persistedWorld.id, code: body.campaignRef } },
      include: { rulesetVersion: { select: { code: true, revision: true, configHash: true } } },
    });
    expect(persistedWorld.defaultRulesetVersion).toEqual({ code: 'core-v1', revision: 'RC1.1', configHash: CORE_V1_CONFIG_HASH });
    expect(persistedCampaign.rulesetVersionId).toBe(persistedWorld.defaultRulesetVersionId);
    expect(persistedCampaign.rulesetVersion).toEqual(persistedWorld.defaultRulesetVersion);
    await expect(prisma.rulesetVersion.count({ where: { code: 'core-v1' } })).resolves.toBe(1);
    expect(JSON.stringify(first.body)).not.toMatch(/rulesetVersionId|defaultRulesetVersionId|configSnapshot|[0-9a-f]{8}-[0-9a-f-]{27,}/i);
    expect(JSON.stringify(first.body)).not.toMatch(/inputHash/);

    const conflict = await post('/api/v1/game/start', { ...body, campaignName: 'Outra Campanha' });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({ error: { code: 'CONFLICT', message: 'Idempotency key already used' } });
    const arrayOrderConflict = await post('/api/v1/game/start', {
      ...body, worldConfiguration: { ...body.worldConfiguration, worldTone: [...body.worldConfiguration.worldTone].reverse() },
    });
    expect(arrayOrderConflict.status).toBe(409);
    expect(responseErrorMessage(arrayOrderConflict)).toBe('Idempotency key already used');
  });

  it('starts with one-handed weapon, shield and potion stacks without creating ActorContent ownership', async () => {
    const body = structuredStart('inventory-start');
    const dagger = {
      ...weaponProfile('start-dagger', 'Adaga Inicial'), handedness: 'one_handed' as const, weaponTags: ['dagger'],
    };
    const packages = [
      {
        definition: {
          mode: 'create', scope: 'world', contentType: 'weapon', code: 'start-dagger', name: 'Adaga Inicial',
          description: 'Arma inicial.', profile: dagger,
          inventorySpec: uniqueInventorySpec(5, { equipmentSlots: ['main_hand'], handedness: 'one_handed' }),
          presentation: {}, tags: ['weapon'], status: 'active', metadata: {},
        },
      },
      {
        definition: {
          mode: 'create', scope: 'world', contentType: 'shield', code: 'start-shield', name: 'Escudo Inicial',
          description: 'Escudo inicial.', profile: canonicalProfile('shield', 'start-shield', 'Escudo Inicial'),
          inventorySpec: uniqueInventorySpec(8, { equipmentSlots: ['off_hand'] }),
          presentation: {}, tags: [], status: 'active', metadata: {},
        },
      },
      {
        definition: {
          mode: 'create', scope: 'world', contentType: 'consumable', code: 'start-potion', name: 'Poção Inicial',
          description: 'Poção inicial.', profile: canonicalProfile('consumable', 'start-potion', 'Poção Inicial'),
          inventorySpec: stackInventorySpec(2, 10), presentation: {}, tags: [], status: 'active', metadata: {},
        },
      },
    ];
    const initialInventory = [
      { scope: 'world', contentType: 'weapon', code: 'start-dagger', quantity: 1, entryRefs: ['start-dagger-1'], equip: { targetSlotRef: 'main_hand' } },
      { scope: 'world', contentType: 'shield', code: 'start-shield', quantity: 1, entryRefs: ['start-shield-1'], equip: { targetSlotRef: 'off_hand' } },
      { scope: 'world', contentType: 'consumable', code: 'start-potion', quantity: 15, entryRefs: ['start-potions-a', 'start-potions-b'] },
    ];
    const created = await post('/api/v1/game/start', { ...body, initialContentPackages: packages, initialInventory });
    const replay = await post('/api/v1/game/start', { ...body, initialContentPackages: packages, initialInventory });
    expect(created.status).toBe(200);
    expect(replay.body).toEqual(created.body);
    const inventory = await post(`/api/v1/actors/${body.playerRef}/inventory/manage`, {
      playerRef: body.playerRef, worldRef: body.worldRef, campaignRef: body.campaignRef, operation: 'get',
    });
    expect(inventory.status).toBe(200);
    expect(bodyRecord(inventory).entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ entryRef: 'start-dagger-1', state: 'equipped', equippedSlots: ['main_hand'] }),
      expect.objectContaining({ entryRef: 'start-shield-1', state: 'equipped', equippedSlots: ['off_hand'] }),
      expect.objectContaining({ entryRef: 'start-potions-a', quantity: 10 }),
      expect.objectContaining({ entryRef: 'start-potions-b', quantity: 5 }),
    ]));
    const actor = await prisma.actor.findFirstOrThrow({ where: { code: body.playerRef, campaign: { code: body.campaignRef } } });
    await expect(prisma.actorContent.count({ where: { actorId: actor.id } })).resolves.toBe(0);
    await expect(prisma.inventoryEntry.count({ where: { actorId: actor.id } })).resolves.toBe(4);
  });

  it('rejects invalid primary allocations, unknown attributes and client-derived mechanics', async () => {
    const base = structuredStart('mechanics-validation');
    const cases = [
      { ...base, idempotencyKey: 'integration-mechanics-089', protagonist: { ...base.protagonist, primaryAttributes: { ...balancedPrimaryAttributes, luck: 9 } } },
      { ...base, idempotencyKey: 'integration-mechanics-091', protagonist: { ...base.protagonist, primaryAttributes: { ...balancedPrimaryAttributes, luck: 11 } } },
      { ...base, idempotencyKey: 'integration-mechanics-unknown', protagonist: { ...base.protagonist, primaryAttributes: { ...balancedPrimaryAttributes, courage: 10 } } },
      { ...base, idempotencyKey: 'integration-mechanics-derived', protagonist: { ...base.protagonist, maxHp: 999 } },
      { ...base, idempotencyKey: 'integration-mechanics-level', protagonist: { ...base.protagonist, level: 20 } },
    ];
    for (const body of cases) {
      const response = await post('/api/v1/game/start', body);
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ error: { code: 'INVALID_INPUT' } });
      await expectNoCreatedIntent(body);
    }
  });

  it('never returns an empty idempotency response as a successful retry', async () => {
    const body = structuredStart('pending-response');
    const hash = createHash('sha256').update(JSON.stringify(canonicalize(body))).digest('hex');
    await prisma.idempotencyRecord.create({ data: { key: body.idempotencyKey, operation: 'game.start', requestHash: hash } });
    const response = await post('/api/v1/game/start', body);
    expect(response.status).toBe(409);
    expect(responseErrorMessage(response)).toBe('Idempotency request is not complete');
    await expect(prisma.player.count({ where: { slug: body.playerRef } })).resolves.toBe(0);
    await expect(prisma.world.count({ where: { code: body.worldRef } })).resolves.toBe(0);
    await expect(prisma.campaign.count({ where: { code: body.campaignRef } })).resolves.toBe(0);
    await expect(prisma.actor.count({ where: { campaign: { code: body.campaignRef } } })).resolves.toBe(0);
    await expect(prisma.contentDefinition.count({ where: { world: { code: body.worldRef } } })).resolves.toBe(0);
    await expect(prisma.actorContent.count({ where: { actor: { campaign: { code: body.campaignRef } } } })).resolves.toBe(0);
    await expect(prisma.gameEvent.count({ where: { campaign: { code: body.campaignRef } } })).resolves.toBe(0);
    await expect(prisma.idempotencyRecord.findUniqueOrThrow({ where: { key: body.idempotencyKey } })).resolves.toMatchObject({ response: {} });
  });

  it('creates a non-medieval game and returns the backend difficulty profile, origin and technical event', async () => {
    const body = structuredStart('neon', 'cyberpunk');
    const created = await post('/api/v1/game/start', body);
    const loaded = await post('/api/v1/game/load', { playerRef: body.playerRef, worldRef: body.worldRef, campaignRef: body.campaignRef });
    expect(created.status).toBe(200);
    expect(loaded.body).toEqual(created.body);
    expect(created.body).toMatchObject({
      world: { metadata: { worldConfig: { genres: ['cyberpunk'], magicLevel: { grade: 'none' } } } },
      campaign: { metadata: { campaignConfig: { difficulty: {
        preset: 'standard', overrides: { opponentCunning: 4 },
        effectiveProfile: { errorTolerance: 3, opponentCunning: 4, resourceAvailability: 3, lethality: 3, failureSeverity: 3, narrativeSafetyNet: 3 },
      } } } },
      protagonist: { metadata: { origin: { label: 'Sobrevivente' } }, appearance: { summary: 'Jaqueta urbana.' }, personality: { traits: ['cético'] } },
      recentEvents: [{ eventType: 'campaign-started', payload: { technical: true, initialPremise: body.initialPremise } }],
    });
    const event = await prisma.gameEvent.findFirstOrThrow({ where: { campaign: { code: body.campaignRef, world: { code: body.worldRef } }, eventType: 'campaign-started' } });
    expect(event.idempotencyKey).toBeNull();
    expect(jsonByteSize(event.payload)).toBeLessThanOrEqual(8 * 1024);
    expect(Object.keys(event.payload as Record<string, unknown>).sort()).toEqual([
      'campaignConfigSummary', 'difficultyPreset', 'difficultyProfile', 'initialContent', 'initialPremise',
      'schemaVersion', 'technical', 'worldConfigSummary',
    ]);
    expect(event.payload).toMatchObject({
      worldConfigSummary: { schemaVersion: 1, genres: ['cyberpunk'], technologyGrade: 'advanced', magicGrade: 'none' },
      campaignConfigSummary: {
        schemaVersion: 1, progressionPace: 'slow', narrativeTone: ['noir'], focus: ['investigation'],
        playerFreedom: 'open', consequenceLevel: 'serious', classMode: 'none',
      },
    });
    expect(JSON.stringify(event.payload)).not.toMatch(/excludedThemes|appearance|personality|origin|metadata|mechanics|requirements|presentation|idempotencyKey/);
    expect(JSON.stringify(created.body)).not.toMatch(/playerId|worldId|campaignId|actorId|contentDefinitionId|contentVersionId|contentHash/);
  });

  it('reuses Player, World and global content without updating persisted values', async () => {
    const beforePlayer = await prisma.player.findUniqueOrThrow({ where: { slug: 'new-player' } });
    const beforeWorld = await prisma.world.findUniqueOrThrow({ where: { playerId_code: { playerId: beforePlayer.id, code: 'new-world' } } });
    const reusePackage = {
      definition: { mode: 'reuse', scope: 'world', code: 'longbow', contentType: 'weapon' },
      protagonistLink: { state: 'known', rank: 0, progress: 0, mastery: 0, metadata: {} },
    };
    const body = { ...campaignInNewWorld('reuse', [reusePackage]), initialInventory: [{
      scope: 'world', contentType: 'weapon', code: 'longbow', quantity: 1, entryRefs: ['reuse-longbow-1'],
      equip: { targetSlotRef: 'main_hand' },
    }] };
    const response = await post('/api/v1/game/start', body);
    expect(response.status).toBe(200);
    expect(bodyRecord(response).linkedContent).toEqual([expect.objectContaining({ code: 'longbow' })]);
    await expect(prisma.player.findUniqueOrThrow({ where: { slug: 'new-player' } })).resolves.toMatchObject({ displayName: beforePlayer.displayName, updatedAt: beforePlayer.updatedAt });
    await expect(prisma.world.findUniqueOrThrow({ where: { id: beforeWorld.id } })).resolves.toMatchObject({
      name: beforeWorld.name, description: beforeWorld.description, metadata: beforeWorld.metadata, updatedAt: beforeWorld.updatedAt,
    });

    const mismatch = await post('/api/v1/game/start', { ...campaignInNewWorld('mismatch'), playerDisplayName: 'Changed Name' });
    expect(mismatch.status).toBe(409);
    expect(responseErrorMessage(mismatch)).toBe('Player display name does not match');
    await expect(prisma.player.findUniqueOrThrow({ where: { slug: 'new-player' } })).resolves.toMatchObject({ displayName: beforePlayer.displayName });
  });

  it('rejects reuse of a World bound to a non-core ruleset without changing it', async () => {
    const alternate = await createAlternateRulesetVersion('incompatible-world');
    const player = await prisma.player.create({ data: { slug: 'incompatible-player', displayName: 'Incompatible Player' } });
    const world = await prisma.world.create({
      data: {
        playerId: player.id, defaultRulesetVersionId: alternate.id,
        code: 'incompatible-world', name: 'Incompatible World',
      },
    });
    const template = structuredStart('incompatible-binding');
    const body = {
      ...template,
      playerMode: 'reuse', playerRef: player.slug, playerDisplayName: undefined,
      worldMode: 'reuse', worldRef: world.code, worldName: undefined, worldDescription: undefined, worldConfiguration: undefined,
      protagonist: { ...template.protagonist, code: player.slug },
    };
    const response = await post('/api/v1/game/start', body);
    expect(response.status).toBe(409);
    expect(responseErrorMessage(response)).toBe('World ruleset is not compatible with core-v1');
    await expect(prisma.world.findUniqueOrThrow({ where: { id: world.id } })).resolves.toMatchObject({
      defaultRulesetVersionId: alternate.id,
    });
    await expect(prisma.campaign.count({ where: { worldId: world.id } })).resolves.toBe(0);
    await expect(prisma.idempotencyRecord.count({ where: { key: body.idempotencyKey } })).resolves.toBe(0);
  });

  it('matches className against the persisted public name of a reused mechanical class', async () => {
    const player = await prisma.player.findUniqueOrThrow({ where: { slug: 'new-player' } });
    const world = await prisma.world.findUniqueOrThrow({ where: { playerId_code: { playerId: player.id, code: 'new-world' } } });
    const persistedClass = await publishTestContent({
      worldId: world.id, code: 'persisted-mage', name: 'Mago Persistido', contentType: ContentType.CLASS,
      profile: passiveProfile('class', 'persisted-mage', 'Mago Persistido'),
    });
    const classLink = {
      definition: { mode: 'reuse', scope: 'world', code: persistedClass.code, contentType: 'class' },
      protagonistLink: { state: 'known', rank: 1, progress: 0, mastery: 0, metadata: {} },
    };
    const template = campaignInNewWorld('mechanical-reuse', [classLink]);
    const mechanicalConfig = {
      ...template.campaignConfiguration,
      classModel: { mode: 'mechanical', startingClass: 'required', progressionBasis: ['class', 'content'], description: 'Classe mecânica.' },
    };
    const coherent = await post('/api/v1/game/start', {
      ...template, campaignConfiguration: mechanicalConfig, protagonist: { ...template.protagonist, className: persistedClass.versions[0]?.name },
    });
    expect(coherent.status).toBe(200);

    const mismatchTemplate = campaignInNewWorld('mechanical-mismatch', [classLink]);
    const mismatch = await post('/api/v1/game/start', {
      ...mismatchTemplate, campaignConfiguration: mechanicalConfig, protagonist: { ...mismatchTemplate.protagonist, className: 'Guerreiro' },
    });
    expect(mismatch.status).toBe(409);
    expect(responseErrorMessage(mismatch)).toBe('Mechanical class name does not match the persisted class definition');
    await expect(prisma.campaign.count({ where: { code: mismatchTemplate.campaignRef, worldId: world.id } })).resolves.toBe(0);
    await expect(prisma.actor.count({ where: { campaign: { code: mismatchTemplate.campaignRef, worldId: world.id } } })).resolves.toBe(0);
    await expect(prisma.actorContent.count({ where: { actor: { campaign: { code: mismatchTemplate.campaignRef, worldId: world.id } } } })).resolves.toBe(0);
    await expect(prisma.gameEvent.count({ where: { campaign: { code: mismatchTemplate.campaignRef, worldId: world.id } } })).resolves.toBe(0);
    await expect(prisma.idempotencyRecord.count({ where: { key: mismatchTemplate.idempotencyKey } })).resolves.toBe(0);
  });

  it('uses persisted requirements and mechanics when reusing World content', async () => {
    const player = await prisma.player.findUniqueOrThrow({ where: { slug: 'new-player' } });
    const world = await prisma.world.findUniqueOrThrow({ where: { playerId_code: { playerId: player.id, code: 'new-world' } } });
    const otherPlayer = await prisma.player.findUniqueOrThrow({ where: { slug: 'neon-player' } });
    const otherWorld = await prisma.world.findUniqueOrThrow({ where: { playerId_code: { playerId: otherPlayer.id, code: 'neon-world' } } });
    const [attributeDefinition, nonPhysicalDefinition] = await Promise.all([
      publishTestContent({
        worldId: world.id, code: 'attribute-gated', name: 'Técnica Intelectual', contentType: ContentType.SKILL,
        profile: activeProfile('skill', 'attribute-gated', 'Técnica Intelectual', { minimumPrimaryAttributes: { intelligence: 11 } }),
      }),
      publishTestContent({
        worldId: world.id, code: 'nonphysical-reuse', name: 'Item não físico', contentType: ContentType.ITEM,
        profile: canonicalProfile('item', 'nonphysical-reuse', 'Item não físico'),
      }),
      publishTestContent({
        worldId: otherWorld.id, code: 'foreign-only', name: 'Outro World', contentType: ContentType.SKILL,
        profile: activeProfile('skill', 'foreign-only', 'Outro World'),
      }),
      publishTestContent({
        worldId: world.id, code: 'typed-only', name: 'Mesmo code, outro tipo', contentType: ContentType.SPELL,
        profile: activeProfile('spell', 'typed-only', 'Mesmo code, outro tipo'),
      }),
    ]);
    const link = { state: 'known', rank: 1, progress: 0, mastery: 0, metadata: {} };
    const attributeBody = campaignInNewWorld('attribute-reuse', [{
      definition: { mode: 'reuse', scope: 'world', code: attributeDefinition.code, contentType: 'skill' }, protagonistLink: link,
    }]);
    const attributeFailure = await post('/api/v1/game/start', attributeBody);
    expect(attributeFailure.status).toBe(409);
    expect(responseErrorMessage(attributeFailure)).toBe('Initial attribute requirements are not met');

    const passiveBody = { ...campaignInNewWorld('passive-reuse', [{
      definition: { mode: 'reuse', scope: 'world', code: nonPhysicalDefinition.code, contentType: 'item' },
      protagonistLink: link,
    }]), initialInventory: [{ scope: 'world', contentType: 'item', code: nonPhysicalDefinition.code, quantity: 1, entryRefs: ['passive-reuse-1'] }] };
    const passiveFailure = await post('/api/v1/game/start', passiveBody);
    expect(passiveFailure.status).toBe(409);
    expect(responseErrorMessage(passiveFailure)).toBe('Inventory operation is invalid for the current state');

    const foreign = await post('/api/v1/game/start', campaignInNewWorld('foreign-reuse', [{
      definition: { mode: 'reuse', scope: 'world', code: 'foreign-only', contentType: 'skill' }, protagonistLink: link,
    }]));
    expect(foreign.status).toBe(404);
    const wrongType = await post('/api/v1/game/start', campaignInNewWorld('typed-reuse', [{
      definition: { mode: 'reuse', scope: 'world', code: 'typed-only', contentType: 'skill' }, protagonistLink: link,
    }]));
    expect(wrongType.status).toBe(404);

    const unchanged = await prisma.contentDefinition.findUniqueOrThrow({
      where: { id: nonPhysicalDefinition.id }, include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } },
    });
    expect(unchanged).toMatchObject({ updatedAt: nonPhysicalDefinition.updatedAt, versions: [{ name: 'Item não físico', versionNumber: 1 }] });
  });

  it('enforces create and reuse existence policies for Player and World', async () => {
    const createPlayer = structuredStart('create-existing-player');
    const existingPlayer = await post('/api/v1/game/start', { ...createPlayer, playerRef: 'new-player', protagonist: { ...createPlayer.protagonist, code: 'new-player' } });
    expect(existingPlayer.status).toBe(409);
    expect(responseErrorMessage(existingPlayer)).toBe('Player already exists');

    const missingPlayer = structuredStart('missing-player');
    const absentPlayer = await post('/api/v1/game/start', { ...missingPlayer, playerMode: 'reuse', playerDisplayName: undefined });
    expect(absentPlayer.status).toBe(404);

    const worldTemplate = campaignInNewWorld('create-existing-world');
    const existingWorld = await post('/api/v1/game/start', {
      ...worldTemplate, worldMode: 'create', worldName: 'Changed World', worldConfiguration: structuredStart('world-config').worldConfiguration,
    });
    expect(existingWorld.status).toBe(409);
    expect(responseErrorMessage(existingWorld)).toBe('World already exists');

    const absentWorld = await post('/api/v1/game/start', { ...worldTemplate, worldRef: 'missing-world' });
    expect(absentWorld.status).toBe(404);
  });

  it('creates an explicit Campaign override and rolls back an incoherent override', async () => {
    const override = structuredStart('override').initialContentPackages[0]!;
    const overridePackage = { ...override, definition: {
      ...override.definition, scope: 'campaign', code: 'longbow', name: 'Arco Longo da Campanha', overridesWorldDefinition: true,
      profile: { ...override.definition.profile, code: 'longbow', name: 'Arco Longo da Campanha' },
    } };
    const success = await post('/api/v1/game/start', campaignInNewWorld('override', [overridePackage]));
    expect(success.status).toBe(200);
    expect(bodyRecord(success).linkedContent).toEqual([expect.objectContaining({ code: 'longbow', name: 'Arco Longo da Campanha' })]);

    const missing = structuredStart('missing-override').initialContentPackages[0]!;
    const missingPackage = { ...missing, definition: {
      ...missing.definition, scope: 'campaign', code: 'absent-global', overridesWorldDefinition: true,
      profile: { ...missing.definition.profile, code: 'absent-global' },
    } };
    const failedTemplate = structuredStart('missing-override');
    const failedBody = { ...failedTemplate, initialContentPackages: [missingPackage], initialInventory: [] };
    const failed = await post('/api/v1/game/start', failedBody);
    expect(failed.status).toBe(409);
    await expectNoCreatedIntent(failedBody);
  });

  it('returns a domain conflict, not an idempotency conflict, for different keys racing on one Campaign', async () => {
    const base = campaignInNewWorld('campaign-race');
    const [left, right] = await Promise.all([
      post('/api/v1/game/start', { ...base, idempotencyKey: 'campaign-race-left-001' }),
      post('/api/v1/game/start', { ...base, idempotencyKey: 'campaign-race-right-001' }),
    ]);
    expect([left.status, right.status].sort()).toEqual([200, 409]);
    const conflict = left.status === 409 ? left : right;
    expect(responseErrorMessage(conflict)).not.toBe('Idempotency key already used');
    await expect(prisma.campaign.count({ where: { world: { code: 'new-world' }, code: base.campaignRef } })).resolves.toBe(1);
    await expect(prisma.ruleset.count({ where: { code: 'core' } })).resolves.toBe(1);
    await expect(prisma.rulesetVersion.count({ where: { code: 'core-v1' } })).resolves.toBe(1);
  });

  it('publishes one global definition idempotently when different campaigns race on the same snapshot', async () => {
    const basePackage = structuredStart('definition-race').initialContentPackages[0]!;
    const sharedPackage = { ...basePackage, definition: {
      ...basePackage.definition, code: 'race-global-weapon', name: 'Arma Global Concorrente',
      profile: { ...basePackage.definition.profile, code: 'race-global-weapon', name: 'Arma Global Concorrente' },
    } };
    const leftBody = campaignInNewWorld('definition-left', [sharedPackage]);
    const rightBody = campaignInNewWorld('definition-right', [sharedPackage]);
    const [left, right] = await Promise.all([post('/api/v1/game/start', leftBody), post('/api/v1/game/start', rightBody)]);
    expect([left.status, right.status]).toEqual([200, 200]);
    expect(bodyRecord(left).linkedContent).toEqual([expect.objectContaining({ code: 'race-global-weapon', versionNumber: 1 })]);
    expect(bodyRecord(right).linkedContent).toEqual([expect.objectContaining({ code: 'race-global-weapon', versionNumber: 1 })]);
    await expect(prisma.contentDefinition.count({ where: { world: { code: 'new-world' }, code: sharedPackage.definition.code } })).resolves.toBe(1);
  });

  it('rolls back every record after global reuse, link and technical event failures', async () => {
    const missingGlobalTemplate = structuredStart('missing-global-reuse');
    const missingGlobalBody = { ...missingGlobalTemplate, initialContentPackages: [{
      definition: { mode: 'reuse', scope: 'world', code: 'missing-global', contentType: 'skill' },
      protagonistLink: { state: 'known', rank: 1, progress: 0, mastery: 0, metadata: {} },
    }], initialInventory: [] };
    const missingGlobal = await post('/api/v1/game/start', missingGlobalBody);
    expect(missingGlobal.status).toBe(404);
    await expectNoCreatedIntent(missingGlobalBody);

    const newPlayer = await prisma.player.findUniqueOrThrow({ where: { slug: 'new-player' } });
    const newWorld = await prisma.world.findUniqueOrThrow({ where: { playerId_code: { playerId: newPlayer.id, code: 'new-world' } } });
    const passive = await publishTestContent({
      worldId: newWorld.id, code: 'nonphysical-reuse-test', name: 'Item não físico de teste', contentType: ContentType.ITEM,
      profile: canonicalProfile('item', 'nonphysical-reuse-test', 'Item não físico de teste'),
    });
    const beforeDefinitionCount = await prisma.contentDefinition.count({ where: { worldId: newWorld.id } });
    const linkTemplate = structuredStart('invalid-link');
    const invalidLinkBody = {
      ...linkTemplate, playerMode: 'reuse', playerRef: 'new-player', playerDisplayName: undefined,
      worldMode: 'reuse', worldRef: 'new-world', worldName: undefined, worldDescription: undefined, worldConfiguration: undefined,
      protagonist: { ...linkTemplate.protagonist, code: 'new-player' },
      initialContentPackages: [{
        definition: { mode: 'reuse', scope: 'world', code: 'nonphysical-reuse-test', contentType: 'item' },
        protagonistLink: { state: 'known', rank: 1, progress: 0, mastery: 0, metadata: {} },
      }],
      initialInventory: [{ scope: 'world', contentType: 'item', code: 'nonphysical-reuse-test', quantity: 1, entryRefs: ['invalid-passive-1'] }],
    };
    const invalidLink = await post('/api/v1/game/start', invalidLinkBody);
    expect(invalidLink.status).toBe(409);
    await expect(prisma.player.findUniqueOrThrow({ where: { id: newPlayer.id } })).resolves.toMatchObject({ displayName: newPlayer.displayName, updatedAt: newPlayer.updatedAt });
    await expect(prisma.world.findUniqueOrThrow({ where: { id: newWorld.id } })).resolves.toMatchObject({ name: newWorld.name, metadata: newWorld.metadata, updatedAt: newWorld.updatedAt });
    await expect(prisma.campaign.count({ where: { code: invalidLinkBody.campaignRef, worldId: newWorld.id } })).resolves.toBe(0);
    await expect(prisma.actor.count({ where: { campaign: { code: invalidLinkBody.campaignRef, worldId: newWorld.id } } })).resolves.toBe(0);
    await expect(prisma.actorContent.count({ where: { actor: { campaign: { code: invalidLinkBody.campaignRef, worldId: newWorld.id } } } })).resolves.toBe(0);
    await expect(prisma.gameEvent.count({ where: { campaign: { code: invalidLinkBody.campaignRef, worldId: newWorld.id } } })).resolves.toBe(0);
    await expect(prisma.contentDefinition.count({ where: { worldId: newWorld.id } })).resolves.toBe(beforeDefinitionCount);
    await expect(prisma.contentDefinition.findUniqueOrThrow({ where: { id: passive.id } })).resolves.toMatchObject({ updatedAt: passive.updatedAt });
    await expect(prisma.idempotencyRecord.count({ where: { key: invalidLinkBody.idempotencyKey } })).resolves.toBe(0);

    const eventTemplate = structuredStart('event-rollback');
    const multibyte = (index: number) => `${'😀'.repeat(48)}${String(index).padStart(2, '0')}`;
    const eventPackages = Array.from({ length: 24 }, (_, index) => {
      const basePackage = eventTemplate.initialContentPackages[0]!;
      const code = `event-${String(index).padStart(2, '0')}-${'x'.repeat(80)}`;
      const name = `Conteúdo ${index}`;
      return { ...basePackage, definition: {
        ...basePackage.definition, code, name, profile: { ...basePackage.definition.profile, code, name },
      } };
    });
    const eventBody = {
      ...eventTemplate,
      worldConfiguration: { ...eventTemplate.worldConfiguration, genres: Array.from({ length: 5 }, (_, index) => multibyte(index)) },
      campaignConfiguration: {
        ...eventTemplate.campaignConfiguration,
        narrativeTone: Array.from({ length: 5 }, (_, index) => multibyte(index)),
        focus: Array.from({ length: 8 }, (_, index) => multibyte(index)),
      },
      initialContentPackages: eventPackages, initialInventory: [], initialPremise: '😀'.repeat(500),
    };
    const eventFailure = await post('/api/v1/game/start', eventBody);
    expect(eventFailure.status).toBe(409);
    expect(responseErrorMessage(eventFailure)).toBe('Campaign start event exceeds the safe size limit');
    expect(JSON.stringify(eventFailure.body)).not.toContain('😀');
    await expectNoCreatedIntent(eventBody);
  });

  it('does not overwrite an existing campaign when starting a game', async () => {
    const key = 'integration-start-existing-001';
    const template = structuredStart('existing');
    const response = await post('/api/v1/game/start', {
      ...template, idempotencyKey: key, playerMode: 'reuse', playerRef: 'ralph', playerDisplayName: 'Ralph', worldMode: 'reuse',
      worldRef: 'elarion', worldName: 'Elarion', worldDescription: undefined, worldConfiguration: undefined,
      campaignRef: 'main-campaign', campaignName: 'Campanha Principal', protagonist: { ...template.protagonist, code: 'ralph' },
    });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: { code: 'CONFLICT', message: 'Campaign already exists' } });
    await expect(prisma.idempotencyRecord.count({ where: { key } })).resolves.toBe(0);

    const player = await prisma.player.findUniqueOrThrow({ where: { slug: 'ralph' } });
    const world = await prisma.world.findUniqueOrThrow({ where: { playerId_code: { playerId: player.id, code: 'elarion' } } });
    await prisma.campaign.create({
      data: { worldId: world.id, rulesetVersionId: world.defaultRulesetVersionId, code: 'empty-campaign', name: 'Empty Campaign' },
    });
    const emptyResponse = await post('/api/v1/game/start', { ...campaignInNewWorld('empty'), playerRef: 'ralph', worldRef: 'elarion', campaignRef: 'empty-campaign', protagonist: { ...campaignInNewWorld('empty').protagonist, code: 'ralph' } });
    expect(emptyResponse.status).toBe(409);
    await expect(prisma.campaign.findUniqueOrThrow({ where: { worldId_code: { worldId: world.id, code: 'empty-campaign' } } })).resolves.toMatchObject({ name: 'Empty Campaign', status: CampaignStatus.DRAFT });
  });

  it('lists campaign actors with normalized enums', async () => {
    const response = await authenticated('/api/v1/campaigns/main-campaign/actors?playerRef=ralph&worldRef=elarion');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'ralph', actorType: 'character', status: 'active' }),
      expect.objectContaining({ code: 'lyra', actorType: 'spirit', status: 'active' }),
    ]));
  });

  it('upserts one actor under concurrent retries and rejects incompatible key reuse', async () => {
    const body = { idempotencyKey: 'integration-actor-orin-001', code: 'orin', name: 'Orin', actorType: 'npc', level: 5, primaryAttributes: balancedPrimaryAttributes, role: 'Guardião', appearance: { eyes: 'cinzentos' }, personality: { traits: ['vigilante'] }, metadata: { zeta: 1, alpha: { second: 2, first: 1 } } };
    const reorderedBody = { metadata: { alpha: { first: 1, second: 2 }, zeta: 1 }, personality: { traits: ['vigilante'] }, appearance: { eyes: 'cinzentos' }, role: 'Guardião', primaryAttributes: { ...balancedPrimaryAttributes }, level: 5, actorType: 'npc', name: 'Orin', code: 'orin', idempotencyKey: 'integration-actor-orin-001' };
    const [first, retry] = await Promise.all([post('/api/v1/actors/upsert', body), post('/api/v1/actors/upsert', reorderedBody)]);
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    await expect(prisma.actor.count({ where: { code: 'orin' } })).resolves.toBe(1);
    await expect(prisma.idempotencyRecord.count({ where: { key: body.idempotencyKey } })).resolves.toBe(1);
    expect(first.body).toMatchObject({ level: 5, primaryAttributes: balancedPrimaryAttributes, appearance: { eyes: 'cinzentos' }, personality: { traits: ['vigilante'] }, resources: { hp: { current: 61, max: 61 } } });
    const persisted = await prisma.actor.findFirstOrThrow({ where: { code: 'orin' } });
    await expect(prisma.actorAttribute.count({ where: { actorId: persisted.id } })).resolves.toBe(9);
    await expect(prisma.actorResource.count({ where: { actorId: persisted.id } })).resolves.toBe(3);
    await expect(prisma.actorDerivedSnapshot.count({ where: { actorId: persisted.id } })).resolves.toBe(1);

    const conflict = await post('/api/v1/actors/upsert', { ...body, name: 'Outro Orin' });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({ error: { code: 'CONFLICT', message: 'Idempotency key already used' } });
  });

  it('patches only approved narrative fields idempotently and rejects mechanical authority', async () => {
    const body = { idempotencyKey: 'integration-actor-orin-patch-001', name: 'Orin, o Guardião', appearance: { hair: 'preto' }, personality: { traits: ['determinado'] } };
    const first = await patch('/api/v1/actors/orin', body);
    const retry = await patch('/api/v1/actors/orin', body);
    expect(first.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    expect(first.body).toMatchObject({ code: 'orin', name: 'Orin, o Guardião', level: 5, primaryAttributes: balancedPrimaryAttributes, appearance: { hair: 'preto' }, personality: { traits: ['determinado'] }, status: 'active' });
    expect(first.body).not.toHaveProperty('id');
    for (const mechanical of [{ health: 9 }, { level: 6 }, { xp: 25 }, { primaryAttributes: balancedPrimaryAttributes }, { resources: { hp: { current: 1 } } }]) {
      const rejected = await patch('/api/v1/actors/orin', { idempotencyKey: `integration-reject-${Object.keys(mechanical)[0]}-001`, ...mechanical });
      expect(rejected.status).toBe(400);
    }
  });

  it('recomputes one authoritative snapshot and detects stale, ruleset and resource drift safely', async () => {
    const actor = await prisma.actor.findFirstOrThrow({ where: { code: 'orin' }, include: { derivedSnapshot: true } });
    const originalHash = actor.derivedSnapshot?.inputHash;
    await prisma.$transaction(async (transaction) => {
      await transaction.actorAttribute.update({
        where: { actorId_code: { actorId: actor.id, code: 'STRENGTH' } },
        data: { earnedValue: 1 },
      });
      await transaction.actor.update({ where: { id: actor.id }, data: { mechanicsStateVersion: { increment: 1 } } });
      await recomputeActorDerivedSnapshot(transaction, actor.id);
    });
    const recomputed = await authenticated(`/api/v1/actors/orin?${seedScopeQuery}`);
    expect(recomputed.status).toBe(200);
    expect(recomputed.body).toMatchObject({ mechanicsStateVersion: 2, primaryAttributes: { strength: 11 } });
    const snapshot = await prisma.actorDerivedSnapshot.findUniqueOrThrow({ where: { actorId: actor.id } });
    expect(snapshot.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.inputHash).not.toBe(originalHash);
    expect(snapshot.mechanicsStateVersion).toBe(2);

    await prisma.actor.update({ where: { id: actor.id }, data: { mechanicsStateVersion: { increment: 1 } } });
    const stale = await authenticated(`/api/v1/actors/orin?${seedScopeQuery}`);
    expect(stale.status).toBe(500);
    expect(stale.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
    expect(JSON.stringify(stale.body)).not.toMatch(/inputHash|strength|[0-9a-f]{8}-[0-9a-f-]{27}/i);
    await prisma.$transaction((transaction) => recomputeActorDerivedSnapshot(transaction, actor.id));

    const alternate = await createAlternateRulesetVersion('snapshot-drift');
    await prisma.actorDerivedSnapshot.update({ where: { actorId: actor.id }, data: { rulesetVersionId: alternate.id } });
    const rulesetDrift = await authenticated(`/api/v1/actors/orin?${seedScopeQuery}`);
    expect(rulesetDrift.status).toBe(500);
    await prisma.$transaction((transaction) => recomputeActorDerivedSnapshot(transaction, actor.id));

    const currentSnapshot = await prisma.actorDerivedSnapshot.findUniqueOrThrow({ where: { actorId: actor.id } });
    const hp = await prisma.actorResource.findUniqueOrThrow({ where: { actorId_type: { actorId: actor.id, type: 'HP' } } });
    await prisma.actorResource.update({ where: { id: hp.id }, data: { current: currentSnapshot.maxHp + 1 } });
    expect((await authenticated(`/api/v1/actors/orin?${seedScopeQuery}`)).status).toBe(500);
    await prisma.actorResource.update({ where: { id: hp.id }, data: { current: currentSnapshot.maxHp } });
    expect((await authenticated(`/api/v1/actors/orin?${seedScopeQuery}`)).status).toBe(200);
  });

  it('enforces mechanics constraints and cascades actor-owned state', async () => {
    const ralph = await prisma.actor.findFirstOrThrow({ where: { code: 'ralph', campaign: { code: 'main-campaign' } } });
    const strength = await prisma.actorAttribute.findUniqueOrThrow({ where: { actorId_code: { actorId: ralph.id, code: 'STRENGTH' } } });
    await expect(prisma.actorAttribute.update({ where: { id: strength.id }, data: { earnedValue: 30 } })).rejects.toThrow();
    const hp = await prisma.actorResource.findUniqueOrThrow({ where: { actorId_type: { actorId: ralph.id, type: 'HP' } } });
    await expect(prisma.actorResource.update({ where: { id: hp.id }, data: { current: -1 } })).rejects.toThrow();
    await expect(prisma.actorDerivedSnapshot.update({ where: { actorId: ralph.id }, data: { inputHash: 'invalid' } })).rejects.toThrow();

    const campaign = await prisma.campaign.findFirstOrThrow({ where: { code: 'main-campaign' } });
    const temporary = await createMechanicalActor({ campaignId: campaign.id, code: 'cascade-actor', name: 'Cascade Actor', actorType: ActorType.NPC });
    await prisma.actor.delete({ where: { id: temporary.id } });
    await expect(Promise.all([
      prisma.actorAttribute.count({ where: { actorId: temporary.id } }),
      prisma.actorResource.count({ where: { actorId: temporary.id } }),
      prisma.actorDerivedSnapshot.count({ where: { actorId: temporary.id } }),
    ])).resolves.toEqual([0, 0, 0]);
  });

  it('upserts a complete content definition idempotently', async () => {
    const body = {
      ...seedScope, idempotencyKey: 'integration-content-quiet-step-001', contentType: 'skill', code: 'quiet-step', name: 'Passo Silencioso',
      description: 'Movimento discreto.', profile: {
        ...activeProfile('skill', 'quiet-step', 'Passo Silencioso', { minimumLevel: 1 }),
        description: 'Movimento discreto.', presentation: { sensory: 'Silencioso.' }, tags: ['stealth'],
      }, presentation: { sensory: 'Silencioso.' }, tags: ['stealth'], status: 'active',
    };
    const first = await post('/api/v1/content/upsert', body);
    const retry = await post('/api/v1/content/upsert', body);
    const deduplicated = await post('/api/v1/content/upsert', { ...body, idempotencyKey: 'integration-content-quiet-step-002' });
    const changed = await post('/api/v1/content/upsert', {
      ...body, idempotencyKey: 'integration-content-quiet-step-003', name: 'Passo Muito Silencioso',
      profile: { ...body.profile, name: 'Passo Muito Silencioso' },
    });
    expect(first.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    expect(first.body).toMatchObject({ code: 'quiet-step', contentType: 'skill', status: 'active', versionNumber: 1 });
    expect(deduplicated.body).toMatchObject({ code: 'quiet-step', versionNumber: 1 });
    expect(changed.body).toMatchObject({ code: 'quiet-step', name: 'Passo Muito Silencioso', versionNumber: 2 });
    await expect(prisma.contentDefinition.count({ where: { code: 'quiet-step' } })).resolves.toBe(1);
    await expect(prisma.contentVersion.count({ where: { contentDefinition: { code: 'quiet-step' } } })).resolves.toBe(2);
  });

  it('gets, lists, learns, updates and removes actor content', async () => {
    const getExisting = await post('/api/v1/actors/ralph/content/manage', { operation: 'get', contentRef: 'wind_breeze_step', contentType: 'skill' });
    const listExisting = await post('/api/v1/actors/ralph/content/manage', { operation: 'list' });
    expect(getExisting.body).toMatchObject({ code: 'wind_breeze_step', state: 'learning' });
    expect(listExisting.body).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'wind_breeze_step' })]));

    const learnBody = { operation: 'learn', contentRef: 'quiet-step', contentType: 'skill', idempotencyKey: 'integration-learn-quiet-step-001', changes: { progress: 5, notes: 'Primeiro treino' } };
    const learn = await post('/api/v1/actors/ralph/content/manage', learnBody);
    const learnRetry = await post('/api/v1/actors/ralph/content/manage', learnBody);
    expect(learn.status).toBe(200);
    expect(learnRetry.body).toEqual(learn.body);
    expect(learn.body).toMatchObject({ code: 'quiet-step', name: 'Passo Muito Silencioso', versionNumber: 2, state: 'learning', progress: 5 });

    const update = await post('/api/v1/actors/ralph/content/manage', { operation: 'update', contentRef: 'quiet-step', contentType: 'skill', idempotencyKey: 'integration-update-quiet-step-001', changes: { state: 'known', rank: 2, progress: 30, mastery: 4 } });
    const remove = await post('/api/v1/actors/ralph/content/manage', { operation: 'remove', contentRef: 'quiet-step', contentType: 'skill', idempotencyKey: 'integration-remove-quiet-step-001' });
    expect(update.body).toMatchObject({ state: 'known', rank: 2, progress: 30, mastery: 4 });
    expect(remove.body).toMatchObject({ actorRef: 'ralph', contentRef: 'quiet-step', removed: true });
    await expect(prisma.actorContent.count({ where: { contentDefinition: { code: 'quiet-step' } } })).resolves.toBe(0);
  });

  it('persists transactional inventory operations with optimistic versions and public refs', async () => {
    const world = await prisma.world.findFirstOrThrow({ where: { code: 'elarion', player: { slug: 'ralph' } } });
    const greatswordProfile = weaponProfile('inventory-greatsword', 'Montante de Inventário');
    await publishTestContent({
      worldId: world.id, contentType: ContentType.WEAPON, code: 'inventory-greatsword', name: 'Montante de Inventário',
      description: 'Arma inicial.', profile: greatswordProfile, tags: ['weapon'],
      inventorySpec: uniqueInventorySpec(12, { equipmentSlots: ['main_hand', 'off_hand'], handedness: 'two_handed' }),
    });
    await publishTestContent({
      worldId: world.id, contentType: ContentType.CONSUMABLE, code: 'inventory-potion', name: 'Poção de Inventário',
      profile: canonicalProfile('consumable', 'inventory-potion', 'Poção de Inventário'), inventorySpec: stackInventorySpec(30, 10),
    });
    await publishTestContent({
      worldId: world.id, contentType: ContentType.ITEM, code: 'inventory-strength-harness', name: 'Arnês de Força',
      profile: {
        ...(canonicalProfile('item', 'inventory-strength-harness', 'Arnês de Força') as Record<string, unknown>),
        passiveModifiers: [{ target: 'strength', amount: 1, sourceRule: 'equipped_content' }],
      },
      inventorySpec: uniqueInventorySpec(6, { equipmentSlots: ['chest', 'body'] }),
    });
    await publishTestContent({
      worldId: world.id, contentType: ContentType.ITEM, code: 'inventory-nonphysical', name: 'Item sem Spec',
      profile: canonicalProfile('item', 'inventory-nonphysical', 'Item sem Spec'),
    });

    const getInventory = () => post('/api/v1/actors/ralph/inventory/manage', { operation: 'get' });
    const initial = await getInventory();
    expect(initial.status).toBe(200);
    const initialSheet = await authenticated(`/api/v1/actors/ralph?${seedScopeQuery}`);
    const initialStrength = Number((bodyRecord(initialSheet).primaryAttributes as Record<string, unknown>).strength);
    const initialMechanicsVersion = Number(bodyRecord(initialSheet).mechanicsStateVersion);
    let version = Number(bodyRecord(initial).inventoryStateVersion);
    const grantWeaponBody = {
      operation: 'grant', idempotencyKey: 'inventory-http-grant-weapon-001', expectedInventoryStateVersion: version,
      contentRef: { scope: 'world', contentType: 'weapon', code: 'inventory-greatsword', versionNumber: 1 },
      quantity: 1, entryRefs: ['inventory-greatsword-1'],
    };
    const grantedWeapon = await post('/api/v1/actors/ralph/inventory/manage', grantWeaponBody);
    const grantReplay = await post('/api/v1/actors/ralph/inventory/manage', grantWeaponBody);
    expect(grantedWeapon.status).toBe(200);
    expect(grantReplay.body).toEqual(grantedWeapon.body);
    version = Number(bodyRecord(grantedWeapon).inventoryStateVersion);
    await expect(prisma.inventoryEntry.count({ where: { actor: { code: 'ralph' }, entryRef: 'inventory-greatsword-1' } })).resolves.toBe(1);

    const stale = await post('/api/v1/actors/ralph/inventory/manage', {
      operation: 'reserve', idempotencyKey: 'inventory-http-stale-001', expectedInventoryStateVersion: version - 1,
      entryRef: 'inventory-greatsword-1',
    });
    expect(stale.status).toBe(409);
    expect(responseErrorMessage(stale)).toBe('Inventory state version conflict');

    const equip = await post('/api/v1/actors/ralph/inventory/manage', {
      operation: 'equip', idempotencyKey: 'inventory-http-equip-001', expectedInventoryStateVersion: version,
      entryRef: 'inventory-greatsword-1', targetSlotRef: 'main_hand',
    });
    expect(equip.status).toBe(200);
    expect(bodyRecord(equip).entries).toEqual(expect.arrayContaining([expect.objectContaining({
      entryRef: 'inventory-greatsword-1', state: 'equipped', equippedSlots: ['main_hand', 'off_hand'],
    })]));
    const equippedSheet = await authenticated(`/api/v1/actors/ralph?${seedScopeQuery}`);
    expect((bodyRecord(equippedSheet).primaryAttributes as Record<string, unknown>).strength).toBe(initialStrength);
    expect(bodyRecord(equippedSheet).mechanicsStateVersion).toBe(initialMechanicsVersion + 2);
    version = Number(bodyRecord(equip).inventoryStateVersion);
    const equippedRow = await prisma.inventoryEntry.findFirstOrThrow({ where: { actor: { code: 'ralph' }, entryRef: 'inventory-greatsword-1' } });
    await expect(prisma.inventoryEntry.update({
      where: { id: equippedRow.id }, data: { instanceLifecycle: InventoryInstanceLifecycle.RESERVED },
    })).rejects.toThrow(/equipped/i);
    await expect(prisma.inventoryEntry.delete({ where: { id: equippedRow.id } })).rejects.toThrow(/equipped/i);
    const lyra = await prisma.actor.findFirstOrThrow({ where: { code: 'lyra', campaign: { code: 'main-campaign' } } });
    await expect(prisma.actorEquipmentSlot.create({
      data: { actorId: lyra.id, inventoryEntryId: equippedRow.id, slotRef: ActorEquipmentSlotRef.HEAD },
    })).rejects.toThrow();
    const equippedRemoval = await post('/api/v1/actors/ralph/inventory/manage', {
      operation: 'remove', idempotencyKey: 'inventory-http-remove-equipped-001', expectedInventoryStateVersion: version,
      entryRef: 'inventory-greatsword-1', quantity: 1,
    });
    expect(equippedRemoval.status).toBe(409);
    expect(Number(bodyRecord(await getInventory()).inventoryStateVersion)).toBe(version);

    for (const [operation, key, expectedState] of [
      ['unequip', 'inventory-http-unequip-001', 'available'],
      ['reserve', 'inventory-http-reserve-001', 'reserved'],
      ['release', 'inventory-http-release-001', 'available'],
      ['destroy', 'inventory-http-destroy-001', 'destroyed'],
    ] as const) {
      const response = await post('/api/v1/actors/ralph/inventory/manage', {
        operation, idempotencyKey: key, expectedInventoryStateVersion: version, entryRef: 'inventory-greatsword-1',
      });
      expect(response.status).toBe(200);
      expect(bodyRecord(response).entries).toEqual(expect.arrayContaining([expect.objectContaining({
        entryRef: 'inventory-greatsword-1', state: expectedState,
      })]));
      version = Number(bodyRecord(response).inventoryStateVersion);
    }
    const destroyedSheet = await authenticated(`/api/v1/actors/ralph?${seedScopeQuery}`);
    expect((bodyRecord(destroyedSheet).primaryAttributes as Record<string, unknown>).strength).toBe(initialStrength);
    expect(bodyRecord(destroyedSheet).mechanicsStateVersion).toBe(initialMechanicsVersion + 6);

    const harnessGrant = await post('/api/v1/actors/ralph/inventory/manage', {
      operation: 'grant', idempotencyKey: 'inventory-http-harness-grant-001', expectedInventoryStateVersion: version,
      contentRef: { scope: 'world', contentType: 'item', code: 'inventory-strength-harness', versionNumber: 1 },
      quantity: 1, entryRefs: ['inventory-strength-harness-1'],
    });
    expect(harnessGrant.status).toBe(200);
    version = Number(bodyRecord(harnessGrant).inventoryStateVersion);
    const harnessEquip = await post('/api/v1/actors/ralph/inventory/manage', {
      operation: 'equip', idempotencyKey: 'inventory-http-harness-equip-001', expectedInventoryStateVersion: version,
      entryRef: 'inventory-strength-harness-1', targetSlotRef: 'chest',
    });
    expect(harnessEquip.status).toBe(200);
    version = Number(bodyRecord(harnessEquip).inventoryStateVersion);
    expect((bodyRecord(await authenticated(`/api/v1/actors/ralph?${seedScopeQuery}`)).primaryAttributes as Record<string, unknown>).strength).toBe(initialStrength + 1);
    const harnessUnequip = await post('/api/v1/actors/ralph/inventory/manage', {
      operation: 'unequip', idempotencyKey: 'inventory-http-harness-unequip-001', expectedInventoryStateVersion: version,
      entryRef: 'inventory-strength-harness-1',
    });
    expect(harnessUnequip.status).toBe(200);
    version = Number(bodyRecord(harnessUnequip).inventoryStateVersion);
    expect((bodyRecord(await authenticated(`/api/v1/actors/ralph?${seedScopeQuery}`)).primaryAttributes as Record<string, unknown>).strength).toBe(initialStrength);

    const grantedStack = await post('/api/v1/actors/ralph/inventory/manage', {
      operation: 'grant', idempotencyKey: 'inventory-http-grant-stack-001', expectedInventoryStateVersion: version,
      contentRef: { scope: 'world', contentType: 'consumable', code: 'inventory-potion', versionNumber: 1 },
      quantity: 25, entryRefs: ['inventory-potions-a', 'inventory-potions-b', 'inventory-potions-c'],
    });
    expect(grantedStack.status).toBe(200);
    expect((bodyRecord(grantedStack).entries as Array<Record<string, unknown>>)
      .filter((entry) => String(entry.entryRef).startsWith('inventory-potions-')).map((entry) => entry.quantity)).toEqual([10, 10, 5]);
    expect((bodyRecord(grantedStack).encumbrance as Record<string, unknown>).state).not.toBe('normal');
    version = Number(bodyRecord(grantedStack).inventoryStateVersion);
    const stackRow = await prisma.inventoryEntry.findFirstOrThrow({ where: { actor: { code: 'ralph' }, entryRef: 'inventory-potions-a' } });
    await expect(prisma.inventoryEntry.update({ where: { id: stackRow.id }, data: { quantity: 11 } })).rejects.toThrow(/maxStack/i);
    await expect(prisma.actorEquipmentSlot.create({
      data: { actorId: stackRow.actorId, inventoryEntryId: stackRow.id, slotRef: ActorEquipmentSlotRef.HEAD },
    })).rejects.toThrow(/instance/i);
    const inventoryRules = await prisma.inventoryRulesVersion.findUniqueOrThrow({ where: { code: 'core-v1-inventory-v1' } });
    await expect(prisma.inventoryRulesVersion.update({ where: { id: inventoryRules.id }, data: { configHash: '0'.repeat(64) } })).rejects.toThrow(/immutable/i);
    const physicalVersion = await prisma.contentVersion.findFirstOrThrow({ where: { contentDefinition: { code: 'inventory-potion' } } });
    await expect(prisma.contentVersion.update({ where: { id: physicalVersion.id }, data: { inventorySpec: { changed: true } } })).rejects.toThrow(/immutable/i);
    const stackOperations = [
      { operation: 'remove', idempotencyKey: 'inventory-http-remove-partial-001', entryRef: 'inventory-potions-a', quantity: 4 },
      { operation: 'split', idempotencyKey: 'inventory-http-split-001', entryRef: 'inventory-potions-a', quantity: 2, newEntryRef: 'inventory-potions-split' },
      { operation: 'merge', idempotencyKey: 'inventory-http-merge-001', sourceEntryRef: 'inventory-potions-split', targetEntryRef: 'inventory-potions-a' },
      { operation: 'remove', idempotencyKey: 'inventory-http-remove-full-001', entryRef: 'inventory-potions-b', quantity: 10 },
      { operation: 'remove', idempotencyKey: 'inventory-http-remove-a-001', entryRef: 'inventory-potions-a', quantity: 6 },
      { operation: 'remove', idempotencyKey: 'inventory-http-remove-c-001', entryRef: 'inventory-potions-c', quantity: 5 },
    ] as const;
    for (const operation of stackOperations) {
      const response = await post('/api/v1/actors/ralph/inventory/manage', { ...operation, expectedInventoryStateVersion: version });
      expect(response.status).toBe(200);
      version = Number(bodyRecord(response).inventoryStateVersion);
    }
    const final = await getInventory();
    expect(final.status).toBe(200);
    expect((bodyRecord(final).encumbrance as Record<string, unknown>).state).toBe('normal');
    expect(JSON.stringify(final.body)).not.toMatch(/inventoryEntryId|contentVersionId|inventoryRulesVersionId|inventorySpecHash|inputHash|[0-9a-f]{8}-[0-9a-f-]{27}/i);

    const concurrencyGrant = await post('/api/v1/actors/ralph/inventory/manage', {
      operation: 'grant', idempotencyKey: 'inventory-http-concurrency-grant-001', expectedInventoryStateVersion: version,
      contentRef: { scope: 'world', contentType: 'weapon', code: 'inventory-greatsword', versionNumber: 1 },
      quantity: 2, entryRefs: ['inventory-concurrency-a', 'inventory-concurrency-b'],
    });
    expect(concurrencyGrant.status).toBe(200);
    version = Number(bodyRecord(concurrencyGrant).inventoryStateVersion);
    const [concurrentA, concurrentB] = await Promise.all([
      post('/api/v1/actors/ralph/inventory/manage', {
        operation: 'reserve', idempotencyKey: 'inventory-http-concurrency-a-001', expectedInventoryStateVersion: version,
        entryRef: 'inventory-concurrency-a',
      }),
      post('/api/v1/actors/ralph/inventory/manage', {
        operation: 'reserve', idempotencyKey: 'inventory-http-concurrency-b-001', expectedInventoryStateVersion: version,
        entryRef: 'inventory-concurrency-b',
      }),
    ]);
    expect([concurrentA.status, concurrentB.status].sort()).toEqual([200, 409]);
    const concurrencyState = await getInventory();
    version = Number(bodyRecord(concurrencyState).inventoryStateVersion);
    expect(version).toBe(Number(bodyRecord(concurrencyGrant).inventoryStateVersion) + 1);
    await expect(prisma.inventoryEntry.count({
      where: { actor: { code: 'ralph' }, entryRef: { in: ['inventory-concurrency-a', 'inventory-concurrency-b'] }, instanceLifecycle: 'RESERVED' },
    })).resolves.toBe(1);

    const alternateRuleset = await createAlternateRulesetVersion('inventory-entry-ruleset');
    const incompatibleInventoryRules = await prisma.inventoryRulesVersion.create({ data: {
      rulesetVersionId: alternateRuleset.id, code: 'test-incompatible-inventory-rules', schemaVersion: 1,
      configHash: 'd'.repeat(64), configSnapshot: { test: true },
    } });
    const contentProfileVersion = await prisma.contentProfileVersion.findUniqueOrThrow({ where: { code: 'core-v1-content-v1' } });
    const incompatibleDefinition = await prisma.contentDefinition.create({ data: {
      worldId: world.id, code: 'incompatible-inventory-rules-item', contentType: ContentType.ITEM, status: ContentStatus.ACTIVE,
    } });
    const incompatibleVersion = await prisma.contentVersion.create({ data: {
      contentDefinitionId: incompatibleDefinition.id, rulesetVersionId: world.defaultRulesetVersionId,
      contentProfileVersionId: contentProfileVersion.id, inventoryRulesVersionId: incompatibleInventoryRules.id,
      versionNumber: 1, schemaVersion: 1, profileMode: 'GENERIC', name: 'Item de Ruleset Incompatível',
      profile: Prisma.DbNull, presentation: {}, tags: [], metadata: {}, contentHash: 'e'.repeat(64),
      inventorySpec: uniqueInventorySpec(), inventorySpecHash: 'f'.repeat(64),
    } });
    const ralphActor = await prisma.actor.findFirstOrThrow({ where: { code: 'ralph', campaign: { code: 'main-campaign' } } });
    await expect(prisma.inventoryEntry.create({ data: {
      actorId: ralphActor.id, entryRef: 'incompatible-rules-entry', contentVersionId: incompatibleVersion.id,
      inventoryRulesVersionId: incompatibleInventoryRules.id, entryKind: InventoryEntryKind.INSTANCE,
      quantity: 1, instanceLifecycle: InventoryInstanceLifecycle.AVAILABLE,
    } })).rejects.toThrow(/ruleset/i);

    const noSpec = await post('/api/v1/actors/ralph/inventory/manage', {
      operation: 'grant', idempotencyKey: 'inventory-http-no-spec-001', expectedInventoryStateVersion: version,
      contentRef: { scope: 'world', contentType: 'item', code: 'inventory-nonphysical', versionNumber: 1 }, quantity: 1, entryRefs: ['nonphysical-item'],
    });
    expect(noSpec.status).toBe(409);
    const missingVersion = await post('/api/v1/actors/ralph/inventory/manage', {
      operation: 'grant', idempotencyKey: 'inventory-http-missing-version-001', expectedInventoryStateVersion: version,
      contentRef: { scope: 'world', contentType: 'consumable', code: 'inventory-potion', versionNumber: 999 }, quantity: 1, entryRefs: ['missing-version'],
    });
    expect(missingVersion.status).toBe(404);
  });

  it('rolls back the idempotency reservation when the related mutation fails', async () => {
    const key = 'integration-rollback-link-001';
    const failed = await post('/api/v1/actors/missing/content/manage', { operation: 'learn', contentRef: 'quiet-step', contentType: 'skill', idempotencyKey: key });
    expect(failed.status).toBe(404);
    await expect(prisma.idempotencyRecord.count({ where: { key } })).resolves.toBe(0);
  });

  it('persists one event for repeated and concurrent idempotent requests', async () => {
    const body = { campaignRef: 'main-campaign', actorRef: 'ralph', eventType: 'quiet-step-trained', title: 'Treino concluído', payload: { progress: 30 }, idempotencyKey: 'integration-event-training-001' };
    const [first, retry] = await Promise.all([post('/api/v1/events', body), post('/api/v1/events', body)]);
    expect(first.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    expect(first.body).toMatchObject({ campaignRef: 'main-campaign', actorRef: 'ralph', eventType: 'quiet-step-trained' });
    await expect(prisma.gameEvent.count({ where: { idempotencyKey: body.idempotencyKey } })).resolves.toBe(1);
  });

  it('isolates repeated world, campaign, actor and content codes across every public read', async () => {
    const rulesetVersion = await prisma.$transaction((transaction) => ensureCoreV1RulesetVersion(transaction));
    const player = await prisma.player.create({ data: { slug: 'scope-player', displayName: 'Scope Player' } });
    const otherPlayer = await prisma.player.create({ data: { slug: 'other-player', displayName: 'Other Player' } });
    const [worldOne, worldTwo] = await Promise.all([
      prisma.world.create({ data: { playerId: player.id, defaultRulesetVersionId: rulesetVersion.id, code: 'world-one', name: 'World One', description: 'Primeiro mundo' } }),
      prisma.world.create({ data: { playerId: player.id, defaultRulesetVersionId: rulesetVersion.id, code: 'world-two', name: 'World Two', description: 'Segundo mundo' } }),
      prisma.world.create({ data: { playerId: otherPlayer.id, defaultRulesetVersionId: rulesetVersion.id, code: 'foreign-world', name: 'Foreign World' } }),
    ]);
    const [campaignOne, campaignTwo] = await Promise.all([
      prisma.campaign.create({ data: { worldId: worldOne.id, rulesetVersionId: worldOne.defaultRulesetVersionId, code: 'shared-campaign', name: 'Campaign One', status: CampaignStatus.ACTIVE } }),
      prisma.campaign.create({ data: { worldId: worldTwo.id, rulesetVersionId: worldTwo.defaultRulesetVersionId, code: 'shared-campaign', name: 'Campaign Two', status: CampaignStatus.PAUSED } }),
      prisma.campaign.create({ data: { worldId: worldOne.id, rulesetVersionId: worldOne.defaultRulesetVersionId, code: 'global-campaign', name: 'Global Fallback', status: CampaignStatus.DRAFT } }),
    ]);
    const [actorOne, actorTwo] = await Promise.all([
      createMechanicalActor({ campaignId: campaignOne.id, code: 'shared-hero', name: 'Hero One', actorType: ActorType.CHARACTER }),
      createMechanicalActor({ campaignId: campaignTwo.id, code: 'shared-hero', name: 'Hero Two', actorType: ActorType.CHARACTER }),
    ]);
    const [globalSkill, campaignSkill, campaignSpell, foreignSkill] = await Promise.all([
      publishTestContent({ worldId: worldOne.id, code: 'shared-power', name: 'Global Skill', contentType: ContentType.SKILL, profile: activeProfile('skill', 'shared-power', 'Global Skill') }),
      publishTestContent({ worldId: worldOne.id, campaignId: campaignOne.id, code: 'shared-power', name: 'Campaign Skill', contentType: ContentType.SKILL, profile: activeProfile('skill', 'shared-power', 'Campaign Skill') }),
      publishTestContent({ worldId: worldOne.id, campaignId: campaignOne.id, code: 'shared-power', name: 'Campaign Spell', contentType: ContentType.SPELL, profile: activeProfile('spell', 'shared-power', 'Campaign Spell') }),
      publishTestContent({ worldId: worldTwo.id, campaignId: campaignTwo.id, code: 'shared-power', name: 'Foreign Skill', contentType: ContentType.SKILL, profile: activeProfile('skill', 'shared-power', 'Foreign Skill') }),
    ]);
    await Promise.all([
      prisma.actorContent.create({ data: { actorId: actorOne.id, contentDefinitionId: campaignSkill.id, contentVersionId: campaignSkill.versions[0]!.id, state: ActorContentState.KNOWN } }),
      prisma.actorContent.create({ data: { actorId: actorTwo.id, contentDefinitionId: foreignSkill.id, contentVersionId: foreignSkill.versions[0]!.id, state: ActorContentState.MASTERED } }),
    ]);

    const [missingLoadScope, missingActorScope] = await Promise.all([
      request(app).post('/api/v1/game/load').set('x-rpg-key', config.RPG_API_KEY).send({}),
      authenticated('/api/v1/actors/shared-hero'),
    ]);
    expect(missingLoadScope.status).toBe(400);
    expect(missingActorScope.status).toBe(400);
    expect(missingLoadScope.body).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    expect(missingActorScope.body).toMatchObject({ error: { code: 'INVALID_INPUT' } });

    const oneQuery = 'playerRef=scope-player&worldRef=world-one&campaignRef=shared-campaign';
    const twoQuery = 'playerRef=scope-player&worldRef=world-two&campaignRef=shared-campaign';
    const [actorFromOne, characterFromTwo, contentFromOne, contentFromTwo] = await Promise.all([
      authenticated(`/api/v1/actors/shared-hero?${oneQuery}`),
      authenticated(`/api/v1/characters/shared-hero?${twoQuery}`),
      authenticated(`/api/v1/characters/shared-hero/content?${oneQuery}`),
      authenticated(`/api/v1/characters/shared-hero/content?${twoQuery}`),
    ]);
    expect(actorFromOne.body).toMatchObject({ code: 'shared-hero', name: 'Hero One', resources: { hp: { current: 45, max: 45 } } });
    expect(characterFromTwo.body).toMatchObject({ code: 'shared-hero', name: 'Hero Two', resources: { hp: { current: 45, max: 45 } } });
    expect(contentFromOne.body).toEqual([expect.objectContaining({ code: 'shared-power', name: 'Campaign Skill', state: 'known' })]);
    expect(contentFromTwo.body).toEqual([expect.objectContaining({ code: 'shared-power', name: 'Foreign Skill', state: 'mastered' })]);

    const [specific, globalFallback, typedSpell, foreign] = await Promise.all([
      authenticated(`/api/v1/content/shared-power?${oneQuery}&contentType=skill`),
      authenticated('/api/v1/content/shared-power?playerRef=scope-player&worldRef=world-one&campaignRef=global-campaign&contentType=skill'),
      authenticated(`/api/v1/content/shared-power?${oneQuery}&contentType=spell`),
      authenticated(`/api/v1/content/shared-power?${twoQuery}&contentType=skill`),
    ]);
    expect(specific.body).toMatchObject({ name: 'Campaign Skill', contentType: 'skill' });
    expect(globalFallback.body).toMatchObject({ name: 'Global Skill', contentType: 'skill' });
    expect(typedSpell.body).toMatchObject({ name: 'Campaign Spell', contentType: 'spell' });
    expect(foreign.body).toMatchObject({ name: 'Foreign Skill', contentType: 'skill' });
    expect(globalSkill.id).not.toBe(campaignSkill.id);
    expect(campaignSpell.id).not.toBe(campaignSkill.id);

    const [worlds, campaigns] = await Promise.all([
      authenticated('/api/v1/players/scope-player/worlds'),
      authenticated('/api/v1/players/scope-player/worlds/world-one/campaigns'),
    ]);
    expect(worlds.body).toEqual([
      { ref: 'world-one', name: 'World One', description: 'Primeiro mundo' },
      { ref: 'world-two', name: 'World Two', description: 'Segundo mundo' },
    ]);
    expect(campaigns.body).toEqual([
      { ref: 'global-campaign', name: 'Global Fallback', status: 'draft', currentTime: null, hasProtagonist: false },
      { ref: 'shared-campaign', name: 'Campaign One', status: 'active', currentTime: null, hasProtagonist: false },
    ]);

    const missingResponses = await Promise.all([
      authenticated('/api/v1/players/missing-player/worlds'),
      authenticated('/api/v1/players/scope-player/worlds/missing-world/campaigns'),
      authenticated('/api/v1/actors/shared-hero?playerRef=scope-player&worldRef=world-one&campaignRef=missing-campaign'),
      authenticated(`/api/v1/actors/missing-actor?${oneQuery}`),
      authenticated(`/api/v1/content/missing-content?${oneQuery}&contentType=skill`),
    ]);
    expect(missingResponses.map((response) => response.status)).toEqual([404, 404, 404, 404, 404]);
    const missingMessages = missingResponses.map((response) => (response.body as { error?: { message?: string } }).error?.message);
    expect(missingMessages).toEqual([
      'Player not found', 'World not found', 'Campaign not found', 'Actor not found', 'Content not found',
    ]);
    expect(JSON.stringify([
      actorFromOne.body, characterFromTwo.body, contentFromOne.body, contentFromTwo.body,
      specific.body, globalFallback.body, typedSpell.body, foreign.body, worlds.body, campaigns.body,
    ])).not.toMatch(/"id"|playerId|worldId|campaignId|actorId|contentDefinitionId/);
  });

  it('keeps the current Mundo Cardinal refs loadable with explicit scope', async () => {
    const player = await prisma.player.findUniqueOrThrow({ where: { slug: 'ralph' } });
    const rulesetVersion = await prisma.$transaction((transaction) => ensureCoreV1RulesetVersion(transaction));
    const world = await prisma.world.create({ data: { playerId: player.id, defaultRulesetVersionId: rulesetVersion.id, code: 'mundo-cardinal', name: 'Mundo Cardinal' } });
    const campaign = await prisma.campaign.create({ data: { worldId: world.id, rulesetVersionId: world.defaultRulesetVersionId, code: 'harem-perfeito', name: 'Harém Perfeito', status: CampaignStatus.ACTIVE } });
    await createMechanicalActor({ campaignId: campaign.id, code: 'ralph', name: 'Ralph', actorType: ActorType.CHARACTER });

    const response = await post('/api/v1/game/load', { playerRef: 'ralph', worldRef: 'mundo-cardinal', campaignRef: 'harem-perfeito' });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      player: { ref: 'ralph' }, world: { ref: 'mundo-cardinal' }, campaign: { ref: 'harem-perfeito' },
      protagonist: { code: 'ralph', actorType: 'character' },
    });
    expect(JSON.stringify(response.body)).not.toMatch(/"id"|playerId|worldId|campaignId|actorId/);
  });
});

describe('authoritative effect persistence', () => {
  async function expectedState(actorId: string) {
    const actor = await prisma.actor.findUniqueOrThrow({ where: { id: actorId } });
    const resources = await prisma.actorResource.findMany({ where: { actorId } });
    const version = (type: 'HP' | 'MANA' | 'SP') => resources.find((resource) => resource.type === type)?.stateVersion;
    return {
      mechanicsStateVersion: actor.mechanicsStateVersion,
      inventoryStateVersion: actor.inventoryStateVersion,
      effectsStateVersion: actor.effectsStateVersion,
      resourceStateVersions: { hp: version('HP'), mana: version('MANA'), sp: version('SP') },
    };
  }

  it('resolves same-payload status dependencies even when the source package appears first', async () => {
    const statusCode = 'start-bound-status';
    const statusDefinition = {
      mode: 'create', scope: 'campaign', contentType: 'status_effect', code: statusCode,
      name: 'Status Inicial Vinculado', description: 'Status criado no mesmo startGame.',
      profile: {
        schemaVersion: 1, rulesetCode: 'core-v1', profileMode: 'mechanical', contentKind: 'status_effect',
        code: statusCode, name: 'Status Inicial Vinculado', description: 'Status criado no mesmo startGame.',
        tier: 1, rarity: 'common', activation: { type: 'passive' }, cost: { type: 'none' },
        duration: { type: 'actions', value: 2 }, stacking: { type: 'refresh' },
        passiveModifiers: [{ target: 'evasion', amount: -1, sourceRule: 'status_effect' }],
      },
      presentation: {}, tags: ['start'], status: 'active', metadata: {},
    } as const;
    const spellCode = 'start-bound-spell';
    const spellDefinition = {
      mode: 'create', scope: 'campaign', contentType: 'spell', code: spellCode,
      name: 'Magia Inicial Vinculada', description: 'Aplica status do mesmo payload.',
      profile: {
        schemaVersion: 1, rulesetCode: 'core-v1', profileMode: 'mechanical', contentKind: 'spell',
        code: spellCode, name: 'Magia Inicial Vinculada', description: 'Aplica status do mesmo payload.',
        tier: 1, rarity: 'common', activation: { type: 'active' }, cost: { type: 'mana', amount: 3 }, actionProfile: 'normal',
        targeting: { type: 'single_target', rangeBand: 'near', maxTargets: 1 },
        effects: [{ type: 'apply_status', statusRef: statusCode, duration: { type: 'actions', value: 2 }, stacking: { type: 'refresh' } }],
      },
      presentation: {}, tags: ['start'], status: 'active', metadata: {},
    } as const;
    const body = {
      ...structuredStart('effect-start'),
      idempotencyKey: 'start-effect-binding-001',
      initialContentPackages: [
        { definition: spellDefinition, protagonistLink: { state: 'known', rank: 1, progress: 0, mastery: 0, metadata: {} } },
        { definition: statusDefinition },
      ],
      initialInventory: [],
    };
    const response = await post('/api/v1/game/start', body);
    expect(response.status).toBe(200);
    const spell = await prisma.contentDefinition.findFirstOrThrow({
      where: { code: spellCode, world: { code: 'effect-start-world' } },
      include: { versions: { include: { sourceEffectBindings: { include: { targetContentDefinition: true, targetContentVersion: true } } } } },
    });
    expect(spell.versions).toHaveLength(1);
    expect(spell.versions[0]?.sourceEffectBindings[0]).toMatchObject({
      effectIndex: 0, bindingKind: 'APPLY_STATUS', targetContentDefinition: { code: statusCode },
      targetContentVersion: { versionNumber: 1 },
    });
  });

  it('pins status bindings by version and changes only the binding hash when the referenced status advances', async () => {
    const campaign = await prisma.campaign.findFirstOrThrow({ where: { code: 'main-campaign', world: { code: 'elarion', player: { slug: 'ralph' } } }, include: { world: true } });
    const statusInput = (amount: number) => ({
      worldId: campaign.world.id, campaignId: campaign.id, contentType: ContentType.STATUS_EFFECT,
      code: 'integration-bound-status', name: 'Status Vinculado', description: 'Status versionado para integração.',
      profile: {
        schemaVersion: 1, rulesetCode: 'core-v1', profileMode: 'mechanical', contentKind: 'status_effect',
        code: 'integration-bound-status', name: 'Status Vinculado', description: 'Status versionado para integração.',
        tier: 1, rarity: 'common', activation: { type: 'passive' }, cost: { type: 'none' },
        duration: { type: 'actions', value: 2 }, stacking: { type: 'refresh' },
        passiveModifiers: [{ target: 'physicalDefense', amount, sourceRule: 'status_effect' }],
      },
      presentation: {}, tags: ['integration'], status: ContentStatus.ACTIVE, metadata: {},
    } as const);
    const spellInput = {
      worldId: campaign.world.id, campaignId: campaign.id, contentType: ContentType.SPELL,
      code: 'integration-bound-spell', name: 'Magia Vinculada', description: 'Aplica status versionado.',
      profile: {
        schemaVersion: 1, rulesetCode: 'core-v1', profileMode: 'mechanical', contentKind: 'spell',
        code: 'integration-bound-spell', name: 'Magia Vinculada', description: 'Aplica status versionado.',
        tier: 1, rarity: 'common', activation: { type: 'active' }, cost: { type: 'mana', amount: 3 }, actionProfile: 'normal',
        targeting: { type: 'single_target', rangeBand: 'near', maxTargets: 1 },
        effects: [{ type: 'apply_status', statusRef: 'integration-bound-status', duration: { type: 'actions', value: 2 }, stacking: { type: 'refresh' } }],
      },
      presentation: {}, tags: ['integration'], status: ContentStatus.ACTIVE, metadata: {},
    } as const;
    await prisma.$transaction((transaction) => publishContentVersion(transaction, statusInput(-1)));
    const sourceV1 = await prisma.$transaction((transaction) => publishContentVersion(transaction, spellInput));
    await prisma.$transaction((transaction) => publishContentVersion(transaction, statusInput(-2)));
    const sourceV2 = await prisma.$transaction((transaction) => publishContentVersion(transaction, spellInput));
    const first = sourceV1.versions[0];
    const second = sourceV2.versions[0];
    if (first === undefined || second === undefined) throw new Error('Bound source versions are required');
    expect(first.versionNumber).toBe(1);
    expect(second.versionNumber).toBe(2);
    expect(first.contentHash).toBe(second.contentHash);
    expect(first.effectBindingHash).not.toBe(second.effectBindingHash);
    expect(first.sourceEffectBindings[0]?.targetContentVersion.versionNumber).toBe(1);
    expect(second.sourceEffectBindings[0]?.targetContentVersion.versionNumber).toBe(2);

    await expect(prisma.$transaction((transaction) => publishContentVersion(transaction, {
      ...spellInput, code: 'integration-missing-status-spell', name: 'Magia Inválida',
      profile: { ...spellInput.profile, code: 'integration-missing-status-spell', name: 'Magia Inválida', effects: [{ ...spellInput.profile.effects[0], statusRef: 'missing-integration-status' }] },
    }))).rejects.toMatchObject({ code: 'CONTENT_EFFECT_BINDING_UNRESOLVED' });
    await expect(prisma.contentDefinition.count({ where: { code: 'integration-missing-status-spell' } })).resolves.toBe(0);
  });

  it('applies an exact bound status atomically and replays without duplicate cost or state', async () => {
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { worldId_code: {
      worldId: (await prisma.world.findFirstOrThrow({ where: { code: 'elarion', player: { slug: 'ralph' } } })).id,
      code: 'main-campaign',
    } } });
    const source = await prisma.actor.findUniqueOrThrow({ where: { campaignId_code: { campaignId: campaign.id, code: 'ralph' } } });
    const target = await prisma.actor.findUniqueOrThrow({ where: { campaignId_code: { campaignId: campaign.id, code: 'lyra' } } });
    const beforeMana = await prisma.actorResource.findUniqueOrThrow({ where: { actorId_type: { actorId: source.id, type: 'MANA' } } });
    const body = {
      operation: 'execute_content', sourceActorRef: source.code, targetActorRef: target.code,
      contentRef: { contentType: 'spell', code: 'seed-mark-spell', versionNumber: 1 },
      expectedSourceState: await expectedState(source.id), expectedTargetState: await expectedState(target.id),
      idempotencyKey: 'integration-effect-mark-001',
    };
    const first = await post('/api/v1/actors/effects/resolve', body);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      operation: 'execute_content', content: { contentType: 'spell', code: 'seed-mark-spell', versionNumber: 1 },
      source: { actorRef: 'ralph' }, target: { actorRef: 'lyra' },
      activeEffectChanges: [expect.objectContaining({ change: 'created', stacksAfter: 1 })],
      rolls: [], defeatedCandidate: false,
    });
    expect(JSON.stringify(first.body)).not.toMatch(/"id"|contentVersionId|effectRulesVersionId|resultHash|requestHash|configHash|"profile"|"payload"/i);
    const [afterMana, persisted, resolutions, rolls] = await Promise.all([
      prisma.actorResource.findUniqueOrThrow({ where: { actorId_type: { actorId: source.id, type: 'MANA' } } }),
      prisma.activeEffect.findMany({ where: { targetActorId: target.id }, include: { effectContentVersion: { include: { contentDefinition: true } } } }),
      prisma.effectResolution.count({ where: { idempotencyKey: body.idempotencyKey } }),
      prisma.effectRoll.count(),
    ]);
    expect(afterMana.current).toBe(beforeMana.current - 3);
    expect(afterMana.stateVersion).toBe(beforeMana.stateVersion + 1);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.effectContentVersion?.contentDefinition.code).toBe('seed-arcane-mark');
    expect(resolutions).toBe(1);
    expect(rolls).toBe(0);

    const replay = await post('/api/v1/actors/effects/resolve', body);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    await expect(prisma.activeEffect.count({ where: { targetActorId: target.id } })).resolves.toBe(1);
    await expect(prisma.effectResolution.count({ where: { idempotencyKey: body.idempotencyKey } })).resolves.toBe(1);
    await expect(prisma.actorResource.findUniqueOrThrow({ where: { actorId_type: { actorId: source.id, type: 'MANA' } } }))
      .resolves.toMatchObject({ current: afterMana.current, stateVersion: afterMana.stateVersion });

    const beforeRead = await expectedState(target.id);
    const read = await post('/api/v1/actors/effects/resolve', { operation: 'get', sourceActorRef: target.code });
    expect(read.status).toBe(200);
    const readBody = bodyRecord(read);
    expect(readBody).toMatchObject({
      operation: 'get', actorRef: 'lyra', effectsStateVersion: beforeRead.effectsStateVersion,
      resources: { hp: { stateVersion: beforeRead.resourceStateVersions.hp } },
    });
    if (!Array.isArray(readBody.activeEffects)) throw new Error('Active effects response must be an array');
    const readEffect = bodyRecord({ body: readBody.activeEffects[0] });
    expect(readEffect.kind).toBe('status');
    expect(bodyRecord({ body: readEffect.statusContent })).toMatchObject({ code: 'seed-arcane-mark', versionNumber: 1 });
    expect(await expectedState(target.id)).toEqual(beforeRead);
  });

  it('rejects stale optimistic tokens without generating a resolution or changing resources', async () => {
    const source = await prisma.actor.findFirstOrThrow({ where: { code: 'ralph', campaign: { code: 'main-campaign', world: { code: 'elarion' } } } });
    const target = await prisma.actor.findFirstOrThrow({ where: { code: 'lyra', campaignId: source.campaignId } });
    const sourceState = await expectedState(source.id);
    const before = await prisma.actorResource.findMany({ where: { actorId: source.id }, orderBy: { type: 'asc' } });
    const response = await post('/api/v1/actors/effects/resolve', {
      operation: 'execute_content', sourceActorRef: source.code, targetActorRef: target.code,
      contentRef: { contentType: 'spell', code: 'seed-mark-spell', versionNumber: 1 },
      expectedSourceState: { ...sourceState, mechanicsStateVersion: sourceState.mechanicsStateVersion - 1 },
      expectedTargetState: await expectedState(target.id), idempotencyKey: 'integration-effect-stale-001',
    });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: { code: 'CONFLICT' } });
    expect(await prisma.actorResource.findMany({ where: { actorId: source.id }, orderBy: { type: 'asc' } })).toEqual(before);
    await expect(prisma.effectResolution.count({ where: { idempotencyKey: 'integration-effect-stale-001' } })).resolves.toBe(0);
  });

  it('persists authoritative hit and critical rolls and replays without rerolling', async () => {
    const source = await prisma.actor.findFirstOrThrow({ where: { code: 'ralph', campaign: { code: 'main-campaign', world: { code: 'elarion' } } } });
    const target = await prisma.actor.findFirstOrThrow({ where: { code: 'lyra', campaignId: source.campaignId } });
    const currentInventory = source.inventoryStateVersion;
    const equipped = await post(`/api/v1/actors/${source.code}/inventory/manage`, {
      operation: 'equip', entryRef: 'starter-dagger-1', targetSlotRef: 'main_hand',
      expectedInventoryStateVersion: currentInventory, idempotencyKey: 'integration-equip-dagger-001',
    });
    expect(equipped.status).toBe(200);
    const body = {
      operation: 'execute_content', sourceActorRef: source.code, targetActorRef: target.code,
      contentRef: { contentType: 'weapon', code: 'starter-dagger', versionNumber: 1 },
      expectedSourceState: await expectedState(source.id), expectedTargetState: await expectedState(target.id),
      idempotencyKey: 'integration-effect-dagger-001',
    };
    const first = await post('/api/v1/actors/effects/resolve', body);
    expect(first.status).toBe(200);
    const firstBody = bodyRecord(first);
    if (!Array.isArray(firstBody.rolls)) throw new Error('Effect rolls response must be an array');
    expect(firstBody.rolls).toHaveLength(2);
    const publicRolls = firstBody.rolls.map((roll) => bodyRecord({ body: roll }));
    expect(publicRolls.map((roll) => roll.kind)).toEqual(['hit', 'critical']);
    for (const roll of publicRolls) {
      expect(roll).toMatchObject({ ordinal: 0 });
      expect(typeof roll.rollBps === 'number' && roll.rollBps >= 1 && roll.rollBps <= 10_000).toBe(true);
      expect(typeof roll.chanceBps).toBe('number');
      expect(typeof roll.success).toBe('boolean');
    }
    const persisted = await prisma.effectResolution.findUniqueOrThrow({
      where: { idempotencyKey: body.idempotencyKey }, include: { rolls: { orderBy: { kind: 'asc' } } },
    });
    expect(persisted.rolls).toHaveLength(2);
    expect(persisted.resultHash).toMatch(/^[0-9a-f]{64}$/);
    const replay = await post('/api/v1/actors/effects/resolve', body);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    await expect(prisma.effectRoll.count({ where: { effectResolutionId: persisted.id } })).resolves.toBe(2);
    await expect(prisma.actor.findUniqueOrThrow({ where: { id: target.id } })).resolves.toMatchObject({ status: 'ACTIVE' });
    await expect(prisma.effectResolution.update({ where: { id: persisted.id }, data: { resultHash: '0'.repeat(64) } }))
      .rejects.toThrow('immutable');
    await expect(prisma.effectRoll.update({ where: { id: persisted.rolls[0]!.id }, data: { rollBps: 1 } }))
      .rejects.toThrow('immutable');
  });

  it('restores HP and consumes a stack entry in the same idempotent transaction', async () => {
    const source = await prisma.actor.findFirstOrThrow({ where: { code: 'ralph', campaign: { code: 'main-campaign', world: { code: 'elarion' } } }, include: { campaign: { include: { world: true } } } });
    const potion = await prisma.$transaction((transaction) => publishContentVersion(transaction, {
      worldId: source.campaign.world.id, campaignId: source.campaignId, contentType: ContentType.CONSUMABLE,
      code: 'integration-healing-potion', name: 'Poção de Cura de Integração', description: 'Restaura HP em teste.',
      profile: {
        schemaVersion: 1, rulesetCode: 'core-v1', profileMode: 'mechanical', contentKind: 'consumable',
        code: 'integration-healing-potion', name: 'Poção de Cura de Integração', description: 'Restaura HP em teste.',
        tier: 1, rarity: 'common', activation: { type: 'active' }, cost: { type: 'none' }, actionProfile: 'potion',
        consumable: true, effects: [{ type: 'restore_resource', resource: 'hp', amount: 10, targeting: { type: 'self', rangeBand: 'self' } }],
      },
      inventorySpec: { ...inventorySpecBase, unitWeight: 1, stacking: { mode: 'stackable', maxStack: 20 } },
      presentation: {}, tags: ['integration'], status: ContentStatus.ACTIVE, metadata: {},
    }));
    const potionVersion = potion.versions[0];
    if (potionVersion === undefined) throw new Error('Integration potion version is required');
    const actorBeforeGrant = await prisma.actor.findUniqueOrThrow({ where: { id: source.id } });
    const grant = await post(`/api/v1/actors/${source.code}/inventory/manage`, {
      operation: 'grant', expectedInventoryStateVersion: actorBeforeGrant.inventoryStateVersion,
      idempotencyKey: 'integration-grant-potion-001',
      contentRef: { scope: 'campaign', contentType: 'consumable', code: potion.code, versionNumber: potionVersion.versionNumber },
      quantity: 1, entryRefs: ['integration-potion-stack'],
    });
    expect(grant.status).toBe(200);
    const hp = await prisma.actorResource.findUniqueOrThrow({ where: { actorId_type: { actorId: source.id, type: 'HP' } } });
    const reducedHp = Math.max(0, hp.current - 10);
    await prisma.actorResource.update({ where: { id: hp.id }, data: { current: reducedHp, stateVersion: { increment: 1 } } });
    const body = {
      operation: 'use_consumable', sourceActorRef: source.code, targetActorRef: source.code,
      inventoryEntryRef: 'integration-potion-stack', expectedSourceState: await expectedState(source.id),
      idempotencyKey: 'integration-use-potion-001',
    };
    const first = await post('/api/v1/actors/effects/resolve', body);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      operation: 'use_consumable', source: { actorRef: source.code }, target: { actorRef: source.code },
      inventoryChanges: [{ entryRef: 'integration-potion-stack', change: 'consumed' }], rolls: [],
    });
    await expect(prisma.inventoryEntry.findUnique({ where: { actorId_entryRef: { actorId: source.id, entryRef: 'integration-potion-stack' } } })).resolves.toBeNull();
    await expect(prisma.actorResource.findUniqueOrThrow({ where: { id: hp.id } })).resolves.toMatchObject({ current: hp.current });
    const replay = await post('/api/v1/actors/effects/resolve', body);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    await expect(prisma.effectResolution.count({ where: { idempotencyKey: body.idempotencyKey } })).resolves.toBe(1);
  });
});

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
  ActorResourceType,
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
import { loadGameSchema, startGameSchema } from '../../src/modules/gpt/gpt.schemas.js';
import { canonicalize, jsonByteSize } from '../../src/modules/gpt/gpt.start-game.js';
import { prismaReadinessCheck } from '../../src/modules/health/health.repository.js';
import { createEncounterService, encounterService } from '../../src/modules/encounters/encounter.service.js';
import { RecordingEncounterRollProvider } from '../../src/modules/encounters/encounter-roll-provider.js';
import { createEncounterHttpService } from '../../src/modules/encounters/encounter-http.service.js';
import { manageEncounterSchema } from '../../src/modules/encounters/encounter-http.schemas.js';
import type { EncounterPublicDto } from '../../src/modules/encounters/encounter-http.dto.js';
import {
  ACTIVE_ENCOUNTER_LIFECYCLES,
  type EncounterDto,
} from '../../src/modules/encounters/encounter.types.js';
import { getOfficialContract } from '../../src/modules/openapi/openapi.routes.js';
import { lockActorAuthorities } from '../../src/modules/encounters/encounter.repository.js';
import {
  createCoreV1EncounterSnapshotHash,
  parseCoreV1EncounterSnapshot,
  serializeCoreV1EncounterState,
} from '../../src/modules/encounters/encounter-state-snapshot.js';
import {
  ensureCoreV1RulesetVersion,
  ensureCurrentCoreRulesetVersion,
} from '../../src/modules/rules/ruleset.registry.js';
import { CORE_V1_CONFIG_HASH, CORE_V1_CONFIG_SNAPSHOT } from '../../src/modules/rules/core-v1/core-v1.manifest.js';
import { CORE_V1_2_CONFIG_HASH } from '../../src/modules/rules/core-v1/core-v1.progression-v2.manifest.js';
import {
  calculateSecondaryAttributes,
  cancelCoreV1Encounter,
  createCoreV1EmptyEquipmentLoadout,
  getInitialAttributePreset,
  CORE_V1_2_TECHNICAL_LEVEL_MAXIMUM,
  nextCoreV12LevelXp,
} from '../../src/modules/rules/core-v1/index.js';
import { disconnectPrisma, prisma } from '../../src/shared/database/prisma.js';
import { canonicalJson } from '../../src/shared/json/canonical-json.js';
import {
  createOperationTelemetryContext,
  observeOperation,
  operationTelemetrySnapshot,
  runWithOperationTelemetry,
} from '../../src/shared/observability/operation-observability.js';

const config = parseConfig(process.env);
const { Client } = pg;
const dependencies = {
  actorRepository: prismaActorRepository,
  contentRepository: prismaContentRepository,
  gptRepository: prismaGptRepository,
  readiness: prismaReadinessCheck,
  encounterHttpService: createEncounterHttpService(encounterService),
};
const app = createApp(config, dependencies);
const server = app.listen(0);
const api = request(server);
const authenticated = (path: string) => api.get(path).set('x-rpg-key', config.RPG_API_KEY);
const post = (path: string, body: object) => api.post(path).set('x-rpg-key', config.RPG_API_KEY).send({ ...seedScope, ...body });
function bodyRecord(response: { body: unknown }): Record<string, unknown> {
  return response.body !== null && typeof response.body === 'object' ? response.body as Record<string, unknown> : {};
}
function responseErrorMessage(response: { body: unknown }): unknown {
  const error = bodyRecord(response).error;
  return error !== null && typeof error === 'object' ? (error as Record<string, unknown>).message : undefined;
}

async function measureEncounterOperation<T>(work: () => Promise<T>) {
  const context = createOperationTelemetryContext();
  const startedAt = performance.now();
  const value = await runWithOperationTelemetry(
    context,
    () => observeOperation('manageEncounter', work),
  );
  const metrics = operationTelemetrySnapshot(context);
  if (metrics === undefined) throw new Error('Encounter telemetry snapshot is required');
  return {
    value,
    metrics,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    responseBytes: Buffer.byteLength(JSON.stringify(value), 'utf8'),
  };
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

interface BeatFixtureSetupContext {
  readonly world: { readonly id: string; readonly code: string };
  readonly campaign: { readonly id: string; readonly code: string };
  readonly hero: { readonly id: string; readonly code: string; readonly inventoryStateVersion: number };
  readonly scope: { readonly playerRef: string; readonly worldRef: string; readonly campaignRef: string };
}

async function createBeatNpcFixture(
  suffix: string,
  npcCount: number,
  beforeEncounter?: (context: BeatFixtureSetupContext) => Promise<void>,
  createOperation: (work: () => Promise<EncounterDto>) => Promise<EncounterDto> = (work) => work(),
) {
  const rulesetVersion = await prisma.$transaction((transaction) => ensureCoreV1RulesetVersion(transaction));
  const player = await prisma.player.create({
    data: { slug: `beat-${suffix}-player`, displayName: `Beat ${suffix} Player` },
  });
  const world = await prisma.world.create({
    data: {
      playerId: player.id, defaultRulesetVersionId: rulesetVersion.id,
      code: `beat-${suffix}-world`, name: `Beat ${suffix} World`,
    },
  });
  const campaign = await prisma.campaign.create({
    data: {
      worldId: world.id, rulesetVersionId: rulesetVersion.id,
      code: `beat-${suffix}-campaign`, name: `Beat ${suffix} Campaign`, status: CampaignStatus.ACTIVE,
    },
  });
  const heroRef = `beat-${suffix}-hero`;
  const hero = await createMechanicalActor({
    campaignId: campaign.id, code: heroRef, name: `Beat ${suffix} Hero`, actorType: ActorType.CHARACTER,
  });
  const npcRefs: string[] = [];
  for (let index = 1; index <= npcCount; index += 1) {
    const actorRef = `beat-${suffix}-npc-${String(index)}`;
    const npc = await createMechanicalActor({
      campaignId: campaign.id, code: actorRef, name: `Beat ${suffix} NPC ${String(index)}`,
      actorType: ActorType.CREATURE,
    });
    await prisma.actor.update({ where: { id: npc.id }, data: { metadata: { tactic: 'defensive' } } });
    npcRefs.push(actorRef);
  }
  const scope = { playerRef: player.slug, worldRef: world.code, campaignRef: campaign.code };
  await beforeEncounter?.({ world, campaign, hero, scope });
  const encounterRef = `beat-${suffix}-encounter`;
  const participants = [
    { bindingKind: 'persisted_actor' as const, actorRef: heroRef, sideRef: 'party', zone: 'near' as const },
    ...npcRefs.map((actorRef) => ({
      bindingKind: 'persisted_actor' as const, actorRef, sideRef: 'hostile', zone: 'near' as const,
    })),
  ];
  const actorRefs = [heroRef, ...npcRefs].sort();
  const relations = actorRefs.flatMap((leftActorRef, leftIndex) => (
    actorRefs.slice(leftIndex).map((rightActorRef) => ({
      leftActorRef,
      rightActorRef,
      relation: leftActorRef === rightActorRef ? 'self' as const
        : leftActorRef === heroRef || rightActorRef === heroRef ? 'hostile' as const : 'ally' as const,
    }))
  ));
  const created = await createOperation(() => encounterService.create({
    ...scope, encounterRef, idempotencyKey: `beat-${suffix}-create`, partySideRef: 'party',
    participants, relations,
  }));
  return { scope, encounterRef, heroRef, npcRefs, created, world, campaign, hero };
}

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => {
    if (error === undefined) resolve();
    else reject(error);
  }));
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

  it('records the Phase 1M-B unbounded progression migration as successfully applied', async () => {
    const migration = await prisma.$queryRaw<Array<{ finished_at: Date | null }>>`
      SELECT finished_at FROM "_prisma_migrations"
      WHERE migration_name = '20260724210000_unbounded_actor_progression' AND rolled_back_at IS NULL
    `;
    expect(migration[0]?.finished_at).toBeInstanceOf(Date);
  });

  it('installs the widened actor checks and semantic XP-source protections', async () => {
    const constraints = await prisma.$queryRaw<Array<{ conname: string; definition: string }>>`
      SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conname IN (
        'Actor_level_check',
        'ActorAttribute_baseValue_check',
        'ActorAttribute_effective_cap_check',
        'GameEvent_xp_source_pair_check'
      )
      ORDER BY conname
    `;
    expect(constraints.map((constraint) => constraint.conname)).toEqual([
      'ActorAttribute_baseValue_check',
      'Actor_level_check',
      'GameEvent_xp_source_pair_check',
    ]);
    expect(constraints.find((constraint) => constraint.conname === 'Actor_level_check')?.definition)
      .toContain('level >= 1');
    expect(constraints.find((constraint) => constraint.conname === 'Actor_level_check')?.definition)
      .toContain('level <= 20722');
    expect(constraints.find((constraint) => constraint.conname === 'ActorAttribute_baseValue_check')?.definition)
      .toContain('"baseValue" >= 4');
    expect(constraints.find((constraint) => constraint.conname === 'ActorAttribute_baseValue_check')?.definition)
      .toContain('"baseValue" <= 16');
    const pairDefinition = constraints.find((constraint) => constraint.conname === 'GameEvent_xp_source_pair_check')?.definition;
    expect(pairDefinition).toContain('"xpSourceType" IS NULL');
    expect(pairDefinition).toContain('"xpSourceRef" IS NULL');
    expect(pairDefinition).toContain('"xpSourceType" IS NOT NULL');
    expect(pairDefinition).toContain('"xpSourceRef" IS NOT NULL');

    const indexes = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'GameEvent_actorId_xpSourceType_xpSourceRef_key'
    `;
    expect(indexes[0]?.indexdef).toContain('UNIQUE INDEX');
    expect(indexes[0]?.indexdef).toContain('("actorId", "xpSourceType", "xpSourceRef")');
    expect(indexes[0]?.indexdef).toContain('"actorId" IS NOT NULL');
    expect(indexes[0]?.indexdef).toContain('"xpSourceType" IS NOT NULL');
    expect(indexes[0]?.indexdef).toContain('"xpSourceRef" IS NOT NULL');

    const campaign = await prisma.campaign.findFirstOrThrow({ select: { id: true } });
    await expect(prisma.gameEvent.create({
      data: {
        campaignId: campaign.id,
        eventType: 'invalid-xp-source-pair',
        title: 'Invalid pair must roll back',
        xpSourceType: 'manual',
      },
    })).rejects.toThrow();
    await expect(prisma.gameEvent.count({ where: { eventType: 'invalid-xp-source-pair' } })).resolves.toBe(0);
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
      'ActorDerivedSnapshot_inputHash_check', 'ActorResource_current_check',
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
      data: { ...common, encounterRef: 'failed-one', lifecycleStatus: EncounterLifecycleStatus.FAILED },
    })).resolves.toBeTruthy();
    await expect(prisma.encounter.create({
      data: { ...common, encounterRef: 'failed-two', lifecycleStatus: EncounterLifecycleStatus.FAILED },
    })).resolves.toBeTruthy();
    await expect(prisma.encounter.create({
      data: { ...common, encounterRef: 'failed-one', lifecycleStatus: EncounterLifecycleStatus.CANCELLED },
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
    const fixture = await createEncounterFixture('encounter-checks', EncounterLifecycleStatus.FAILED);
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
    const fixture = await createEncounterFixture('snapshot-size', EncounterLifecycleStatus.FAILED);
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
  it('creates an assisted combat with canonical sides, bilateral hostility and an immediate first action', async () => {
    const encounterRef = 'phase-assisted-combat';
    const created = await post('/api/v1/encounters/manage', {
      operation: 'create',
      encounterRef,
      idempotencyKey: 'phase-assisted-create-0001',
      setupMode: 'assisted',
      encounterKind: 'combat',
      partyActorRefs: ['ralph'],
      hostileActorRefs: ['lyra'],
      objective: 'Stop Lyra without changing the saved actors.',
      engagementPreference: 'immediate',
      protectedActorRefs: ['ralph'],
      environmentalContext: { summary: 'A controlled training circle.', tags: ['training'] },
    });
    let cleanupNeeded = created.status === 200;
    try {
      expect(created.status).toBe(200);
      const createdBody = created.body as EncounterPublicDto;
      expect(createdBody).toMatchObject({
        operation: 'create',
        scene: {
          schemaVersion: 2,
          objective: 'Stop Lyra without changing the saved actors.',
        },
      });
      const setup = createdBody.setupSummary;
      if (setup === undefined) throw new Error('Assisted setup summary is required');
      expect(setup.setupMode).toBe('assisted');
      expect(setup.sides).toEqual([
        { sideRef: 'party', actorRefs: ['ralph'] },
        { sideRef: 'hostile', actorRefs: ['lyra'] },
      ]);
      expect(setup.zones).toEqual([
        { actorRef: 'lyra', zone: 'engaged' },
        { actorRef: 'ralph', zone: 'engaged' },
      ]);
      expect(setup.blockers).toEqual([]);
      expect(setup.relations).toContainEqual(
        { leftActorRef: 'lyra', rightActorRef: 'ralph', relation: 'hostile' },
      );
      expect(setup.firstAvailableActions.length).toBeGreaterThan(0);
      await expect(prisma.encounterOperation.count({ where: { encounter: { encounterRef } } })).resolves.toBe(1);
      const cancelled = await post('/api/v1/encounters/manage', {
        operation: 'cancel',
        encounterRef,
        idempotencyKey: 'phase-assisted-cancel-0001',
        expectedStateVersion: createdBody.stateVersion,
      });
      expect(cancelled.status).toBe(200);
      cleanupNeeded = false;
    } finally {
      if (cleanupNeeded) {
        const persisted = await prisma.encounter.findFirst({
          where: { encounterRef },
          select: { lifecycleStatus: true, stateVersion: true },
        });
        if (persisted !== null && ACTIVE_ENCOUNTER_LIFECYCLES.includes(
          persisted.lifecycleStatus as typeof ACTIVE_ENCOUNTER_LIFECYCLES[number],
        )) {
          await encounterService.cancel({
            ...seedScope,
            encounterRef,
            idempotencyKey: 'phase-assisted-cleanup-0001',
            expectedStateVersion: persisted.stateVersion,
          });
        }
      }
    }
  });

  it('evaluates a closed HP condition and applies the declared defend fallback in one beat', async () => {
    const encounterRef = 'phase-conditional-fallback';
    const created = await encounterService.create({
      ...seedScope,
      idempotencyKey: 'phase-conditional-create-0001',
      encounterRef,
      partySideRef: 'party',
      participants: [
        { bindingKind: 'persisted_actor', actorRef: 'ralph', sideRef: 'party', zone: 'engaged' },
        { bindingKind: 'persisted_actor', actorRef: 'lyra', sideRef: 'hostile', zone: 'engaged' },
      ],
      relations: [
        { leftActorRef: 'lyra', rightActorRef: 'lyra', relation: 'self' },
        { leftActorRef: 'lyra', rightActorRef: 'ralph', relation: 'hostile' },
        { leftActorRef: 'ralph', rightActorRef: 'ralph', relation: 'self' },
      ],
    });
    let cleanupNeeded = true;
    try {
      const resolved = await encounterService.resolveBeat({
        ...seedScope,
        encounterRef,
        idempotencyKey: 'phase-conditional-resolve-0001',
        expectedStateVersion: created.stateVersion,
        intent: {
          actorRef: 'ralph',
          objective: 'Use only bounded conditions.',
          narrative: 'Ralph observes if critically hurt and otherwise assumes a defensive fallback.',
          resolutionPolicy: 'atomic',
          components: [
            { type: 'move', destination: 'near' },
            {
              type: 'observe',
              when: { resource: 'hp', operator: 'at_or_below_percent', percent: 1 },
              fallback: 'skip',
            },
            {
              type: 'observe',
              when: { resource: 'hp', operator: 'at_or_below_percent', percent: 1 },
              fallback: 'defend',
            },
          ],
        },
      });
      expect(resolved.beatSummary?.componentResults).toEqual([
        expect.objectContaining({ index: 0, type: 'move', status: 'modified' }),
        expect.objectContaining({ index: 1, status: 'conditional', code: 'CONDITION_NOT_MET' }),
        expect.objectContaining({ index: 2, type: 'defend', status: 'modified', code: 'CONDITION_FALLBACK' }),
      ]);
      expect(resolved.batchSummary).toMatchObject({
        mode: 'plan',
        beatsProcessed: 1,
      });
      expect(resolved.batchSummary?.actionsResolved).toBeGreaterThan(0);
      await encounterService.cancel({
        ...seedScope,
        encounterRef,
        idempotencyKey: 'phase-conditional-cancel-0001',
        expectedStateVersion: resolved.stateVersion,
      });
      cleanupNeeded = false;
    } finally {
      if (cleanupNeeded) {
        const persisted = await prisma.encounter.findFirst({
          where: { encounterRef },
          select: { lifecycleStatus: true, stateVersion: true },
        });
        const terminalLifecycles = new Set<EncounterLifecycleStatus>([
          EncounterLifecycleStatus.COMPLETED,
          EncounterLifecycleStatus.FAILED,
          EncounterLifecycleStatus.CANCELLED,
        ]);
        if (persisted !== null && !terminalLifecycles.has(persisted.lifecycleStatus)) {
          await encounterService.cancel({
            ...seedScope,
            encounterRef,
            idempotencyKey: 'phase-conditional-cleanup-0001',
            expectedStateVersion: persisted.stateVersion,
          });
        }
      }
    }
  });

  it('resolves a bounded automatic policy across multiple beats with one idempotent checkpoint', async () => {
    const encounterRef = 'phase-automatic-bounded';
    const created = await encounterService.create({
      ...seedScope,
      idempotencyKey: 'phase-automatic-create-0001',
      encounterRef,
      partySideRef: 'party',
      participants: [
        { bindingKind: 'persisted_actor', actorRef: 'ralph', sideRef: 'party', zone: 'engaged' },
        { bindingKind: 'persisted_actor', actorRef: 'lyra', sideRef: 'hostile', zone: 'engaged' },
      ],
      relations: [
        { leftActorRef: 'lyra', rightActorRef: 'lyra', relation: 'self' },
        { leftActorRef: 'lyra', rightActorRef: 'ralph', relation: 'hostile' },
        { leftActorRef: 'ralph', rightActorRef: 'ralph', relation: 'self' },
      ],
    });
    let cleanupNeeded = true;
    try {
      const input = {
        ...seedScope,
        encounterRef,
        idempotencyKey: 'phase-automatic-resolve-0001',
        expectedStateVersion: created.stateVersion,
        policy: {
          actorRef: 'ralph',
          mode: 'bounded' as const,
          strategy: 'balanced' as const,
          objective: 'Resolve safely without consumables.',
          targetPriority: 'nearest_hostile' as const,
          protectedActorRefs: [],
          maximumBeats: 2,
          resourcePolicy: {
            allowCommonConsumables: false,
            allowRareConsumables: false,
            allowLimitedAbilities: false,
            preserveManaPercent: 50,
            preserveSpPercent: 50,
            stopBelowHpPercent: 10,
            stopIfProtectedActorBelowHpPercent: 30,
            allowFlee: false,
            allowTargetSwitch: true,
            allowEnvironmentalInteraction: false,
          },
        },
      };
      const resolved = await encounterService.resolveBeat(input);
      expect(resolved.batchSummary).toMatchObject({
        mode: 'automatic',
        startingStateVersion: created.stateVersion,
        beatsProcessed: 2,
        stopCategory: 'technical',
        requiresPlayerDecision: false,
      });
      expect(resolved.batchSummary?.endingStateVersion).toBe(resolved.stateVersion);
      expect(resolved.stateVersion).toBeGreaterThan(created.stateVersion);
      expect(resolved.scene?.stateVersion).toBe(resolved.stateVersion);
      const ralphActions = resolved.scene?.participants.find((participant) => participant.actorRef === 'ralph')
        ?.usableActions;
      expect(ralphActions).toBeDefined();
      expect((ralphActions?.attacks.length ?? 0) + (ralphActions?.abilities.length ?? 0) + (ralphActions?.items.length ?? 0))
        .toBeGreaterThan(0);
      await expect(prisma.encounterOperation.count({ where: { encounter: { encounterRef } } })).resolves.toBe(2);
      const replay = await encounterService.resolveBeat(input);
      expect(replay).toEqual(resolved);
      expect(JSON.stringify(replay)).toBe(JSON.stringify(resolved));
      await expect(prisma.encounterOperation.count({ where: { encounter: { encounterRef } } })).resolves.toBe(2);
      await encounterService.cancel({
        ...seedScope,
        encounterRef,
        idempotencyKey: 'phase-automatic-cancel-0001',
        expectedStateVersion: resolved.stateVersion,
      });
      cleanupNeeded = false;
    } finally {
      if (cleanupNeeded) {
        const persisted = await prisma.encounter.findFirst({
          where: { encounterRef },
          select: { lifecycleStatus: true, stateVersion: true },
        });
        const terminalLifecycles = new Set<EncounterLifecycleStatus>([
          EncounterLifecycleStatus.COMPLETED,
          EncounterLifecycleStatus.FAILED,
          EncounterLifecycleStatus.CANCELLED,
        ]);
        if (persisted !== null && !terminalLifecycles.has(persisted.lifecycleStatus)) {
          await encounterService.cancel({
            ...seedScope,
            encounterRef,
            idempotencyKey: 'phase-automatic-cleanup-0001',
            expectedStateVersion: persisted.stateVersion,
          });
        }
      }
    }
  });

  it('stages manual flee by zone with the same movement, cost and time as the equivalent move', async () => {
    const hero = await prisma.actor.findFirstOrThrow({
      where: { code: 'ralph', campaign: { code: seedScope.campaignRef, world: { code: seedScope.worldRef } } },
      include: { resources: true },
    });
    const sp = hero.resources.find((resource) => resource.type === ActorResourceType.SP);
    if (sp === undefined) throw new Error('Flee matrix requires the protagonist SP resource');
    const attributes = getInitialAttributePreset('balanced');
    const secondary = calculateSecondaryAttributes({
      attributes, weaponFamilyRank: 0, magicSchoolRank: 0,
      accuracyRank: 0, evasionRank: 0, encumbrancePenalty: 0,
    });
    const resetSp = async (current = sp.current) => {
      await prisma.actorResource.update({
        where: { actorId_type: { actorId: hero.id, type: ActorResourceType.SP } },
        data: { current, stateVersion: { increment: 1 } },
      });
    };
    const ephemeral = (actorRef: string, zone: 'engaged' | 'near' | 'medium' | 'far' | 'out_of_range') => ({
      bindingKind: 'ephemeral' as const,
      ephemeralKind: 'ephemeral_creature' as const,
      participant: {
        actorRef,
        sideRef: 'hostile',
        actorStateVersion: 1,
        mechanicsStateVersion: 1,
        inventoryStateVersion: 1,
        effectsStateVersion: 1,
        zone,
        combatState: 'ready' as const,
        primaryAttributes: attributes,
        resources: {
          hp: { current: 100, maximum: 100 },
          mana: { current: 0, maximum: 0 },
          sp: { current: 20, maximum: 20 },
          customResources: [],
        },
        secondaryAttributes: secondary,
        activeEffects: [],
        reactionCapabilities: [],
        equipmentContext: {
          inventory: { entries: [] },
          loadout: createCoreV1EmptyEquipmentLoadout(),
          requirements: {
            level: 1,
            primaryAttributes: attributes,
            knownContentRefs: [],
            equippedWeaponTags: [],
            equippedEquipmentTags: [],
            rulesetCode: 'core-v1' as const,
          },
        },
        initiative: { tieBreak: 50, surprised: false },
      },
    });
    const cases = [
      { from: 'engaged', desired: 'out_of_range', to: 'near', movementKind: 'disengage', code: 'FLEE_STAGED' },
      { from: 'near', desired: 'out_of_range', to: 'far', movementKind: 'run', code: 'FLEE_STAGED' },
      { from: 'medium', desired: 'out_of_range', to: 'out_of_range', movementKind: 'run', code: undefined },
      { from: 'far', desired: 'out_of_range', to: 'out_of_range', movementKind: 'run', code: undefined },
      { from: 'engaged', desired: 'far', to: 'near', movementKind: 'disengage', code: 'FLEE_STAGED' },
      { from: 'near', desired: 'far', to: 'far', movementKind: 'run', code: undefined },
    ] as const;
    for (const [index, entry] of cases.entries()) {
      const run = async (kind: 'flee' | 'move') => {
        await resetSp();
        const suffix = `${String(index)}-${kind}`;
        const encounterRef = `flee-zone-${suffix}`;
        const created = await encounterService.create({
          ...seedScope,
          encounterRef,
          idempotencyKey: `flee-zone-${suffix}-create`,
          partySideRef: 'party',
          participants: [
            { bindingKind: 'persisted_actor', actorRef: hero.code, sideRef: 'party', zone: entry.from },
            ephemeral(`flee-phantom-${suffix}`, entry.from),
          ],
          relations: [
            { leftActorRef: hero.code, rightActorRef: hero.code, relation: 'self' },
            { leftActorRef: hero.code, rightActorRef: `flee-phantom-${suffix}`, relation: 'hostile' },
            { leftActorRef: `flee-phantom-${suffix}`, rightActorRef: `flee-phantom-${suffix}`, relation: 'self' },
          ],
        });
        const resolved = await encounterService.resolveBeat({
          ...seedScope,
          encounterRef,
          idempotencyKey: `flee-zone-${suffix}-resolve`,
          expectedStateVersion: created.stateVersion,
          intent: {
            actorRef: hero.code,
            objective: kind === 'flee' ? 'escape' : 'equivalent_movement',
            narrative: kind === 'flee' ? 'O herói foge em uma etapa legal.' : 'O herói executa o movimento equivalente.',
            resolutionPolicy: 'atomic',
            components: kind === 'flee'
              ? [
                { type: 'flee', destination: entry.desired },
                { type: 'protect', targetRef: hero.code },
              ]
              : [
                { type: 'move', destination: entry.to, movementKind: entry.movementKind },
                { type: 'protect', targetRef: hero.code },
              ],
          },
          npcDirectives: [{ actorRef: `flee-phantom-${suffix}`, strategy: 'defensive' }],
        });
        const participant = resolved.participants.find((candidate) => candidate.actorRef === hero.code);
        expect(participant?.zone).toBe(entry.to);
        expect(resolved.beatSummary?.componentResults[0]).toMatchObject({
          index: 0,
          type: kind,
          status: kind === 'flee' && entry.code !== undefined ? 'modified' : 'accepted',
          ...(kind === 'flee' && entry.code !== undefined ? { code: entry.code } : {}),
        });
        expect(JSON.stringify(resolved.beatSummary)).not.toContain('DISTANCE_INCOMPATIBLE');
        await expect(prisma.encounterOperation.count({ where: { encounter: { encounterRef } } }))
          .resolves.toBe(2);
        await encounterService.cancel({
          ...seedScope,
          encounterRef,
          idempotencyKey: `flee-zone-${suffix}-cancel`,
          expectedStateVersion: resolved.stateVersion,
        });
        return {
          tickDelta: (BigInt(resolved.currentTick) - BigInt(created.currentTick)).toString(10),
          sp: participant?.resources.sp.current,
          movementEvents: resolved.transitionSummary?.events.filter((event) => event.category === 'movement_resolved').length,
        };
      };
      const flee = await run('flee');
      const move = await run('move');
      expect(flee).toEqual(move);
    }

    await resetSp();
    const completedRef = 'flee-zone-already-complete';
    const completed = await encounterService.create({
      ...seedScope,
      encounterRef: completedRef,
      idempotencyKey: 'flee-zone-already-complete-create',
      partySideRef: 'party',
      participants: [
        { bindingKind: 'persisted_actor', actorRef: hero.code, sideRef: 'party', zone: 'out_of_range' },
        ephemeral('flee-complete-phantom', 'far'),
      ],
      relations: [
        { leftActorRef: hero.code, rightActorRef: hero.code, relation: 'self' },
        { leftActorRef: hero.code, rightActorRef: 'flee-complete-phantom', relation: 'hostile' },
        { leftActorRef: 'flee-complete-phantom', rightActorRef: 'flee-complete-phantom', relation: 'self' },
      ],
    });
    const completedResult = await encounterService.resolveBeat({
      ...seedScope,
      encounterRef: completedRef,
      idempotencyKey: 'flee-zone-already-complete-resolve',
      expectedStateVersion: completed.stateVersion,
      intent: {
        actorRef: hero.code,
        objective: 'confirm_escape',
        narrative: 'O herói já está fora do alcance.',
        resolutionPolicy: 'atomic',
        components: [{ type: 'flee', destination: 'out_of_range' }],
      },
      npcDirectives: [],
    });
    expect(completedResult).toMatchObject({
      batchSummary: {
        beatsProcessed: 0,
        actionsResolved: 0,
        stopReason: 'flee_completed',
        stopCategory: 'decision',
        requiresPlayerDecision: true,
      },
      beatSummary: {
        actorsActed: [],
        componentResults: [{ type: 'flee', status: 'modified', code: 'FLEE_ALREADY_COMPLETE' }],
      },
    });
    expect(completedResult.participants.find((candidate) => candidate.actorRef === hero.code)).toMatchObject({
      zone: 'out_of_range',
      resources: { sp: { current: sp.current } },
    });
    await encounterService.cancel({
      ...seedScope,
      encounterRef: completedRef,
      idempotencyKey: 'flee-zone-already-complete-cancel',
      expectedStateVersion: completedResult.stateVersion,
    });

    await resetSp(2);
    const blockedRef = 'flee-zone-insufficient-sp';
    const blocked = await encounterService.create({
      ...seedScope,
      encounterRef: blockedRef,
      idempotencyKey: 'flee-zone-insufficient-sp-create',
      partySideRef: 'party',
      participants: [
        { bindingKind: 'persisted_actor', actorRef: hero.code, sideRef: 'party', zone: 'near' },
        ephemeral('flee-blocked-phantom', 'near'),
      ],
      relations: [
        { leftActorRef: hero.code, rightActorRef: hero.code, relation: 'self' },
        { leftActorRef: hero.code, rightActorRef: 'flee-blocked-phantom', relation: 'hostile' },
        { leftActorRef: 'flee-blocked-phantom', rightActorRef: 'flee-blocked-phantom', relation: 'self' },
      ],
    });
    await expect(encounterService.resolveBeat({
      ...seedScope,
      encounterRef: blockedRef,
      idempotencyKey: 'flee-zone-insufficient-sp-resolve',
      expectedStateVersion: blocked.stateVersion,
      intent: {
        actorRef: hero.code,
        objective: 'blocked_escape',
        narrative: 'O herói tenta correr sem SP suficiente.',
        resolutionPolicy: 'atomic',
        components: [{ type: 'flee', destination: 'out_of_range' }],
      },
      npcDirectives: [],
    })).rejects.toMatchObject({
      code: 'ENCOUNTER_BEAT_ATOMIC_REJECTED',
      issues: [expect.objectContaining({ code: 'RESOURCE_BELOW_REQUIRED' })],
    });
    await expect(prisma.idempotencyRecord.count({
      where: { key: 'encounter:flee-zone-insufficient-sp-resolve' },
    })).resolves.toBe(0);
    await expect(encounterService.load({ ...seedScope, encounterRef: blockedRef })).resolves.toMatchObject({
      stateVersion: blocked.stateVersion,
      participants: [expect.anything(), expect.objectContaining({ actorRef: hero.code, zone: 'near' })],
    });
    await encounterService.cancel({
      ...seedScope,
      encounterRef: blockedRef,
      idempotencyKey: 'flee-zone-insufficient-sp-cancel',
      expectedStateVersion: blocked.stateVersion,
    });
    await resetSp();
  });

  it('continues automatic escape through legal steps, stops on completion and replays far without rollback', async () => {
    const hero = await prisma.actor.findFirstOrThrow({
      where: { code: 'ralph', campaign: { code: seedScope.campaignRef, world: { code: seedScope.worldRef } } },
      include: { resources: true },
    });
    const sp = hero.resources.find((resource) => resource.type === ActorResourceType.SP);
    if (sp === undefined) throw new Error('Automatic flee requires the protagonist SP resource');
    const attributes = getInitialAttributePreset('balanced');
    const secondary = calculateSecondaryAttributes({
      attributes, weaponFamilyRank: 0, magicSchoolRank: 0,
      accuracyRank: 0, evasionRank: 0, encumbrancePenalty: 0,
    });
    const resetSp = async (current = sp.current) => {
      await prisma.actorResource.update({
        where: { actorId_type: { actorId: hero.id, type: ActorResourceType.SP } },
        data: { current, stateVersion: { increment: 1 } },
      });
    };
    const policy = (maximumBeats: number) => ({
      actorRef: hero.code,
      mode: 'bounded' as const,
      strategy: 'escape' as const,
      objective: 'Escape through authoritative legal movement.',
      targetPriority: 'nearest_hostile' as const,
      protectedActorRefs: [],
      maximumBeats,
      resourcePolicy: {
        allowCommonConsumables: false,
        allowRareConsumables: false,
        allowLimitedAbilities: false,
        preserveManaPercent: 50,
        preserveSpPercent: 0,
        stopBelowHpPercent: 0,
        stopIfProtectedActorBelowHpPercent: 0,
        allowFlee: true,
        allowTargetSwitch: true,
        allowEnvironmentalInteraction: false,
      },
    });
    const create = async (
      suffix: string,
      zone: 'engaged' | 'near' | 'medium' | 'far' | 'out_of_range',
    ) => {
      const phantomRef = `auto-flee-phantom-${suffix}`;
      const encounterRef = `auto-flee-${suffix}`;
      const created = await encounterService.create({
        ...seedScope,
        encounterRef,
        idempotencyKey: `auto-flee-${suffix}-create`,
        partySideRef: 'party',
        participants: [
          { bindingKind: 'persisted_actor', actorRef: hero.code, sideRef: 'party', zone },
          {
            bindingKind: 'ephemeral',
            ephemeralKind: 'ephemeral_creature',
            participant: {
              actorRef: phantomRef,
              sideRef: 'hostile',
              actorStateVersion: 1,
              mechanicsStateVersion: 1,
              inventoryStateVersion: 1,
              effectsStateVersion: 1,
              zone,
              combatState: 'ready',
              primaryAttributes: attributes,
              resources: {
                hp: { current: 100, maximum: 100 },
                mana: { current: 0, maximum: 0 },
                sp: { current: 20, maximum: 20 },
                customResources: [],
              },
              secondaryAttributes: secondary,
              activeEffects: [],
              reactionCapabilities: [],
              equipmentContext: {
                inventory: { entries: [] },
                loadout: createCoreV1EmptyEquipmentLoadout(),
                requirements: {
                  level: 1,
                  primaryAttributes: attributes,
                  knownContentRefs: [],
                  equippedWeaponTags: [],
                  equippedEquipmentTags: [],
                  rulesetCode: 'core-v1',
                },
              },
              initiative: { tieBreak: 50, surprised: false },
            },
          },
        ],
        relations: [
          { leftActorRef: hero.code, rightActorRef: hero.code, relation: 'self' },
          { leftActorRef: hero.code, rightActorRef: phantomRef, relation: 'hostile' },
          { leftActorRef: phantomRef, rightActorRef: phantomRef, relation: 'self' },
        ],
      });
      return { encounterRef, created };
    };

    await resetSp();
    const granular = await create('granular', 'engaged');
    let granularResult = granular.created;
    let granularMovementEvents = 0;
    for (let beatIndex = 0; beatIndex < 3; beatIndex += 1) {
      granularResult = await encounterService.resolveBeat({
        ...seedScope,
        encounterRef: granular.encounterRef,
        idempotencyKey: `auto-flee-granular-${String(beatIndex)}`,
        expectedStateVersion: granularResult.stateVersion,
        intent: {
          actorRef: hero.code,
          objective: 'escape_granularly',
          narrative: 'O herói continua a fuga granular.',
          resolutionPolicy: 'atomic',
          components: [{ type: 'flee', destination: 'out_of_range' }],
        },
        npcDirectives: [],
      });
      granularMovementEvents += granularResult.transitionSummary?.events
        .filter((event) => event.category === 'movement_resolved').length ?? 0;
    }
    expect(granularResult.participants.find((candidate) => candidate.actorRef === hero.code)?.zone)
      .toBe('out_of_range');
    const granularSignature = {
      tickDelta: (BigInt(granularResult.currentTick) - BigInt(granular.created.currentTick)).toString(10),
      stateVersionDelta: granularResult.stateVersion - granular.created.stateVersion,
      sp: granularResult.participants.find((candidate) => candidate.actorRef === hero.code)?.resources.sp.current,
      movementEvents: granularMovementEvents,
    };
    await encounterService.cancel({
      ...seedScope,
      encounterRef: granular.encounterRef,
      idempotencyKey: 'auto-flee-granular-cancel',
      expectedStateVersion: granularResult.stateVersion,
    });

    await resetSp();
    const engaged = await create('engaged', 'engaged');
    const engagedInput = {
      ...seedScope,
      encounterRef: engaged.encounterRef,
      idempotencyKey: 'auto-flee-engaged-resolve',
      expectedStateVersion: engaged.created.stateVersion,
      policy: policy(12),
    };
    const escaped = await encounterService.resolveBeat(engagedInput);
    expect(escaped).toMatchObject({
      lifecycleStatus: 'awaiting_intent',
      batchSummary: {
        mode: 'automatic',
        beatsProcessed: 3,
        stopReason: 'flee_completed',
        stopCategory: 'decision',
        requiresPlayerDecision: true,
        decisionReason: 'flee_completed',
      },
    });
    expect(escaped.participants.find((candidate) => candidate.actorRef === hero.code)).toMatchObject({
      zone: 'out_of_range',
      combatState: 'ready',
      resources: { sp: { current: sp.current - 6 } },
    });
    expect(escaped.completionCandidate).toBeNull();
    expect(escaped.transitionSummary?.events.filter((event) => event.category === 'movement_resolved'))
      .toHaveLength(3);
    expect({
      tickDelta: (BigInt(escaped.currentTick) - BigInt(engaged.created.currentTick)).toString(10),
      stateVersionDelta: escaped.stateVersion - engaged.created.stateVersion,
      sp: escaped.participants.find((candidate) => candidate.actorRef === hero.code)?.resources.sp.current,
      movementEvents: escaped.transitionSummary?.events
        .filter((event) => event.category === 'movement_resolved').length,
    }).toEqual(granularSignature);
    const escapedReplay = await encounterService.resolveBeat(engagedInput);
    expect(escapedReplay).toEqual(escaped);
    await expect(prisma.encounterOperation.count({ where: { encounter: { encounterRef: engaged.encounterRef } } }))
      .resolves.toBe(2);
    await encounterService.cancel({
      ...seedScope,
      encounterRef: engaged.encounterRef,
      idempotencyKey: 'auto-flee-engaged-cancel',
      expectedStateVersion: escaped.stateVersion,
    });

    await resetSp();
    const far = await create('far', 'far');
    const farInput = {
      ...seedScope,
      encounterRef: far.encounterRef,
      idempotencyKey: 'auto-flee-far-resolve',
      expectedStateVersion: far.created.stateVersion,
      policy: policy(12),
    };
    const farEscaped = await encounterService.resolveBeat(farInput);
    expect(farEscaped).toMatchObject({
      batchSummary: {
        beatsProcessed: 1,
        stopReason: 'flee_completed',
        stopCategory: 'decision',
      },
    });
    expect(farEscaped.batchSummary?.actionsResolved).toBeGreaterThan(0);
    expect(farEscaped.participants.find((candidate) => candidate.actorRef === hero.code)).toMatchObject({
      zone: 'out_of_range',
      resources: { sp: { current: sp.current - 3 } },
    });
    expect(JSON.stringify(farEscaped)).not.toContain('DISTANCE_INCOMPATIBLE');
    await expect(encounterService.resolveBeat(farInput)).resolves.toEqual(farEscaped);
    await encounterService.cancel({
      ...seedScope,
      encounterRef: far.encounterRef,
      idempotencyKey: 'auto-flee-far-cancel',
      expectedStateVersion: farEscaped.stateVersion,
    });

    await resetSp();
    const bounded = await create('budget', 'engaged');
    const firstBudget = await encounterService.resolveBeat({
      ...seedScope,
      encounterRef: bounded.encounterRef,
      idempotencyKey: 'auto-flee-budget-first',
      expectedStateVersion: bounded.created.stateVersion,
      policy: policy(1),
    });
    expect(firstBudget).toMatchObject({
      batchSummary: {
        beatsProcessed: 1,
        stopReason: 'processing_limit',
        stopCategory: 'technical',
        requiresPlayerDecision: false,
      },
    });
    expect(firstBudget.participants.find((candidate) => candidate.actorRef === hero.code)?.zone).toBe('near');
    const completedBudget = await encounterService.resolveBeat({
      ...seedScope,
      encounterRef: bounded.encounterRef,
      idempotencyKey: 'auto-flee-budget-second',
      expectedStateVersion: firstBudget.stateVersion,
      policy: policy(2),
    });
    expect(completedBudget).toMatchObject({
      batchSummary: {
        beatsProcessed: 2,
        stopReason: 'flee_completed',
        stopCategory: 'decision',
      },
    });
    expect(completedBudget.participants.find((candidate) => candidate.actorRef === hero.code)?.zone)
      .toBe('out_of_range');
    await encounterService.cancel({
      ...seedScope,
      encounterRef: bounded.encounterRef,
      idempotencyKey: 'auto-flee-budget-cancel',
      expectedStateVersion: completedBudget.stateVersion,
    });

    await resetSp(2);
    const blocked = await create('blocked', 'near');
    const blockedResult = await encounterService.resolveBeat({
      ...seedScope,
      encounterRef: blocked.encounterRef,
      idempotencyKey: 'auto-flee-blocked-resolve',
      expectedStateVersion: blocked.created.stateVersion,
      policy: policy(12),
    });
    expect(blockedResult).toMatchObject({
      batchSummary: {
        beatsProcessed: 0,
        actionsResolved: 0,
        stopReason: 'flee_blocked_insufficient_sp',
        stopCategory: 'decision',
        requiresPlayerDecision: true,
        decisionReason: 'flee_blocked_insufficient_sp',
        availableAlternatives: [
          'Recover enough SP for the next run step.',
          'Choose a different explicit action.',
        ],
      },
    });
    expect(blockedResult.participants.find((candidate) => candidate.actorRef === hero.code)).toMatchObject({
      zone: 'near',
      resources: { sp: { current: 2 } },
    });
    await encounterService.cancel({
      ...seedScope,
      encounterRef: blocked.encounterRef,
      idempotencyKey: 'auto-flee-blocked-cancel',
      expectedStateVersion: blockedResult.stateVersion,
    });

    await resetSp(4);
    const blockedAfterStep = await create('blocked-after-step', 'near');
    const blockedAfterStepInput = {
      ...seedScope,
      encounterRef: blockedAfterStep.encounterRef,
      idempotencyKey: 'auto-flee-blocked-after-step-resolve',
      expectedStateVersion: blockedAfterStep.created.stateVersion,
      policy: policy(12),
    };
    const blockedAfterStepResult = await encounterService.resolveBeat(blockedAfterStepInput);
    expect(blockedAfterStepResult).toMatchObject({
      batchSummary: {
        beatsProcessed: 1,
        stopReason: 'flee_blocked_insufficient_sp',
        stopCategory: 'decision',
        requiresPlayerDecision: true,
      },
    });
    expect(blockedAfterStepResult.participants.find((candidate) => candidate.actorRef === hero.code))
      .toMatchObject({
        zone: 'far',
        resources: { sp: { current: 1 } },
      });
    await expect(encounterService.resolveBeat(blockedAfterStepInput)).resolves.toEqual(blockedAfterStepResult);
    await encounterService.cancel({
      ...seedScope,
      encounterRef: blockedAfterStep.encounterRef,
      idempotencyKey: 'auto-flee-blocked-after-step-cancel',
      expectedStateVersion: blockedAfterStepResult.stateVersion,
    });
    await resetSp();
  });

  it('keeps the 1-12 automatic matrix integral with canonical replay at every checkpoint', async () => {
    const fixture = await createBeatNpcFixture('automatic-matrix', 1, async ({ world, campaign, hero }) => {
      const code = 'automatic-matrix-sustain';
      const sustain = await publishTestContent({
        worldId: world.id,
        campaignId: campaign.id,
        contentType: ContentType.SPELL,
        code,
        name: 'Automatic Matrix Sustain',
        profile: {
          ...activeProfile('spell', code, 'Automatic Matrix Sustain'),
          cost: { type: 'none' as const },
          effects: [{
            type: 'restore_resource' as const,
            resource: 'hp' as const,
            amount: 1,
            targeting: { type: 'self' as const, rangeBand: 'self' as const },
          }],
        },
      });
      await prisma.actorContent.create({
        data: {
          actorId: hero.id,
          contentDefinitionId: sustain.id,
          contentVersionId: sustain.versions[0]!.id,
          state: ActorContentState.MASTERED,
        },
      });
    });
    await encounterService.cancel({
      ...fixture.scope,
      encounterRef: fixture.encounterRef,
      idempotencyKey: 'automatic-matrix-initial-cancel',
      expectedStateVersion: fixture.created.stateVersion,
    });
    const maximumBeatsMatrix = [1, 2, 4, 6, 8, 10, 11, 12] as const;
    const matrix: Array<{
      maximumBeats: number;
      beatsProcessed: number;
      lifecycleStatus: EncounterDto['lifecycleStatus'];
    }> = [];
    for (const maximumBeats of maximumBeatsMatrix) {
      const encounterRef = `automatic-matrix-${String(maximumBeats)}`;
      const created = await encounterService.create({
        ...fixture.scope,
        encounterRef,
        idempotencyKey: `automatic-matrix-${String(maximumBeats)}-create`,
        partySideRef: 'party',
        participants: [
          { bindingKind: 'persisted_actor', actorRef: fixture.heroRef, sideRef: 'party', zone: 'near' },
          { bindingKind: 'persisted_actor', actorRef: fixture.npcRefs[0]!, sideRef: 'hostile', zone: 'near' },
        ],
        relations: [
          { leftActorRef: fixture.heroRef, rightActorRef: fixture.heroRef, relation: 'self' },
          { leftActorRef: fixture.heroRef, rightActorRef: fixture.npcRefs[0]!, relation: 'hostile' },
          { leftActorRef: fixture.npcRefs[0]!, rightActorRef: fixture.npcRefs[0]!, relation: 'self' },
        ],
      });
      const input = {
        ...fixture.scope,
        encounterRef,
        idempotencyKey: `automatic-matrix-${String(maximumBeats)}-resolve`,
        expectedStateVersion: created.stateVersion,
        policy: {
          actorRef: fixture.heroRef,
          mode: 'bounded' as const,
          strategy: 'defensive' as const,
          objective: 'Resolve the deterministic automatic integrity matrix.',
          targetPriority: 'nearest_hostile' as const,
          protectedActorRefs: [],
          maximumBeats,
          resourcePolicy: {
            allowCommonConsumables: false,
            allowRareConsumables: false,
            allowLimitedAbilities: false,
            preserveManaPercent: 50,
            preserveSpPercent: 50,
            stopBelowHpPercent: 0,
            stopIfProtectedActorBelowHpPercent: 0,
            allowFlee: false,
            allowTargetSwitch: true,
            allowEnvironmentalInteraction: false,
          },
        },
      };
      const resolved = await encounterService.resolveBeat(input);
      const replay = await encounterService.resolveBeat(input);
      expect(replay).toEqual(resolved);
      expect(JSON.stringify(replay)).toBe(JSON.stringify(resolved));
      expect(resolved.batchSummary?.beatsProcessed).toBe(maximumBeats);
      await expect(encounterService.load({ ...fixture.scope, encounterRef })).resolves.toMatchObject({
        stateVersion: resolved.stateVersion,
        lifecycleStatus: resolved.lifecycleStatus,
      });
      const operation = await prisma.encounterOperation.findFirstOrThrow({
        where: { encounter: { encounterRef } },
        orderBy: { nextStateVersion: 'desc' },
        select: { operation: true, idempotencyRecord: { select: { operation: true } } },
      });
      expect(operation.idempotencyRecord.operation).toBe('encounter.resolve_beat');
      expect(operation.operation).toBe(EncounterOperationKind.SUBMIT_INTENT);
      matrix.push({
        maximumBeats,
        beatsProcessed: resolved.batchSummary?.beatsProcessed ?? 0,
        lifecycleStatus: resolved.lifecycleStatus,
      });
      await encounterService.cancel({
        ...fixture.scope,
        encounterRef,
        idempotencyKey: `automatic-matrix-${String(maximumBeats)}-cancel`,
        expectedStateVersion: resolved.stateVersion,
      });
    }
    expect(matrix.map((entry) => entry.maximumBeats)).toEqual(maximumBeatsMatrix);
    expect(matrix).toEqual(maximumBeatsMatrix.map((maximumBeats) => ({
      maximumBeats,
      beatsProcessed: maximumBeats,
      lifecycleStatus: 'awaiting_intent',
    })));
    if (process.env.REPORT_ENCOUNTER_BUDGETS === '1') {
      console.info(`ENCOUNTER_AUTOMATIC_MATRIX=${JSON.stringify(matrix)}`);
    }
  });

  it('commits terminal resolve_beat with the canonical terminal operation and replay', async () => {
    const beatService = createEncounterService(
      prisma,
      (executionRef) => new RecordingEncounterRollProvider({ nextBps: () => 1 }, executionRef),
    );
    const fixture = await createBeatNpcFixture('terminal-resolve', 1, async ({ world, campaign }) => {
      await publishTestContent({
        worldId: world.id,
        campaignId: campaign.id,
        contentType: ContentType.WEAPON,
        code: 'terminal-resolve-sword',
        name: 'Terminal Resolve Sword',
        description: 'Arma terminal do teste.',
        profile: {
          ...weaponProfile('terminal-resolve-sword', 'Terminal Resolve Sword', 'Arma terminal do teste.'),
          handedness: 'one_handed' as const,
          weaponTags: ['sword'],
        },
        inventorySpec: uniqueInventorySpec(2, {
          equipmentSlots: ['main_hand'],
          handedness: 'one_handed',
        }),
        tags: ['weapon'],
      });
    });
    await beatService.cancel({
      ...fixture.scope,
      encounterRef: fixture.encounterRef,
      idempotencyKey: 'terminal-resolve-initial-cancel',
      expectedStateVersion: fixture.created.stateVersion,
    });
    const inventory = await post(`/api/v1/actors/${fixture.heroRef}/inventory/manage`, {
      ...fixture.scope,
      operation: 'get',
    });
    const granted = await post(`/api/v1/actors/${fixture.heroRef}/inventory/manage`, {
      ...fixture.scope,
      operation: 'grant',
      idempotencyKey: 'terminal-resolve-grant',
      expectedInventoryStateVersion: Number(bodyRecord(inventory).inventoryStateVersion),
      contentRef: {
        scope: 'campaign',
        contentType: 'weapon',
        code: 'terminal-resolve-sword',
        versionNumber: 1,
      },
      quantity: 1,
      entryRefs: ['terminal-resolve-sword-1'],
    });
    const equipped = await post(`/api/v1/actors/${fixture.heroRef}/inventory/manage`, {
      ...fixture.scope,
      operation: 'equip',
      idempotencyKey: 'terminal-resolve-equip',
      expectedInventoryStateVersion: Number(bodyRecord(granted).inventoryStateVersion),
      entryRef: 'terminal-resolve-sword-1',
      targetSlotRef: 'main_hand',
    });
    expect(equipped.status).toBe(200);
    const targetRef = fixture.npcRefs[0];
    if (targetRef === undefined) throw new Error('Terminal beat target is required');
    const target = await prisma.actor.findFirstOrThrow({
      where: { code: targetRef, campaignId: fixture.campaign.id },
      include: { derivedSnapshot: true },
    });
    if (target.derivedSnapshot === null) {
      throw new Error('Terminal beat actors require derived snapshots');
    }
    await prisma.$transaction([
      prisma.actorResource.update({
        where: { actorId_type: { actorId: target.id, type: 'HP' } },
        data: { current: 1, stateVersion: { increment: 1 } },
      }),
      prisma.actor.update({ where: { id: target.id }, data: { status: 'ACTIVE' } }),
    ]);
    const encounterRef = 'terminal-resolve-beat';
    const created = await beatService.create({
      ...fixture.scope,
      encounterRef,
      idempotencyKey: 'phase-terminal-resolve-beat-create',
      partySideRef: 'party',
      participants: [
        { bindingKind: 'persisted_actor', actorRef: fixture.heroRef, sideRef: 'party', zone: 'engaged' },
        { bindingKind: 'persisted_actor', actorRef: targetRef, sideRef: 'hostile', zone: 'engaged' },
      ],
      relations: [
        { leftActorRef: fixture.heroRef, rightActorRef: fixture.heroRef, relation: 'self' },
        { leftActorRef: fixture.heroRef, rightActorRef: targetRef, relation: 'hostile' },
        { leftActorRef: targetRef, rightActorRef: targetRef, relation: 'self' },
      ],
    });
    const input = {
      ...fixture.scope,
      encounterRef,
      idempotencyKey: 'phase-terminal-resolve-beat-resolve',
      expectedStateVersion: created.stateVersion,
      policy: {
        actorRef: fixture.heroRef,
        mode: 'until_terminal' as const,
        strategy: 'balanced' as const,
        objective: 'Confirm the terminal automatic ledger path.',
        targetPriority: 'nearest_hostile' as const,
        protectedActorRefs: [],
        maximumBeats: 12,
        resourcePolicy: {
          allowCommonConsumables: false,
          allowRareConsumables: false,
          allowLimitedAbilities: false,
          preserveManaPercent: 50,
          preserveSpPercent: 50,
          stopBelowHpPercent: 0,
          stopIfProtectedActorBelowHpPercent: 0,
          allowFlee: false,
          allowTargetSwitch: true,
          allowEnvironmentalInteraction: false,
        },
      },
    };
    let resolved: EncounterDto | undefined;
    try {
      resolved = await beatService.resolveBeat(input);
      expect(resolved).toMatchObject({
        operation: 'resolve_beat',
        lifecycleStatus: 'completed',
        nextRequiredAction: { type: 'none' },
        batchSummary: {
          mode: 'automatic',
          beatsProcessed: 1,
          stopCategory: 'terminal',
        },
      });
      const replay = await beatService.resolveBeat(input);
      expect(replay).toEqual(resolved);
      expect(JSON.stringify(replay)).toBe(JSON.stringify(resolved));
      await expect(beatService.load({ ...fixture.scope, encounterRef })).resolves.toMatchObject({
        stateVersion: resolved.stateVersion,
        lifecycleStatus: 'completed',
      });
      await expect(prisma.encounterOperation.findFirstOrThrow({
        where: { encounter: { encounterRef } },
        orderBy: { nextStateVersion: 'desc' },
        select: { operation: true, idempotencyRecord: { select: { operation: true } } },
      })).resolves.toEqual({
        operation: EncounterOperationKind.CONFIRM_COMPLETION,
        idempotencyRecord: { operation: 'encounter.resolve_beat' },
      });
    } finally {
      if (resolved === undefined) {
        const open = await prisma.encounter.findFirst({
          where: { encounterRef },
          select: { lifecycleStatus: true, stateVersion: true },
        });
        if (open !== null && ACTIVE_ENCOUNTER_LIFECYCLES.includes(
          open.lifecycleStatus as typeof ACTIVE_ENCOUNTER_LIFECYCLES[number],
        )) {
          await beatService.cancel({
            ...fixture.scope,
            encounterRef,
            idempotencyKey: 'phase-terminal-resolve-beat-cleanup',
            expectedStateVersion: open.stateVersion,
          });
        }
      }
      await prisma.$transaction([
        prisma.actorResource.update({
          where: { actorId_type: { actorId: target.id, type: 'HP' } },
          data: { current: target.derivedSnapshot.maxHp, stateVersion: { increment: 1 } },
        }),
        prisma.actor.update({ where: { id: target.id }, data: { status: 'ACTIVE' } }),
      ]);
    }
  });

  it('keeps PostgreSQL query, capsule and transaction budgets bounded across hardened encounter operations', async () => {
    const facade = createEncounterHttpService(encounterService);
    const reports: Record<string, unknown>[] = [];
    const openEncounterRefs = new Map<string, { scope: typeof seedScope; stateVersion: number }>();
    const stage = (
      measurement: Awaited<ReturnType<typeof measureEncounterOperation>>,
      name: string,
    ) => measurement.metrics.stages.find((entry) => entry.name === name);
    const report = (
      scenario: string,
      measurement: Awaited<ReturnType<typeof measureEncounterOperation<EncounterDto | EncounterPublicDto>>>,
      beats: number,
      startingStateVersion: number,
    ) => {
      const value = measurement.value;
      reports.push({
        scenario,
        queries: measurement.metrics.queryCount,
        queriesPerBeat: beats === 0 ? 0 : Math.round(measurement.metrics.queryCount / beats * 100) / 100,
        contentReadBatches: stage(measurement, 'encounter_content')?.calls ?? 0,
        contentReadQueries: stage(measurement, 'encounter_content')?.queryCount ?? 0,
        inventoryReadBatches: stage(measurement, 'encounter_inventory')?.calls ?? 0,
        inventoryReadQueries: stage(measurement, 'encounter_inventory')?.queryCount ?? 0,
        effectReadBatches: stage(measurement, 'encounter_effects')?.calls ?? 0,
        effectReadQueries: stage(measurement, 'encounter_effects')?.queryCount ?? 0,
        capsuleRebuilds: stage(measurement, 'encounter_capsule_assembly')?.calls ?? 0,
        transactionDurationMs: stage(measurement, 'encounter_transaction')?.durationMs ?? measurement.durationMs,
        responseBytes: measurement.responseBytes,
        events: value.transitionSummary?.processedEventCount ?? 0,
        stateVersionsConsumed: value.stateVersion - startingStateVersion,
      });
    };
    const cancelOpen = async (scope: typeof seedScope, encounterRef: string, stateVersion: number, key: string) => {
      const current = await prisma.encounter.findFirst({
        where: {
          encounterRef,
          campaign: { code: scope.campaignRef, world: { code: scope.worldRef, player: { slug: scope.playerRef } } },
        },
        select: { lifecycleStatus: true, stateVersion: true },
      });
      if (current !== null && ACTIVE_ENCOUNTER_LIFECYCLES.includes(
        current.lifecycleStatus as typeof ACTIVE_ENCOUNTER_LIFECYCLES[number],
      )) {
        await encounterService.cancel({
          ...scope, encounterRef, idempotencyKey: key,
          expectedStateVersion: Math.max(stateVersion, current.stateVersion),
        });
      }
      openEncounterRefs.delete(encounterRef);
    };
    const policy = (actorRef: string, maximumBeats: number) => ({
      actorRef,
      mode: 'bounded' as const,
      strategy: 'defensive' as const,
      objective: 'Defend until the bounded technical checkpoint.',
      targetPriority: 'nearest_hostile' as const,
      protectedActorRefs: [],
      maximumBeats,
      resourcePolicy: {
        allowCommonConsumables: false,
        allowRareConsumables: false,
        allowLimitedAbilities: false,
        preserveManaPercent: 50,
        preserveSpPercent: 50,
        stopBelowHpPercent: 10,
        stopIfProtectedActorBelowHpPercent: 10,
        allowFlee: false,
        allowTargetSwitch: true,
        allowEnvironmentalInteraction: false,
      },
    });

    try {
      let assistedHeroRef = '';
      const two = await createBeatNpcFixture('hardening-budget-two', 1, async ({ world, campaign, hero, scope }) => {
        const assistedHero = await createMechanicalActor({
          campaignId: campaign.id,
          code: scope.playerRef,
          name: 'Hardening Budget Protagonist',
          actorType: ActorType.CHARACTER,
        });
        assistedHeroRef = assistedHero.code;
        for (let index = 0; index < 6; index += 1) {
          const code = `hardening-budget-spell-${String(index)}`;
          const definition = await publishTestContent({
            worldId: world.id,
            campaignId: campaign.id,
            contentType: ContentType.SPELL,
            code,
            name: `Hardening Budget Spell ${String(index)}`,
            profile: {
              ...activeProfile('spell', code, `Hardening Budget Spell ${String(index)}`),
              cost: { type: 'mana' as const, amount: 3 },
              effects: [{
                type: 'damage' as const,
                targeting: { type: 'single_target' as const, rangeBand: 'near' as const, maxTargets: 1 },
                damageComponents: [{
                  id: `${code}-arcane`,
                  channel: 'magical' as const,
                  element: 'arcane' as const,
                  baseDamage: 4,
                  scaling: 'full' as const,
                  canCrit: true,
                }],
              }],
            },
          });
          await prisma.actorContent.create({
            data: {
              actorId: assistedHero.id,
              contentDefinitionId: definition.id,
              contentVersionId: definition.versions[0]!.id,
              state: ActorContentState.MASTERED,
            },
          });
        }
        const sustainCode = 'hardening-budget-sustain';
        const sustain = await publishTestContent({
          worldId: world.id,
          campaignId: campaign.id,
          contentType: ContentType.SPELL,
          code: sustainCode,
          name: 'Hardening Budget Sustain',
          profile: {
            ...activeProfile('spell', sustainCode, 'Hardening Budget Sustain'),
            cost: { type: 'none' as const },
            effects: [{
              type: 'restore_resource' as const,
              resource: 'hp' as const,
              amount: 1,
              targeting: { type: 'self' as const, rangeBand: 'self' as const },
            }],
          },
        });
        await prisma.actorContent.create({
          data: {
            actorId: hero.id,
            contentDefinitionId: sustain.id,
            contentVersionId: sustain.versions[0]!.id,
            state: ActorContentState.MASTERED,
          },
        });
        await publishTestContent({
          worldId: world.id,
          campaignId: campaign.id,
          contentType: ContentType.WEAPON,
          code: 'hardening-budget-sword',
          name: 'Hardening Budget Sword',
          description: 'Arma inicial.',
          profile: {
            ...weaponProfile('hardening-budget-sword', 'Hardening Budget Sword'),
            handedness: 'one_handed' as const,
            weaponTags: ['sword'],
          },
          inventorySpec: uniqueInventorySpec(2, {
            equipmentSlots: ['main_hand'],
            handedness: 'one_handed',
          }),
          tags: ['weapon'],
        });
      });
      await cancelOpen(two.scope, two.encounterRef, two.created.stateVersion, 'hardening-budget-two-initial-cancel');
      const assistedRef = 'hardening-budget-assisted';
      const assistedInput = manageEncounterSchema.parse({
        operation: 'create',
        ...two.scope,
        encounterRef: assistedRef,
        idempotencyKey: 'hardening-budget-assisted-create',
        setupMode: 'assisted',
        encounterKind: 'combat',
        partyActorRefs: [assistedHeroRef],
        hostileActorRefs: [two.npcRefs[0]],
        objective: 'Measure assisted creation with six initial protagonist contents.',
        engagementPreference: 'immediate',
      });
      const assisted = await measureEncounterOperation(() => facade.manage(assistedInput));
      openEncounterRefs.set(assistedRef, { scope: two.scope, stateVersion: assisted.value.stateVersion });
      report('assisted_create_2p_6content', assisted, 0, 0);
      expect(assisted.metrics.queryCount).toBeLessThanOrEqual(150);
      expect(stage(assisted, 'encounter_capsule_assembly')?.calls).toBe(1);
      expect(assisted.value.scene?.participants).toHaveLength(2);
      expect(assisted.responseBytes).toBeLessThanOrEqual(64 * 1024);
      await cancelOpen(two.scope, assistedRef, assisted.value.stateVersion, 'hardening-budget-assisted-cancel');

      const createAutomatic = async (suffix: string) => {
        const encounterRef = `hardening-budget-${suffix}`;
        const created = await encounterService.create({
          ...two.scope,
          encounterRef,
          idempotencyKey: `hardening-budget-${suffix}-create`,
          partySideRef: 'party',
          participants: [
            { bindingKind: 'persisted_actor', actorRef: two.heroRef, sideRef: 'party', zone: 'near' },
            { bindingKind: 'persisted_actor', actorRef: two.npcRefs[0]!, sideRef: 'hostile', zone: 'near' },
          ],
          relations: [
            { leftActorRef: two.heroRef, rightActorRef: two.heroRef, relation: 'self' },
            { leftActorRef: two.heroRef, rightActorRef: two.npcRefs[0]!, relation: 'hostile' },
            { leftActorRef: two.npcRefs[0]!, rightActorRef: two.npcRefs[0]!, relation: 'self' },
          ],
        });
        openEncounterRefs.set(encounterRef, { scope: two.scope, stateVersion: created.stateVersion });
        return { encounterRef, created };
      };

      const autoFourFixture = await createAutomatic('auto-four');
      const autoFour = await measureEncounterOperation(() => encounterService.resolveBeat({
        ...two.scope,
        encounterRef: autoFourFixture.encounterRef,
        idempotencyKey: 'hardening-budget-auto-four-resolve',
        expectedStateVersion: autoFourFixture.created.stateVersion,
        policy: policy(two.heroRef, 4),
      }));
      openEncounterRefs.set(autoFourFixture.encounterRef, { scope: two.scope, stateVersion: autoFour.value.stateVersion });
      report('auto_resolve_4', autoFour, 4, autoFourFixture.created.stateVersion);
      expect(autoFour.value.batchSummary?.beatsProcessed).toBe(4);
      expect(autoFour.metrics.queryCount).toBeLessThanOrEqual(130);
      expect(stage(autoFour, 'encounter_content')?.calls).toBe(1);
      expect(stage(autoFour, 'encounter_capsule_assembly')?.calls).toBe(1);
      await cancelOpen(two.scope, autoFourFixture.encounterRef, autoFour.value.stateVersion, 'hardening-budget-auto-four-cancel');

      const autoTwelveFixture = await createAutomatic('auto-twelve');
      const autoTwelve = await measureEncounterOperation(() => encounterService.resolveBeat({
        ...two.scope,
        encounterRef: autoTwelveFixture.encounterRef,
        idempotencyKey: 'hardening-budget-auto-twelve-resolve',
        expectedStateVersion: autoTwelveFixture.created.stateVersion,
        policy: policy(two.heroRef, 12),
      }));
      openEncounterRefs.set(autoTwelveFixture.encounterRef, { scope: two.scope, stateVersion: autoTwelve.value.stateVersion });
      report('auto_resolve_12', autoTwelve, 12, autoTwelveFixture.created.stateVersion);
      expect(autoTwelve.value.batchSummary?.beatsProcessed).toBe(12);
      expect(autoTwelve.metrics.queryCount).toBeLessThanOrEqual(140);
      expect(autoTwelve.metrics.queryCount).toBeLessThanOrEqual(autoFour.metrics.queryCount + 10);
      expect(stage(autoTwelve, 'encounter_content')?.calls).toBe(1);
      expect(stage(autoTwelve, 'encounter_capsule_assembly')?.calls).toBe(1);
      await cancelOpen(two.scope, autoTwelveFixture.encounterRef, autoTwelve.value.stateVersion, 'hardening-budget-auto-twelve-cancel');

      const group = await createBeatNpcFixture('hardening-budget-group', 5, async ({ world, campaign, hero }) => {
        const code = 'hardening-budget-group-sustain';
        const sustain = await publishTestContent({
          worldId: world.id,
          campaignId: campaign.id,
          contentType: ContentType.SPELL,
          code,
          name: 'Hardening Group Sustain',
          profile: {
            ...activeProfile('spell', code, 'Hardening Group Sustain'),
            cost: { type: 'none' as const },
            effects: [{
              type: 'restore_resource' as const,
              resource: 'hp' as const,
              amount: 1,
              targeting: { type: 'self' as const, rangeBand: 'self' as const },
            }],
          },
        });
        await prisma.actorContent.create({
          data: {
            actorId: hero.id,
            contentDefinitionId: sustain.id,
            contentVersionId: sustain.versions[0]!.id,
            state: ActorContentState.MASTERED,
          },
        });
      });
      await cancelOpen(group.scope, group.encounterRef, group.created.stateVersion, 'hardening-budget-group-initial-cancel');
      const groupRef = 'hardening-budget-group-six';
      const groupActorRefs = [group.heroRef, ...group.npcRefs];
      const allyRef = group.npcRefs[0]!;
      const groupRelations = [...groupActorRefs].sort().flatMap((leftActorRef, leftIndex, ordered) => (
        ordered.slice(leftIndex).map((rightActorRef) => ({
          leftActorRef,
          rightActorRef,
          relation: leftActorRef === rightActorRef ? 'self' as const
            : [leftActorRef, rightActorRef].every((ref) => [group.heroRef, allyRef].includes(ref))
              ? 'ally' as const
              : [leftActorRef, rightActorRef].some((ref) => [group.heroRef, allyRef].includes(ref))
                ? 'hostile' as const
                : 'ally' as const,
        }))
      ));
      const groupCreated = await encounterService.create({
        ...group.scope,
        encounterRef: groupRef,
        idempotencyKey: 'hardening-budget-group-create',
        partySideRef: 'party',
        participants: groupActorRefs.map((actorRef) => ({
          bindingKind: 'persisted_actor' as const,
          actorRef,
          sideRef: [group.heroRef, allyRef].includes(actorRef) ? 'party' : 'hostile',
          zone: 'near' as const,
        })),
        relations: groupRelations,
      });
      openEncounterRefs.set(groupRef, { scope: group.scope, stateVersion: groupCreated.stateVersion });
      const groupAuto = await measureEncounterOperation(() => encounterService.resolveBeat({
        ...group.scope,
        encounterRef: groupRef,
        idempotencyKey: 'hardening-budget-group-resolve',
        expectedStateVersion: groupCreated.stateVersion,
        policy: policy(group.heroRef, 8),
      }));
      openEncounterRefs.set(groupRef, { scope: group.scope, stateVersion: groupAuto.value.stateVersion });
      report('auto_resolve_group_2allies_4enemies_8', groupAuto, 8, groupCreated.stateVersion);
      expect(groupAuto.value.batchSummary?.beatsProcessed).toBe(8);
      expect(groupAuto.metrics.queryCount).toBeLessThanOrEqual(280);
      expect(stage(groupAuto, 'encounter_content')?.calls).toBe(1);
      expect(stage(groupAuto, 'encounter_capsule_assembly')?.calls).toBe(1);
      expect(groupAuto.value.scene?.participants).toHaveLength(6);
      expect(groupAuto.responseBytes).toBeLessThanOrEqual(128 * 1024);
      await cancelOpen(group.scope, groupRef, groupAuto.value.stateVersion, 'hardening-budget-group-cancel');

      const planInventory = await post(`/api/v1/actors/${two.heroRef}/inventory/manage`, {
        ...two.scope,
        operation: 'get',
      });
      expect(planInventory.status).toBe(200);
      const planGrant = await post(`/api/v1/actors/${two.heroRef}/inventory/manage`, {
        ...two.scope,
        operation: 'grant',
        idempotencyKey: 'hardening-budget-plan-grant',
        expectedInventoryStateVersion: Number(bodyRecord(planInventory).inventoryStateVersion),
        contentRef: {
          scope: 'campaign',
          contentType: 'weapon',
          code: 'hardening-budget-sword',
          versionNumber: 1,
        },
        quantity: 1,
        entryRefs: ['hardening-budget-sword-1'],
      });
      expect(planGrant.status).toBe(200);
      const planEquip = await post(`/api/v1/actors/${two.heroRef}/inventory/manage`, {
        ...two.scope,
        operation: 'equip',
        idempotencyKey: 'hardening-budget-plan-equip',
        expectedInventoryStateVersion: Number(bodyRecord(planGrant).inventoryStateVersion),
        entryRef: 'hardening-budget-sword-1',
        targetSlotRef: 'main_hand',
      });
      expect(planEquip.status).toBe(200);
      const planRef = 'hardening-budget-plan';
      const planCreated = await encounterService.create({
        ...two.scope,
        encounterRef: planRef,
        idempotencyKey: 'hardening-budget-plan-create',
        partySideRef: 'party',
        participants: [
          { bindingKind: 'persisted_actor', actorRef: two.heroRef, sideRef: 'party', zone: 'near' },
          { bindingKind: 'persisted_actor', actorRef: two.npcRefs[0]!, sideRef: 'hostile', zone: 'near' },
        ],
        relations: [
          { leftActorRef: two.heroRef, rightActorRef: two.heroRef, relation: 'self' },
          { leftActorRef: two.heroRef, rightActorRef: two.npcRefs[0]!, relation: 'hostile' },
          { leftActorRef: two.npcRefs[0]!, rightActorRef: two.npcRefs[0]!, relation: 'self' },
        ],
      });
      openEncounterRefs.set(planRef, { scope: two.scope, stateVersion: planCreated.stateVersion });
      const plan = await measureEncounterOperation(() => encounterService.resolveBeat({
        ...two.scope,
        encounterRef: planRef,
        idempotencyKey: 'hardening-budget-plan-resolve',
        expectedStateVersion: planCreated.stateVersion,
        intent: {
          actorRef: two.heroRef,
          objective: 'Move, attack and defend in one external plan.',
          narrative: 'Ralph avança, ataca e assume guarda.',
          resolutionPolicy: 'allow_partial',
          components: [
            { type: 'move', destination: 'engaged' },
            { type: 'attack', inventoryEntryRef: 'hardening-budget-sword-1', targetRefs: [two.npcRefs[0]!] },
            { type: 'defend' },
          ],
        },
      }));
      openEncounterRefs.set(planRef, { scope: two.scope, stateVersion: plan.value.stateVersion });
      report('plan_move_attack_defend', plan, 1, planCreated.stateVersion);
      expect(plan.metrics.queryCount).toBeLessThanOrEqual(180);
      expect(stage(plan, 'encounter_capsule_assembly')?.calls).toBe(1);
      expect(plan.value.beatSummary?.componentResults).toHaveLength(3);
      await cancelOpen(two.scope, planRef, plan.value.stateVersion, 'hardening-budget-plan-cancel');

      if (process.env.REPORT_ENCOUNTER_BUDGETS === '1') {
        console.info(`ENCOUNTER_HARDENING_METRICS=${JSON.stringify(reports)}`);
      }
    } finally {
      for (const [encounterRef, open] of openEncounterRefs) {
        await cancelOpen(open.scope, encounterRef, open.stateVersion, `${encounterRef}-forced-cleanup`);
      }
    }
  });

  it('resolves a composite player beat, NPC fallback, reaction preparation and checkpoint in one external mutation', async () => {
    const encounterRef = 'phase-beat-resolution';
    const created = await encounterService.create({
      ...seedScope,
      idempotencyKey: 'phase-beat-create-0001',
      encounterRef,
      partySideRef: 'party',
      participants: [
        { bindingKind: 'persisted_actor', actorRef: 'ralph', sideRef: 'party', zone: 'near' },
        { bindingKind: 'persisted_actor', actorRef: 'lyra', sideRef: 'hostile', zone: 'far' },
      ],
      relations: [
        { leftActorRef: 'lyra', rightActorRef: 'lyra', relation: 'self' },
        { leftActorRef: 'lyra', rightActorRef: 'ralph', relation: 'hostile' },
        { leftActorRef: 'ralph', rightActorRef: 'ralph', relation: 'self' },
      ],
    });
    let cleanupNeeded = true;
    try {
      expect(created.lifecycleStatus).toBe('processing_paused');
      const input = {
        ...seedScope,
        encounterRef,
        idempotencyKey: 'phase-beat-resolve-0001',
        expectedStateVersion: created.stateVersion,
        intent: {
        actorRef: 'ralph',
        objective: 'reposition_protect_prepare',
        narrative: 'Ralph recua, assume uma guarda e prepara sua magia se Lyra avançar.',
        resolutionPolicy: 'atomic' as const,
          components: [
            { type: 'move' as const, destination: 'medium' as const },
            { type: 'protect' as const, targetRef: 'ralph' },
            {
              type: 'prepare' as const,
              trigger: 'enemy_advances' as const,
              targetRefs: ['ralph'],
              contentRef: {
                scope: 'campaign' as const, contentType: 'spell' as const,
                code: 'seed-mark-spell', versionNumber: 1,
              },
            },
          ],
        },
        npcDirectives: [{ actorRef: 'lyra', strategy: 'aggressive' as const }],
      };
      const resolved = await encounterService.resolveBeat(input);
      expect(resolved).toMatchObject({
        operation: 'resolve_beat', lifecycleStatus: 'awaiting_intent',
      beatSummary: {
        externalTransitions: 1, resolutionPolicy: 'atomic', partialResolutionApplied: false,
        requiresPlayerDecision: true,
        componentResults: [
          {
            index: 0, type: 'move', status: 'modified', code: 'MOVEMENT_KIND_INFERRED',
          },
          { index: 1, type: 'protect', status: 'accepted', code: 'GUARD_PREPARED' },
          { index: 2, type: 'prepare', status: 'accepted' },
        ],
        },
      });
      expect(typeof resolved.beatSummary?.componentResults[0]?.requested).toBe('string');
      expect(typeof resolved.beatSummary?.componentResults[0]?.applied).toBe('string');
      expect(resolved.stateVersion).toBeGreaterThan(created.stateVersion);
      expect(resolved.beatSummary?.actorsActed).toEqual(expect.arrayContaining(['ralph', 'lyra']));
    expect(resolved.beatSummary?.npcActions).toEqual([
      expect.objectContaining({ actorRef: 'lyra', strategy: 'aggressive' }),
    ]);
    expect(resolved.beatSummary?.npcResults).toEqual([{ actorRef: 'lyra', status: 'acted' }]);
    expect(resolved.scene).toMatchObject({ stateVersion: resolved.stateVersion });
    expect(resolved.nextRequiredAction.type).not.toBe('continue');
    expect(resolved.scene?.participants.find((participant) => participant.actorRef === 'ralph')?.preparedActionRefs)
      .toEqual(expect.arrayContaining([expect.stringContaining('prepared-enemy-advances-')]));
      await expect(prisma.encounterOperation.count({ where: { encounter: { encounterRef } } })).resolves.toBe(2);

      const replay = await encounterService.resolveBeat(input);
      expect(replay).toEqual(resolved);
      await expect(prisma.encounterOperation.count({ where: { encounter: { encounterRef } } })).resolves.toBe(2);

      const auditRows = await prisma.encounterOperation.findMany({
        where: { encounter: { encounterRef } }, orderBy: { nextStateVersion: 'asc' },
        select: { operation: true, idempotencyRecord: { select: { operation: true } } },
      });
      expect(auditRows.map((row) => ({ kind: row.operation, namespace: row.idempotencyRecord.operation })))
        .toEqual([
          { kind: EncounterOperationKind.CREATE, namespace: 'encounter.create' },
          { kind: EncounterOperationKind.SUBMIT_INTENT, namespace: 'encounter.resolve_beat' },
        ]);
      await expect(encounterService.submitIntent({
        ...seedScope, encounterRef, idempotencyKey: input.idempotencyKey,
        expectedStateVersion: resolved.stateVersion,
        intent: {
          intentRef: 'legacy-key-collision', sourceActorRef: 'ralph', slotRef: 'primary',
          actionSource: 'basic_weapon_attack', targetSelector: 'explicit',
          requestedTargetRefs: ['lyra'], weaponEntryRef: 'starter-dagger-1',
        },
      })).rejects.toMatchObject({ code: 'ENCOUNTER_IDEMPOTENCY_KEY_REUSED' });

      const staleKey = 'phase-beat-stale-0001';
      await expect(encounterService.resolveBeat({
        ...input, idempotencyKey: staleKey, expectedStateVersion: created.stateVersion,
      })).rejects.toMatchObject({ code: 'ENCOUNTER_EXPECTED_VERSION_CONFLICT' });
      await expect(prisma.idempotencyRecord.count({ where: { key: `encounter:${staleKey}` } })).resolves.toBe(0);

      await encounterService.cancel({
        ...seedScope,
        encounterRef,
        idempotencyKey: 'phase-beat-cancel-0001',
        expectedStateVersion: resolved.stateVersion,
      });
      cleanupNeeded = false;
    } finally {
      if (cleanupNeeded) {
        const persisted = await prisma.encounter.findFirst({
          where: { encounterRef },
          select: { lifecycleStatus: true, stateVersion: true },
        });
        const terminalStatuses = new Set<EncounterLifecycleStatus>([
          EncounterLifecycleStatus.COMPLETED,
          EncounterLifecycleStatus.FAILED,
          EncounterLifecycleStatus.CANCELLED,
        ]);
        if (persisted !== null && !terminalStatuses.has(persisted.lifecycleStatus)) {
          await encounterService.cancel({
            ...seedScope,
            encounterRef,
            idempotencyKey: 'phase-beat-cleanup-0001',
            expectedStateVersion: persisted.stateVersion,
          });
        }
      }
    }
  });

  it('requires explicit partial policy and rolls back essential failures without hidden mutations', async () => {
    const encounterRef = 'phase-beat-partial-policy';
    const created = await encounterService.create({
      ...seedScope, encounterRef, idempotencyKey: 'phase-beat-partial-create', partySideRef: 'party',
      participants: [
        { bindingKind: 'persisted_actor', actorRef: 'ralph', sideRef: 'party', zone: 'near' },
        { bindingKind: 'persisted_actor', actorRef: 'lyra', sideRef: 'hostile', zone: 'far' },
      ],
      relations: [
        { leftActorRef: 'lyra', rightActorRef: 'lyra', relation: 'self' },
        { leftActorRef: 'lyra', rightActorRef: 'ralph', relation: 'hostile' },
        { leftActorRef: 'ralph', rightActorRef: 'ralph', relation: 'self' },
      ],
    });
    let currentVersion = created.stateVersion;
    try {
      const invalidFourKey = 'phase-beat-four-components';
      const invalidFour = await post('/api/v1/encounters/manage', {
        operation: 'resolve_beat', encounterRef, idempotencyKey: invalidFourKey,
        expectedStateVersion: created.stateVersion,
        intent: {
          actorRef: 'ralph', objective: 'too_many_components', narrative: 'This request must be rejected.',
          resolutionPolicy: 'atomic',
          components: [{ type: 'defend' }, { type: 'defend' }, { type: 'defend' }, { type: 'defend' }],
        },
        npcDirectives: [],
      });
      expect(invalidFour.status).toBe(400);
      expect(invalidFour.body).toMatchObject({ error: { code: 'INVALID_INPUT' } });
      expect(JSON.stringify(invalidFour.body)).toContain('received 4');
      expect(JSON.stringify(invalidFour.body)).toContain('Split the intention');
      await expect(prisma.encounterOperation.count({ where: { encounter: { encounterRef } } })).resolves.toBe(1);
      await expect(prisma.idempotencyRecord.count({ where: { key: `encounter:${invalidFourKey}` } })).resolves.toBe(0);

      const components = [
        { type: 'move' as const, destination: 'medium' as const },
        { type: 'move' as const, destination: 'far' as const, essential: true },
        {
          type: 'prepare' as const, trigger: 'enemy_attacks' as const, targetRefs: ['ralph'],
          contentRef: { scope: 'campaign' as const, contentType: 'spell' as const, code: 'seed-mark-spell', versionNumber: 1 },
        },
      ];
      const essentialKey = 'phase-beat-essential-rejected';
      await expect(encounterService.resolveBeat({
        ...seedScope, encounterRef, idempotencyKey: essentialKey,
        expectedStateVersion: created.stateVersion,
        intent: {
          actorRef: 'ralph', objective: 'test_essential_rollback', narrative: 'Test essential rollback.',
          resolutionPolicy: 'allow_partial', components,
        },
        npcDirectives: [{ actorRef: 'lyra', strategy: 'defensive' }],
      })).rejects.toMatchObject({
        code: 'ENCOUNTER_BEAT_ATOMIC_REJECTED',
        issues: [
          expect.objectContaining({ path: 'intent.components.0', code: 'ATOMIC_ROLLBACK' }),
          expect.objectContaining({ path: 'intent.components.1', code: 'DISTANCE_INCOMPATIBLE' }),
          expect.objectContaining({ path: 'intent.components.2', code: 'COMPONENT_NOT_RESOLVED' }),
        ],
      });
      await expect(prisma.encounterOperation.count({ where: { encounter: { encounterRef } } })).resolves.toBe(1);
      await expect(prisma.idempotencyRecord.count({ where: { key: `encounter:${essentialKey}` } })).resolves.toBe(0);
      const afterRollback = await encounterService.load({ ...seedScope, encounterRef });
      expect(afterRollback.stateVersion).toBe(created.stateVersion);
      expect(afterRollback.scene?.participants.find((entry) => entry.actorRef === 'ralph'))
        .toMatchObject({ zone: 'near' });
      expect(afterRollback.scene?.participants.find((entry) => entry.actorRef === 'ralph'))
        .not.toHaveProperty('preparedActionRefs');

      const partialKey = 'phase-beat-partial-accepted';
      const partial = await encounterService.resolveBeat({
        ...seedScope, encounterRef, idempotencyKey: partialKey,
        expectedStateVersion: created.stateVersion,
        intent: {
          actorRef: 'ralph', objective: 'test_safe_partial', narrative: 'Test explicit safe partial resolution.',
          resolutionPolicy: 'allow_partial',
          components: components.map((component) => ({ ...component, essential: false })),
        },
        npcDirectives: [{ actorRef: 'lyra', strategy: 'defensive' }],
      });
      currentVersion = partial.stateVersion;
      expect(partial.beatSummary).toMatchObject({
        resolutionPolicy: 'allow_partial', partialResolutionApplied: true,
        componentResults: [
          { index: 0, status: 'modified', code: 'MOVEMENT_KIND_INFERRED' },
          { index: 1, status: 'rejected', code: 'DISTANCE_INCOMPATIBLE' },
          { index: 2, status: 'rejected', code: 'COMPONENT_NOT_RESOLVED' },
        ],
        npcResults: [{ actorRef: 'lyra', status: 'acted' }],
      });
      expect(partial.scene?.participants.find((entry) => entry.actorRef === 'ralph'))
        .toMatchObject({ zone: 'medium' });
      expect(partial.scene?.participants.find((entry) => entry.actorRef === 'ralph'))
        .not.toHaveProperty('preparedActionRefs');
      await expect(prisma.encounterOperation.count({ where: { encounter: { encounterRef } } })).resolves.toBe(2);
    } finally {
      const persisted = await prisma.encounter.findFirst({ where: { encounterRef }, select: { lifecycleStatus: true, stateVersion: true } });
      if (persisted !== null && !new Set<EncounterLifecycleStatus>([
        EncounterLifecycleStatus.COMPLETED, EncounterLifecycleStatus.FAILED, EncounterLifecycleStatus.CANCELLED,
      ]).has(persisted.lifecycleStatus)) {
        await encounterService.cancel({
          ...seedScope, encounterRef, idempotencyKey: 'phase-beat-partial-cleanup',
          expectedStateVersion: Math.max(currentVersion, persisted.stateVersion),
        });
      }
    }
  });

  it('processes at most four NPCs deterministically and explicitly defers excess actors', async () => {
    const four = await createBeatNpcFixture('limit-four', 4);
    const five = await createBeatNpcFixture('limit-five', 5);
    let fourVersion = four.created.stateVersion;
    let fiveVersion = five.created.stateVersion;
    try {
      const fiveKey = 'beat-limit-five-resolve';
      const fiveResponse = await post('/api/v1/encounters/manage', {
        ...five.scope, operation: 'resolve_beat', encounterRef: five.encounterRef, idempotencyKey: fiveKey,
        expectedStateVersion: five.created.stateVersion,
        intent: {
          actorRef: five.heroRef, objective: 'reposition', narrative: 'The hero repositions.',
          resolutionPolicy: 'atomic', components: [{ type: 'move', destination: 'medium' }],
        },
        npcDirectives: five.npcRefs.map((actorRef) => ({ actorRef, strategy: 'aggressive' })),
      });
      expect(fiveResponse.status).toBe(200);
      expect(fiveResponse.body).toMatchObject({
        beatSummary: {
          externalTransitions: 1,
          deferredNpcActorRefs: [expect.any(String)],
        },
      });
      const fiveBody = fiveResponse.body as EncounterPublicDto;
      fiveVersion = fiveBody.stateVersion;
      expect(fiveBody.beatSummary?.npcResults).toHaveLength(4);
      expect(fiveBody.beatSummary?.deferredNpcActorRefs).toHaveLength(1);
      expect(new Set([
        ...(fiveBody.beatSummary?.npcResults.map((result) => result.actorRef) ?? []),
        ...(fiveBody.beatSummary?.deferredNpcActorRefs ?? []),
      ])).toEqual(new Set(five.npcRefs));
      await expect(prisma.encounterOperation.count({ where: { encounter: { encounterRef: five.encounterRef } } })).resolves.toBe(2);
      await expect(prisma.idempotencyRecord.count({ where: { key: `encounter:${fiveKey}` } })).resolves.toBe(1);

      const resolvedFour = await encounterService.resolveBeat({
        ...four.scope, encounterRef: four.encounterRef, idempotencyKey: 'beat-limit-four-resolve',
        expectedStateVersion: four.created.stateVersion,
        intent: {
          actorRef: four.heroRef, objective: 'reposition', narrative: 'The hero repositions.',
          resolutionPolicy: 'atomic', components: [{ type: 'move', destination: 'medium' }],
        },
        npcDirectives: four.npcRefs.map((actorRef) => ({ actorRef, strategy: 'aggressive' })),
      });
      fourVersion = resolvedFour.stateVersion;
      expect(resolvedFour.beatSummary?.npcResults).toEqual(
        [...four.npcRefs].sort().map((actorRef) => ({
          actorRef, status: 'rejected', reason: 'distance_incompatible',
        })),
      );
      expect(resolvedFour.beatSummary?.npcActions).toEqual([]);
      expect(resolvedFour.scene?.participants).toHaveLength(5);
      expect(resolvedFour.scene?.participants.map((participant) => participant.actorRef))
        .not.toEqual(expect.arrayContaining(five.npcRefs));
      await expect(prisma.encounterOperation.count({ where: { encounter: { encounterRef: four.encounterRef } } })).resolves.toBe(2);
    } finally {
      for (const fixture of [four, five]) {
        const persisted = await prisma.encounter.findFirst({
          where: { encounterRef: fixture.encounterRef }, select: { lifecycleStatus: true, stateVersion: true },
        });
        if (persisted !== null && !new Set<EncounterLifecycleStatus>([
          EncounterLifecycleStatus.COMPLETED, EncounterLifecycleStatus.FAILED, EncounterLifecycleStatus.CANCELLED,
        ]).has(persisted.lifecycleStatus)) {
          await encounterService.cancel({
            ...fixture.scope, encounterRef: fixture.encounterRef,
            idempotencyKey: `${fixture.encounterRef}-cleanup`,
            expectedStateVersion: fixture === four
              ? Math.max(fourVersion, persisted.stateVersion)
              : Math.max(fiveVersion, persisted.stateVersion),
          });
        }
      }
    }
  });

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
    const legacyAudit = await prisma.encounterOperation.findFirstOrThrow({
      where: { encounter: { encounterRef: createInput.encounterRef }, idempotencyRecord: { operation: 'encounter.submit_intent' } },
      select: { operation: true, previousStateVersion: true, nextStateVersion: true, idempotencyRecord: { select: { operation: true } } },
    });
    expect(legacyAudit).toMatchObject({
      operation: EncounterOperationKind.SUBMIT_INTENT,
      idempotencyRecord: { operation: 'encounter.submit_intent' },
    });
    expect(legacyAudit.nextStateVersion).toBeGreaterThan(legacyAudit.previousStateVersion);

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

  it('blocks external authority writes and abandons confirmed drift without resolution or rewards', async () => {
    const encounterRef = 'phase-authority-drift-recovery';
    const created = await encounterService.create({
      ...seedScope, encounterRef, idempotencyKey: 'phase-authority-drift-create', partySideRef: 'party',
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
    const actor = await prisma.actor.findFirstOrThrow({
      where: { code: 'ralph', campaign: { code: seedScope.campaignRef } },
      include: { resources: { orderBy: { type: 'asc' } } },
    });
    const before = { xp: actor.xp, gold: actor.gold, resources: actor.resources.map((resource) => ({ type: resource.type, current: resource.current })) };
    const campaign = await prisma.campaign.findFirstOrThrow({ where: { code: seedScope.campaignRef, world: { code: seedScope.worldRef } } });
    const eventCount = await prisma.gameEvent.count({ where: { campaignId: campaign.id } });
    await prisma.campaign.update({ where: { id: campaign.id }, data: { engineTick: { increment: 1n } } });
    try {
      await expect(prismaGptRepository.patchActor('ralph', {
        ...seedScope, idempotencyKey: 'phase-authority-drift-patch', description: 'must-not-persist',
      })).rejects.toMatchObject({ code: 'ACTOR_ENCOUNTER_LOCKED', recoveryAction: 'finish_or_abandon_encounter' });
      const game = await prismaGptRepository.loadGame(seedScope);
      expect((game as Record<string, unknown>).activeEncounter).toMatchObject({
        encounterRef, canContinue: false, canCancel: false, canAbandon: true,
        integrityStatus: 'authority_drift', recoveryAction: 'abandon_encounter',
      });
      await expect(encounterService.cancel({
        ...seedScope, encounterRef, idempotencyKey: 'phase-authority-drift-cancel', expectedStateVersion: created.stateVersion,
      })).rejects.toMatchObject({ code: 'ENCOUNTER_CAMPAIGN_TICK_DRIFT' });
      const input = {
        operation: 'abandon' as const, ...seedScope, encounterRef, idempotencyKey: 'phase-authority-drift-abandon',
        expectedStateVersion: created.stateVersion, confirmAuthorityDrift: true as const,
      };
      const beatInput = {
        operation: 'resolve_beat' as const, ...seedScope, encounterRef,
        idempotencyKey: 'phase-authority-drift-beat-race', expectedStateVersion: created.stateVersion,
        intent: {
          actorRef: 'ralph', objective: 'hold_position', narrative: 'Ralph mantém posição.',
          resolutionPolicy: 'atomic' as const, components: [{ type: 'move' as const, destination: 'medium' as const }],
        },
        npcDirectives: [{ actorRef: 'lyra', strategy: 'aggressive' as const }],
      };
      const race = await Promise.allSettled([
        dependencies.encounterHttpService.manage(beatInput),
        dependencies.encounterHttpService.manage(input),
      ]);
      expect(race.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
      expect(race[0]).toMatchObject({ status: 'rejected' });
      if (race[0]?.status !== 'rejected') throw new Error('resolve_beat must lose the abandon race');
      const rejectedReason: unknown = race[0].reason;
      if (rejectedReason === null || typeof rejectedReason !== 'object') throw new Error('Race rejection must expose a safe code');
      expect(['ENCOUNTER_AUTHORITY_DRIFT', 'STATE_VERSION_CONFLICT'])
        .toContain((rejectedReason as { code?: unknown }).code);
      expect(race[1]).toMatchObject({ status: 'fulfilled' });
      const winner = race.find((attempt) => attempt.status === 'fulfilled');
      if (winner?.status !== 'fulfilled') throw new Error('Abandon race winner is required');
      const abandoned = winner.value;
      expect(abandoned).toEqual({
        result: 'encounter_abandoned', operation: 'abandon', lifecycleStatus: 'failed', stopReason: 'encounter_failed',
        encounterRef, stateVersion: created.stateVersion + 1, currentTick: created.currentTick,
        completionCandidate: null, participants: created.participants, nextRequiredAction: { type: 'none' },
        recoverySummary: {
          reason: 'authority_drift', authority: 'campaign_tick', actionResolved: false,
          damageApplied: false, costApplied: false, rewardsGranted: false, campaignReleased: true,
        },
      });
      expect(abandoned).not.toHaveProperty('consequencesSummary');
      expect(abandoned).not.toHaveProperty('transitionSummary');
      expect(abandoned).not.toHaveProperty('beatSummary');
      await expect(dependencies.encounterHttpService.manage(input)).resolves.toEqual(abandoned);
      await expect(prisma.idempotencyRecord.count({ where: { key: `encounter:${input.idempotencyKey}` } })).resolves.toBe(1);
      await expect(prisma.idempotencyRecord.count({ where: { key: `encounter:${beatInput.idempotencyKey}` } })).resolves.toBe(0);
      await expect(prismaGptRepository.loadGame(seedScope)).resolves.toMatchObject({ activeEncounter: null });
      const persisted = await prisma.encounter.findFirstOrThrow({
        where: { campaignId: campaign.id, encounterRef },
        include: { consequence: true, operations: { orderBy: { nextStateVersion: 'desc' }, take: 1, include: { idempotencyRecord: true } } },
      });
      expect(persisted).toMatchObject({ lifecycleStatus: EncounterLifecycleStatus.FAILED, consequence: null });
      expect(persisted.operations[0]).toMatchObject({
        operation: EncounterOperationKind.CANCEL,
        idempotencyRecord: { operation: 'encounter.abandon' },
      });
      await expect(prisma.encounterOperation.count({
        where: {
          encounterId: persisted.id,
          operation: EncounterOperationKind.CANCEL,
          idempotencyRecord: { operation: 'encounter.abandon' },
        },
      })).resolves.toBe(1);
      const after = await prisma.actor.findUniqueOrThrow({
        where: { id: actor.id }, include: { resources: { orderBy: { type: 'asc' } } },
      });
      expect({ xp: after.xp, gold: after.gold, resources: after.resources.map((resource) => ({ type: resource.type, current: resource.current })) })
        .toEqual(before);
      await expect(prisma.gameEvent.count({ where: { campaignId: campaign.id } })).resolves.toBe(eventCount);

      const reopened = await encounterService.create({
        ...seedScope, encounterRef: 'phase-authority-drift-reopened', idempotencyKey: 'phase-authority-drift-reopened-create',
        partySideRef: 'party',
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
      await expect(encounterService.cancel({
        ...seedScope, encounterRef: reopened.encounterRef, idempotencyKey: 'phase-authority-drift-reopened-cancel',
        expectedStateVersion: reopened.stateVersion,
      })).resolves.toMatchObject({ lifecycleStatus: 'cancelled' });
    } finally {
      await prisma.campaign.update({ where: { id: campaign.id }, data: { engineTick: campaign.engineTick } });
      const open = await prisma.encounter.findFirst({
        where: { campaignId: campaign.id, encounterRef, lifecycleStatus: { in: [...ACTIVE_ENCOUNTER_LIFECYCLES] } },
        select: { stateVersion: true },
      });
      if (open !== null) {
        await encounterService.cancel({
          ...seedScope, encounterRef, idempotencyKey: 'phase-authority-drift-emergency-cancel',
          expectedStateVersion: open.stateVersion,
        });
      }
    }
  });

  it('confirms a valid completion with an auditable consequence while preserving a legacy unowned effect', async () => {
    const encounterScopedEffect = await prisma.activeEffect.findFirstOrThrow({
      where: {
        targetActor: { code: 'ralph', campaign: { code: seedScope.campaignRef } },
        sourceContentVersion: { contentDefinition: { code: 'seed-mark-spell' } },
      },
    });
    const legacyEncounterEffectId: string = encounterScopedEffect.id;
    await prisma.$executeRawUnsafe('ALTER TABLE "ActiveEffect" DISABLE TRIGGER "ActiveEffect_validate_encounter_origin"');
    try {
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
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "ActiveEffect" ENABLE TRIGGER "ActiveEffect_validate_encounter_origin"');
    }
    await expect(prisma.activeEffect.update({
      where: { id: legacyEncounterEffectId }, data: { durationType: 'PERMANENT' },
    })).rejects.toThrow(/ownership identity is immutable/);
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
      participants: parseCoreV1EncounterSnapshot(record.stateSnapshot).participants.map((participant) => (
        participant.actorRef === 'lyra' ? {
          ...participant,
          combatState: 'incapacitated_candidate' as const,
          resources: { ...participant.resources, hp: { ...participant.resources.hp, current: 0 } },
        } : participant
      )),
    };
    const snapshot = serializeCoreV1EncounterState(candidate);
    const hash = createCoreV1EncounterSnapshotHash(snapshot);
    const idempotency = await prisma.idempotencyRecord.create({
      data: {
        key: 'phase-1l-b-confirm-preparation', operation: 'encounter.continue', requestHash: 'a'.repeat(64),
      },
    });
    const lyra = await prisma.actor.findFirstOrThrow({
      where: { code: 'lyra', campaign: { code: seedScope.campaignRef } },
      include: { resources: true },
    });
    const lyraHp = lyra.resources.find((resource) => resource.type === 'HP');
    if (lyraHp === undefined) throw new Error('Lyra HP resource is required');
    const previousSummary = record.operations[0]!.resultSummary as Record<string, unknown>;
    const previousAdapter = previousSummary.adapterState as {
      schemaVersion: number;
      participants: Array<{
        actorRef: string;
        resourceStateVersions: { hp: number; mana: number; sp: number };
      }>;
    };
    const preparedSummary = {
      adapterState: {
        ...previousAdapter,
        participants: previousAdapter.participants.map((participant) => participant.actorRef === 'lyra'
          ? { ...participant, resourceStateVersions: { ...participant.resourceStateVersions, hp: participant.resourceStateVersions.hp + 1 } }
          : participant),
      },
    };
    await prisma.$transaction(async (transaction) => {
      await transaction.actorResource.update({
        where: { id: lyraHp.id }, data: { current: 0, stateVersion: { increment: 1 } },
      });
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
          resultSummary: preparedSummary,
        },
      });
    });
    const completed = await post('/api/v1/encounters/manage', {
      operation: 'confirm_completion',
      encounterRef: created.encounterRef,
      idempotencyKey: 'phase-1l-b-confirm-operation',
      expectedStateVersion: 2,
    });
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({
      result: 'encounter_completed', lifecycleStatus: 'completed',
      completionCandidate: 'party_victory_candidate', stateVersion: 3,
      nextRequiredAction: { type: 'none' },
      consequencesSummary: {
        schemaVersion: 1, outcome: 'party_victory',
        actorChanges: [{ actorRef: 'lyra', statusBefore: 'active', statusAfter: 'defeated' }],
        removedEncounterEffects: [],
        persistentEvent: { eventType: 'encounter-completed', actorRef: 'ralph' },
      },
    });
    const after = await prisma.actor.findFirstOrThrow({
      where: { code: 'ralph', campaign: { code: seedScope.campaignRef } },
      select: { xp: true, gold: true },
    });
    expect(after).toEqual(before);
    await expect(prisma.actor.findUniqueOrThrow({ where: { id: lyra.id }, select: { status: true } }))
      .resolves.toEqual({ status: 'DEFEATED' });
    await expect(prisma.activeEffect.findUnique({ where: { id: legacyEncounterEffectId } })).resolves.not.toBeNull();
    const closed = await prisma.encounter.findUniqueOrThrow({ where: { id: record.id } });
    expect(closed.lifecycleStatus).toBe(EncounterLifecycleStatus.COMPLETED);
    expect(closed.closedAt).toBeInstanceOf(Date);
    await expect(prisma.encounterConsequence.count({ where: { encounterId: record.id } })).resolves.toBe(1);
    await expect(prisma.gameEvent.count({
      where: { idempotencyKey: `encounter-outcome:${record.id}:v1` },
    })).resolves.toBe(1);
    await prisma.$transaction(async (transaction) => {
      await transaction.actor.update({ where: { id: lyra.id }, data: { status: 'ACTIVE' } });
      await transaction.actorResource.update({
        where: { id: lyraHp.id },
        data: { current: lyraHp.current, stateVersion: { increment: 1 } },
      });
    });
    const historicalLoad = await encounterService.load({ ...seedScope, encounterRef: created.encounterRef });
    expect(historicalLoad.consequencesSummary).toEqual(bodyRecord(completed).consequencesSummary);
    const terminalOperation = await prisma.encounterOperation.findFirstOrThrow({
      where: { encounterId: record.id }, orderBy: { nextStateVersion: 'desc' },
    });
    const terminalResult = terminalOperation.resultSummary as {
      adapterState: { schemaVersion: number; participants: Array<Record<string, unknown>> };
      consequencesSummary: unknown;
    };
    await prisma.$executeRawUnsafe('ALTER TABLE "EncounterOperation" DISABLE TRIGGER "EncounterOperation_reject_update"');
    try {
      await prisma.encounterOperation.update({
        where: { id: terminalOperation.id },
        data: {
          resultSummary: {
            ...terminalResult,
            adapterState: {
              ...terminalResult.adapterState,
              participants: terminalResult.adapterState.participants.map((participant, index) => (
                index === 0 ? { ...participant, actorRef: 'aaa-tampered-terminal-actor' } : participant
              )),
            },
          } as Prisma.InputJsonValue,
        },
      });
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "EncounterOperation" ENABLE TRIGGER "EncounterOperation_reject_update"');
    }
    await expect(encounterService.load({ ...seedScope, encounterRef: created.encounterRef }))
      .rejects.toMatchObject({ code: 'ENCOUNTER_PARTICIPANT_INVALID' });
  });

  it('owns and removes only this Encounter effects on cancel, then replays without duplication', async () => {
    const actor = await prisma.actor.findFirstOrThrow({
      where: { code: 'ralph', campaign: { code: seedScope.campaignRef } },
      include: { campaign: true },
    });
    const status = await publishTestContent({
      worldId: actor.campaign.worldId,
      campaignId: actor.campaignId,
      contentType: ContentType.STATUS_EFFECT,
      code: 'phase-1m-a-encounter-mark',
      name: 'Marca do encontro 1M-A',
      description: 'Efeito de integração limitado ao encontro.',
      profile: {
        schemaVersion: 1, rulesetCode: 'core-v1', profileMode: 'mechanical', contentKind: 'status_effect',
        code: 'phase-1m-a-encounter-mark', name: 'Marca do encontro 1M-A',
        description: 'Efeito de integração limitado ao encontro.', tier: 1, rarity: 'common',
        activation: { type: 'passive' }, cost: { type: 'none' }, duration: { type: 'encounter' },
        stacking: { type: 'refresh' },
        passiveModifiers: [{ target: 'magicalDefense', amount: -1, sourceRule: 'status_effect' }],
      },
    });
    const spell = await publishTestContent({
      worldId: actor.campaign.worldId,
      campaignId: actor.campaignId,
      contentType: ContentType.SPELL,
      code: 'phase-1m-a-encounter-spell',
      name: 'Selo do encontro 1M-A',
      description: 'Aplica efeito pertencente ao encontro.',
      profile: {
        schemaVersion: 1, rulesetCode: 'core-v1', profileMode: 'mechanical', contentKind: 'spell',
        code: 'phase-1m-a-encounter-spell', name: 'Selo do encontro 1M-A',
        description: 'Aplica efeito pertencente ao encontro.', tier: 1, rarity: 'common',
        activation: { type: 'active' }, cost: { type: 'mana', amount: 3 }, actionProfile: 'quick',
        targeting: { type: 'single_target', rangeBand: 'near', maxTargets: 1 },
        effects: [{
          type: 'apply_status', statusRef: status.code, duration: { type: 'encounter' },
          stacking: { type: 'refresh' },
        }],
      },
    });
    const spellVersion = spell.versions[0];
    if (spellVersion === undefined) throw new Error('Encounter spell version is required');
    await prisma.actorContent.upsert({
      where: { actorId_contentDefinitionId: { actorId: actor.id, contentDefinitionId: spell.id } },
      update: { contentVersionId: spellVersion.id, state: ActorContentState.KNOWN },
      create: {
        actorId: actor.id, contentDefinitionId: spell.id, contentVersionId: spellVersion.id,
        state: ActorContentState.KNOWN,
      },
    });
    const encounterRef = 'phase-1m-a-owned-effect';
    const created = await encounterService.create({
      ...seedScope,
      encounterRef,
      idempotencyKey: 'phase-1m-a-owned-effect-create',
      partySideRef: 'party',
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
      ...seedScope, encounterRef, idempotencyKey: 'phase-1m-a-owned-effect-ready',
      expectedStateVersion: created.stateVersion,
    });
    const submitted = await encounterService.submitIntent({
      ...seedScope, encounterRef, idempotencyKey: 'phase-1m-a-owned-effect-submit',
      expectedStateVersion: ready.stateVersion,
      intent: {
        intentRef: 'phase-1m-a-owned-effect-intent', sourceActorRef: 'ralph', slotRef: 'primary',
        actionSource: 'content', targetSelector: 'explicit', requestedTargetRefs: ['ralph'],
        contentRef: {
          scope: 'campaign', contentType: 'spell', code: spell.code, versionNumber: spellVersion.versionNumber,
        },
      },
    });
    const resolved = await encounterService.continue({
      ...seedScope, encounterRef, idempotencyKey: 'phase-1m-a-owned-effect-resolve',
      expectedStateVersion: submitted.stateVersion,
    });
    const encounter = await prisma.encounter.findFirstOrThrow({ where: { encounterRef } });
    const ownedEffect = await prisma.activeEffect.findFirstOrThrow({
      where: {
        targetActorId: actor.id,
        effectContentVersion: { contentDefinition: { code: status.code } },
      },
    });
    expect(ownedEffect).toMatchObject({ durationType: 'ENCOUNTER', originEncounterId: encounter.id });
    const actorBeforeCancel = await prisma.actor.findUniqueOrThrow({ where: { id: actor.id } });
    const cancelInput = {
      ...seedScope, encounterRef, idempotencyKey: 'phase-1m-a-owned-effect-cancel',
      expectedStateVersion: resolved.stateVersion,
    };
    const cancelled = await encounterService.cancel(cancelInput);
    expect(cancelled.consequencesSummary).toEqual({
      schemaVersion: 1, outcome: 'cancelled', actorChanges: [],
      removedEncounterEffects: [{ actorRef: 'ralph', count: 1 }],
      persistentEvent: { eventType: 'encounter-cancelled', actorRef: 'ralph' },
    });
    await expect(prisma.activeEffect.findUnique({ where: { id: ownedEffect.id } })).resolves.toBeNull();
    const actorAfterCancel = await prisma.actor.findUniqueOrThrow({ where: { id: actor.id } });
    expect(actorAfterCancel.effectsStateVersion).toBe(actorBeforeCancel.effectsStateVersion + 1);
    expect(actorAfterCancel.mechanicsStateVersion).toBe(actorBeforeCancel.mechanicsStateVersion + 1);
    const replay = await encounterService.cancel(cancelInput);
    expect(replay).toEqual(cancelled);
    await expect(prisma.encounterConsequence.count({ where: { encounterId: encounter.id } })).resolves.toBe(1);
    await expect(prisma.gameEvent.count({ where: { idempotencyKey: `encounter-outcome:${encounter.id}:v1` } })).resolves.toBe(1);
    await expect(prisma.encounterOperation.count({ where: { encounterId: encounter.id, operation: 'CANCEL' } })).resolves.toBe(1);

    const resourceRows = await prisma.actorResource.findMany({ where: { actorId: actor.id } });
    const resourceVersion = (type: 'HP' | 'MANA' | 'SP') => resourceRows.find((row) => row.type === type)?.stateVersion;
    const manaBeforeOutsideAttempt = resourceRows.find((row) => row.type === 'MANA');
    const outsideAttempt = await post('/api/v1/actors/effects/resolve', {
      operation: 'execute_content', sourceActorRef: actor.code, targetActorRef: actor.code,
      contentRef: { contentType: 'spell', code: spell.code, versionNumber: spellVersion.versionNumber },
      expectedSourceState: {
        mechanicsStateVersion: actorAfterCancel.mechanicsStateVersion,
        inventoryStateVersion: actorAfterCancel.inventoryStateVersion,
        effectsStateVersion: actorAfterCancel.effectsStateVersion,
        resourceStateVersions: {
          hp: resourceVersion('HP'), mana: resourceVersion('MANA'), sp: resourceVersion('SP'),
        },
      },
      idempotencyKey: 'phase-1m-a-outside-encounter-effect',
    });
    expect(outsideAttempt.status).toBe(500);
    expect(outsideAttempt.body).toMatchObject({ error: { code: 'EFFECT_INTEGRITY_ERROR', retryable: false } });
    await expect(prisma.effectResolution.count({ where: { idempotencyKey: 'phase-1m-a-outside-encounter-effect' } }))
      .resolves.toBe(0);
    if (manaBeforeOutsideAttempt === undefined) throw new Error('Mana resource is required');
    await expect(prisma.actorResource.findUniqueOrThrow({ where: { id: manaBeforeOutsideAttempt.id } }))
      .resolves.toMatchObject({ current: manaBeforeOutsideAttempt.current, stateVersion: manaBeforeOutsideAttempt.stateVersion });

    const protectedLegacyEffect = await prisma.activeEffect.findFirstOrThrow({
      where: { targetActorId: actor.id, durationType: 'ENCOUNTER', originEncounterId: null },
      select: { id: true },
    });
    const safeRead = await post('/api/v1/actors/effects/resolve', {
      operation: 'get', sourceActorRef: actor.code,
    });
    expect(safeRead.status).toBe(200);
    expect(safeRead.body).toMatchObject({ operation: 'get', actorRef: actor.code });

    const remover = await publishTestContent({
      worldId: actor.campaign.worldId, campaignId: actor.campaignId, contentType: ContentType.SPELL,
      code: 'phase-1m-a-remove-encounter-effect', name: 'Remoção indevida de encontro',
      description: 'Tenta remover fora do orquestrador um efeito protegido.',
      profile: {
        schemaVersion: 1, rulesetCode: 'core-v1', profileMode: 'mechanical', contentKind: 'spell',
        code: 'phase-1m-a-remove-encounter-effect', name: 'Remoção indevida de encontro',
        description: 'Tenta remover fora do orquestrador um efeito protegido.', tier: 1, rarity: 'common',
        activation: { type: 'active' }, cost: { type: 'mana', amount: 3 }, actionProfile: 'quick',
        targeting: { type: 'self', rangeBand: 'self' },
        effects: [{ type: 'remove_status', statusRef: 'seed-arcane-mark' }],
      },
    });
    const removerVersion = remover.versions[0];
    if (removerVersion === undefined) throw new Error('Encounter effect remover version is required');
    await prisma.actorContent.create({
      data: {
        actorId: actor.id, contentDefinitionId: remover.id, contentVersionId: removerVersion.id,
        state: ActorContentState.KNOWN,
      },
    });
    const removeAttempt = await post('/api/v1/actors/effects/resolve', {
      operation: 'execute_content', sourceActorRef: actor.code, targetActorRef: actor.code,
      contentRef: { contentType: 'spell', code: remover.code, versionNumber: removerVersion.versionNumber },
      expectedSourceState: {
        mechanicsStateVersion: actorAfterCancel.mechanicsStateVersion,
        inventoryStateVersion: actorAfterCancel.inventoryStateVersion,
        effectsStateVersion: actorAfterCancel.effectsStateVersion,
        resourceStateVersions: {
          hp: resourceVersion('HP'), mana: resourceVersion('MANA'), sp: resourceVersion('SP'),
        },
      },
      idempotencyKey: 'phase-1m-a-outside-remove-effect',
    });
    expect(removeAttempt.status).toBe(500);
    expect(removeAttempt.body).toMatchObject({ error: { code: 'EFFECT_INTEGRITY_ERROR', retryable: false } });
    await expect(prisma.activeEffect.findUnique({ where: { id: protectedLegacyEffect.id } })).resolves.not.toBeNull();
    await expect(prisma.effectResolution.count({ where: { idempotencyKey: 'phase-1m-a-outside-remove-effect' } }))
      .resolves.toBe(0);

    const recoveryRef = 'phase-1m-a-owned-effect-recovery';
    const recoveryCreated = await encounterService.create({
      ...seedScope, encounterRef: recoveryRef, idempotencyKey: 'phase-1m-a-owned-effect-recovery-create',
      partySideRef: 'party',
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
    const recoveryReady = await encounterService.continue({
      ...seedScope, encounterRef: recoveryRef, idempotencyKey: 'phase-1m-a-owned-effect-recovery-ready',
      expectedStateVersion: recoveryCreated.stateVersion,
    });
    const recoverySubmitted = await encounterService.submitIntent({
      ...seedScope, encounterRef: recoveryRef, idempotencyKey: 'phase-1m-a-owned-effect-recovery-submit',
      expectedStateVersion: recoveryReady.stateVersion,
      intent: {
        intentRef: 'phase-1m-a-owned-effect-recovery-intent', sourceActorRef: 'ralph', slotRef: 'primary',
        actionSource: 'content', targetSelector: 'explicit', requestedTargetRefs: ['ralph'],
        contentRef: { scope: 'campaign', contentType: 'spell', code: spell.code, versionNumber: spellVersion.versionNumber },
      },
    });
    const recoveryResolved = await encounterService.continue({
      ...seedScope, encounterRef: recoveryRef, idempotencyKey: 'phase-1m-a-owned-effect-recovery-resolve',
      expectedStateVersion: recoverySubmitted.stateVersion,
    });
    const recoveryEncounter = await prisma.encounter.findFirstOrThrow({ where: { encounterRef: recoveryRef } });
    const recoveryEffect = await prisma.activeEffect.findFirstOrThrow({
      where: { targetActorId: actor.id, originEncounterId: recoveryEncounter.id },
    });
    const beforeRecovery = await prisma.actor.findUniqueOrThrow({
      where: { id: actor.id }, include: { resources: { orderBy: { type: 'asc' } } },
    });
    const recoveryCampaign = await prisma.campaign.findUniqueOrThrow({ where: { id: actor.campaignId } });
    await prisma.campaign.update({ where: { id: recoveryCampaign.id }, data: { engineTick: { increment: 1n } } });
    try {
      const abandoned = await encounterService.abandon({
        ...seedScope, encounterRef: recoveryRef, idempotencyKey: 'phase-1m-a-owned-effect-recovery-abandon',
        expectedStateVersion: recoveryResolved.stateVersion, confirmAuthorityDrift: true,
      });
      expect(abandoned).toMatchObject({ operation: 'abandon', lifecycleStatus: 'failed', stopReason: 'encounter_failed' });
    } finally {
      await prisma.campaign.update({ where: { id: recoveryCampaign.id }, data: { engineTick: recoveryCampaign.engineTick } });
    }
    await expect(prisma.activeEffect.findUnique({ where: { id: recoveryEffect.id } })).resolves.toBeNull();
    await expect(prisma.encounterConsequence.count({ where: { encounterId: recoveryEncounter.id } })).resolves.toBe(0);
    await expect(prisma.gameEvent.count({ where: { idempotencyKey: `encounter-outcome:${recoveryEncounter.id}:v1` } })).resolves.toBe(0);
    const afterRecovery = await prisma.actor.findUniqueOrThrow({
      where: { id: actor.id }, include: { resources: { orderBy: { type: 'asc' } } },
    });
    expect(afterRecovery.effectsStateVersion).toBe(beforeRecovery.effectsStateVersion + 1);
    expect(afterRecovery.resources.map((resource) => ({ type: resource.type, current: resource.current })))
      .toEqual(beforeRecovery.resources.map((resource) => ({ type: resource.type, current: resource.current })));
  });

  it('blocks partial legacy closure, rejects ineligible entrants and serializes competing terminal writes', async () => {
    const encounterRef = 'phase-1m-a-terminal-integrity';
    const created = await encounterService.create({
      ...seedScope, encounterRef, idempotencyKey: 'phase-1m-a-terminal-integrity-create', partySideRef: 'party',
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
    const encounter = await prisma.encounter.findFirstOrThrow({ where: { encounterRef } });
    await expect(prisma.$transaction((transaction) => transaction.encounter.update({
      where: { id: encounter.id },
      data: { lifecycleStatus: EncounterLifecycleStatus.CANCELLED, closedAt: new Date() },
    }))).rejects.toThrow(/EncounterConsequence/);
    await expect(prisma.encounter.findUniqueOrThrow({ where: { id: encounter.id } }))
      .resolves.toMatchObject({ lifecycleStatus: encounter.lifecycleStatus, closedAt: null });

    await expect(prisma.$transaction(async (transaction) => {
      const idempotency = await transaction.idempotencyRecord.create({
        data: {
          key: 'phase-1m-a-old-code-operation-only', operation: 'encounter.cancel', requestHash: 'f'.repeat(64),
        },
      });
      const terminalHash = 'e'.repeat(64);
      await transaction.encounter.update({
        where: { id: encounter.id },
        data: {
          lifecycleStatus: EncounterLifecycleStatus.CANCELLED,
          completionCandidate: 'CANCELLED', stateVersion: encounter.stateVersion + 1,
          stateHash: terminalHash, closedAt: new Date(),
        },
      });
      await transaction.encounterOperation.create({
        data: {
          encounterId: encounter.id, idempotencyRecordId: idempotency.id,
          operation: EncounterOperationKind.CANCEL,
          previousStateVersion: encounter.stateVersion, nextStateVersion: encounter.stateVersion + 1,
          inputHash: 'f'.repeat(64), beforeStateHash: encounter.stateHash, afterStateHash: terminalHash,
          resultSummary: { adapterState: { schemaVersion: 1, participants: [] } },
        },
      });
    })).rejects.toThrow(/EncounterConsequence/);
    await expect(prisma.idempotencyRecord.count({ where: { key: 'phase-1m-a-old-code-operation-only' } }))
      .resolves.toBe(0);

    await expect(prisma.encounter.create({
      data: {
        campaignId: encounter.campaignId,
        rulesetVersionId: encounter.rulesetVersionId,
        encounterRef: 'phase-1m-a-insert-already-terminal',
        lifecycleStatus: EncounterLifecycleStatus.CANCELLED,
        stateVersion: 1, currentTick: encounter.currentTick,
        completionCandidate: 'CANCELLED', snapshotSchemaVersion: 1,
        stateSnapshot: encounter.stateSnapshot as Prisma.InputJsonValue,
        stateHash: encounter.stateHash, closedAt: new Date(),
      },
    })).rejects.toThrow(/EncounterConsequence/);

    await expect(prisma.encounterConsequence.create({
      data: {
        encounterId: encounter.id,
        encounterOperationId: (await prisma.encounterOperation.findFirstOrThrow({
          where: { encounterId: encounter.id }, orderBy: { nextStateVersion: 'desc' }, select: { id: true },
        })).id,
        gameEventId: randomUUID(), consequenceSchemaVersion: 1, rewardPolicyVersion: null,
        outcome: 'CANCELLED',
        resultSummary: {
          schemaVersion: 1, outcome: 'cancelled', actors: [], removedEncounterEffects: [],
          event: { eventType: 'encounter-cancelled', actorRef: null },
        },
      },
    })).rejects.toMatchObject({ code: 'P2003' });

    const terminalAttempts = await Promise.allSettled([
      encounterService.cancel({
        ...seedScope, encounterRef, idempotencyKey: 'phase-1m-a-terminal-race-a',
        expectedStateVersion: created.stateVersion,
      }),
      encounterService.cancel({
        ...seedScope, encounterRef, idempotencyKey: 'phase-1m-a-terminal-race-b',
        expectedStateVersion: created.stateVersion,
      }),
    ]);
    expect(terminalAttempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(terminalAttempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    await expect(prisma.encounterConsequence.count({ where: { encounterId: encounter.id } })).resolves.toBe(1);
    await expect(prisma.gameEvent.count({ where: { idempotencyKey: `encounter-outcome:${encounter.id}:v1` } })).resolves.toBe(1);
    const consequence = await prisma.encounterConsequence.findUniqueOrThrow({ where: { encounterId: encounter.id } });
    await expect(prisma.encounterConsequence.update({
      where: { id: consequence.id }, data: { rewardPolicyVersion: 'forbidden' },
    })).rejects.toThrow(/append-only/);
    await expect(prisma.encounterConsequence.delete({ where: { id: consequence.id } })).rejects.toThrow(/append-only/);
    await expect(prisma.gameEvent.delete({ where: { id: consequence.gameEventId } }))
      .rejects.toThrow(/RESTRICT/);
    await expect(prisma.encounterOperation.delete({ where: { id: consequence.encounterOperationId } }))
      .rejects.toThrow(/append-only/);
    const persistedTerminal = await prisma.encounter.findUniqueOrThrow({ where: { id: encounter.id } });
    const swappedLifecycle = persistedTerminal.lifecycleStatus === EncounterLifecycleStatus.CANCELLED
      ? EncounterLifecycleStatus.COMPLETED : EncounterLifecycleStatus.CANCELLED;
    await expect(prisma.encounter.update({
      where: { id: encounter.id },
      data: {
        lifecycleStatus: swappedLifecycle,
        completionCandidate: swappedLifecycle === EncounterLifecycleStatus.CANCELLED
          ? 'CANCELLED' : 'PARTY_VICTORY_CANDIDATE',
      },
    })).rejects.toThrow(/Terminal Encounter authority is immutable/);

    const lyra = await prisma.actor.findFirstOrThrow({
      where: { code: 'lyra', campaign: { code: seedScope.campaignRef } }, include: { resources: true },
    });
    await prisma.actor.update({ where: { id: lyra.id }, data: { status: 'DEFEATED' } });
    await expect(encounterService.create({
      ...seedScope, encounterRef: 'phase-1m-a-defeated-entry', idempotencyKey: 'phase-1m-a-defeated-entry-create',
      partySideRef: 'party', participants: [{ bindingKind: 'persisted_actor', actorRef: 'lyra', sideRef: 'party', zone: 'near' }],
      relations: [{ leftActorRef: 'lyra', rightActorRef: 'lyra', relation: 'self' }],
    })).rejects.toMatchObject({ code: 'ENCOUNTER_PARTICIPANT_INVALID' });
    await prisma.actor.update({ where: { id: lyra.id }, data: { status: 'ACTIVE' } });
    const hp = lyra.resources.find((resource) => resource.type === 'HP');
    if (hp === undefined) throw new Error('Lyra HP resource is required');
    await prisma.$transaction(async (transaction) => {
      await transaction.actorResource.update({ where: { id: hp.id }, data: { current: 0, stateVersion: { increment: 1 } } });
      await recomputeActorDerivedSnapshot(transaction, lyra.id);
    });
    await expect(encounterService.create({
      ...seedScope, encounterRef: 'phase-1m-a-zero-hp-entry', idempotencyKey: 'phase-1m-a-zero-hp-entry-create',
      partySideRef: 'party', participants: [{ bindingKind: 'persisted_actor', actorRef: 'lyra', sideRef: 'party', zone: 'near' }],
      relations: [{ leftActorRef: 'lyra', rightActorRef: 'lyra', relation: 'self' }],
    })).rejects.toMatchObject({ code: 'ENCOUNTER_PARTICIPANT_INVALID' });
    await prisma.$transaction(async (transaction) => {
      await transaction.actorResource.update({ where: { id: hp.id }, data: { current: hp.current, stateVersion: { increment: 1 } } });
      await recomputeActorDerivedSnapshot(transaction, lyra.id);
    });
  });

  it('uses distinct global event keys for the same encounterRef in two Campaigns', async () => {
    const first = await createEncounterFixture('same-public-ref-a', EncounterLifecycleStatus.FAILED);
    const second = await createEncounterFixture('same-public-ref-b', EncounterLifecycleStatus.FAILED);
    const encounterRef = 'shared-encounter-ref';
    const createIn = (fixture: typeof first, suffix: string) => encounterService.create({
      playerRef: fixture.player.slug, worldRef: fixture.world.code, campaignRef: fixture.campaign.code,
      encounterRef, idempotencyKey: `phase-1m-a-shared-create-${suffix}`, partySideRef: 'party',
      participants: [{ bindingKind: 'persisted_actor' as const, actorRef: fixture.actor.code, sideRef: 'party', zone: 'near' as const }],
      relations: [{ leftActorRef: fixture.actor.code, rightActorRef: fixture.actor.code, relation: 'self' as const }],
    });
    const firstCreated = await createIn(first, 'a');
    const secondCreated = await createIn(second, 'b');
    await encounterService.cancel({
      playerRef: first.player.slug, worldRef: first.world.code, campaignRef: first.campaign.code,
      encounterRef, idempotencyKey: 'phase-1m-a-shared-cancel-a', expectedStateVersion: firstCreated.stateVersion,
    });
    await encounterService.cancel({
      playerRef: second.player.slug, worldRef: second.world.code, campaignRef: second.campaign.code,
      encounterRef, idempotencyKey: 'phase-1m-a-shared-cancel-b', expectedStateVersion: secondCreated.stateVersion,
    });
    const encounters = await prisma.encounter.findMany({
      where: { encounterRef, campaignId: { in: [first.campaign.id, second.campaign.id] } },
      include: { consequence: { include: { gameEvent: true } } }, orderBy: { campaignId: 'asc' },
    });
    expect(encounters).toHaveLength(2);
    const keys = encounters.map((entry) => entry.consequence?.gameEvent.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
    expect(keys).toEqual(encounters.map((entry) => `encounter-outcome:${entry.id}:v1`));
  });

  it('serializes confirmation versus cancellation from the same completion candidate', async () => {
    const encounterRef = 'phase-1m-a-confirm-cancel-race';
    await encounterService.create({
      ...seedScope, encounterRef, idempotencyKey: 'phase-1m-a-confirm-cancel-create', partySideRef: 'party',
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
    const encounter = await prisma.encounter.findFirstOrThrow({
      where: { encounterRef }, include: { operations: { orderBy: { nextStateVersion: 'desc' }, take: 1 } },
    });
    const candidate = {
      ...parseCoreV1EncounterSnapshot(encounter.stateSnapshot),
      stateVersion: encounter.stateVersion + 1,
      completionCandidate: 'stalemate_candidate' as const,
    };
    const snapshot = serializeCoreV1EncounterState(candidate);
    const stateHash = createCoreV1EncounterSnapshotHash(snapshot);
    const idempotency = await prisma.idempotencyRecord.create({
      data: { key: 'phase-1m-a-confirm-cancel-preparation', operation: 'encounter.continue', requestHash: 'd'.repeat(64) },
    });
    await prisma.$transaction(async (transaction) => {
      await transaction.encounter.update({
        where: { id: encounter.id },
        data: {
          lifecycleStatus: EncounterLifecycleStatus.COMPLETION_PENDING,
          stateVersion: candidate.stateVersion,
          completionCandidate: 'STALEMATE_CANDIDATE', stateSnapshot: snapshot, stateHash,
        },
      });
      await transaction.encounterOperation.create({
        data: {
          encounterId: encounter.id, idempotencyRecordId: idempotency.id,
          operation: EncounterOperationKind.CONTINUE,
          previousStateVersion: encounter.stateVersion, nextStateVersion: candidate.stateVersion,
          inputHash: 'd'.repeat(64), beforeStateHash: encounter.stateHash, afterStateHash: stateHash,
          stopReason: encounter.stopReason,
          resultSummary: encounter.operations[0]!.resultSummary as Prisma.InputJsonValue,
        },
      });
    });
    const attempts = await Promise.allSettled([
      encounterService.confirmCompletion({
        ...seedScope, encounterRef, idempotencyKey: 'phase-1m-a-confirm-race',
        expectedStateVersion: candidate.stateVersion,
      }),
      encounterService.cancel({
        ...seedScope, encounterRef, idempotencyKey: 'phase-1m-a-cancel-race',
        expectedStateVersion: candidate.stateVersion,
      }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    await expect(prisma.encounterConsequence.count({ where: { encounterId: encounter.id } })).resolves.toBe(1);
    await expect(prisma.gameEvent.count({ where: { idempotencyKey: `encounter-outcome:${encounter.id}:v1` } })).resolves.toBe(1);
    await expect(prisma.encounterOperation.count({
      where: { encounterId: encounter.id, operation: { in: [EncounterOperationKind.CONFIRM_COMPLETION, EncounterOperationKind.CANCEL] } },
    })).resolves.toBe(1);
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

describe('Phase 1L-C encounter HTTP integration', () => {
  it('serves the active 21-operation OpenAPI with the runtime base URL', () => {
    const document: Record<string, unknown> = {
      ...getOfficialContract(),
      servers: [{ url: config.PUBLIC_BASE_URL ?? `http://localhost:${config.PORT}` }],
    };
    expect(document).toMatchObject({
      servers: [{ url: config.PUBLIC_BASE_URL ?? `http://localhost:${config.PORT}` }],
      paths: { '/api/v1/encounters/manage': { post: { operationId: 'manageEncounter' } } },
    });
    const paths = bodyRecord({ body: document.paths });
    const operationIds = Object.values(paths).flatMap((path) => Object.values(bodyRecord({ body: path })))
      .flatMap((operationValue) => {
        const operation = bodyRecord({ body: operationValue });
        return typeof operation.operationId === 'string' ? [operation.operationId] : [];
      });
    expect(operationIds).toHaveLength(21);
    expect(new Set(operationIds).size).toBe(21);
  });

  it('creates, replays, loads, rejects stale versions and cancels through the real transactional adapter', async () => {
    const encounterRef = 'phase-1l-c-http';
    const createBody = {
      operation: 'create', encounterRef, idempotencyKey: 'phase-1l-c-create-001', partySideRef: 'party',
      participants: [
        { actorRef: 'ralph', sideRef: 'party', zone: 'near' },
        { actorRef: 'lyra', sideRef: 'hostile', zone: 'medium' },
      ],
    };
    const created = await post('/api/v1/encounters/manage', createBody);
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      result: 'encounter_created', encounterRef, lifecycleStatus: 'processing_paused',
      nextRequiredAction: { type: 'continue' },
    });
    const createdBody = bodyRecord(created);
    const createdStateVersion = createdBody.stateVersion;
    if (typeof createdStateVersion !== 'number') throw new Error('Encounter stateVersion must be numeric');
    expect(JSON.stringify(created.body)).not.toMatch(/stateHash|snapshot|adapterState|rolls|eventRef|actionRef|"id"/);

    const campaignWithEncounter = await post('/api/v1/game/load', {});
    expect(campaignWithEncounter.status).toBe(200);
    expect(campaignWithEncounter.body).toMatchObject({
      activeEncounter: {
        encounterRef,
        lifecycleStatus: 'processing_paused',
        stateVersion: createdStateVersion,
        canContinue: true,
        canCancel: true,
        recoveryAction: 'load_encounter',
      },
    });
    const activeEncounter = bodyRecord({ body: bodyRecord(campaignWithEncounter).activeEncounter });
    expect(activeEncounter).not.toHaveProperty('id');
    expect(activeEncounter).not.toHaveProperty('encounterId');
    const recoveredEncounterRef = activeEncounter.encounterRef;
    if (typeof recoveredEncounterRef !== 'string') throw new Error('loadGame must return the active encounter ref');
    const recovered = await post('/api/v1/encounters/manage', { operation: 'load', encounterRef: recoveredEncounterRef });
    expect(recovered.status).toBe(200);
    expect(recovered.body).toMatchObject({ result: 'encounter_loaded', encounterRef, stateVersion: createdStateVersion });
    const recoveredParticipants = bodyRecord(recovered).participants;
    if (!Array.isArray(recoveredParticipants)) throw new Error('Recovered encounter must return participants');
    expect(recoveredParticipants).toEqual(expect.arrayContaining([
        expect.objectContaining({ actorRef: 'ralph' }),
        expect.objectContaining({ actorRef: 'lyra' }),
    ]));

    const replay = await post('/api/v1/encounters/manage', createBody);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(created.body);
    await expect(prisma.encounterOperation.count({ where: { encounter: { encounterRef } } })).resolves.toBe(1);
    await expect(prisma.encounterRoll.count({ where: { encounterOperation: { encounter: { encounterRef } } } })).resolves.toBe(2);

    const reused = await post('/api/v1/encounters/manage', {
      ...createBody, partySideRef: 'hostile',
    });
    expect(reused.status).toBe(409);
    expect(reused.body).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REUSED', retryable: false, recoveryAction: 'use_new_idempotency_key' } });

    const loaded = await post('/api/v1/encounters/manage', { operation: 'load', encounterRef });
    expect(loaded.status).toBe(200);
    expect(loaded.body).toMatchObject({ result: 'encounter_loaded', stateVersion: createdStateVersion });
    expect((await post('/api/v1/encounters/manage', { operation: 'load', encounterRef, idempotencyKey: 'forbidden-load-key' })).status).toBe(400);

    const advanceRequest = {
      operation: 'continue', encounterRef, idempotencyKey: 'phase-1l-c-continue-001',
      expectedStateVersion: createdStateVersion,
    } as const;
    const advanced = await post('/api/v1/encounters/manage', advanceRequest);
    expect(advanced.status).toBe(200);
    expect(advanced.body).toMatchObject({
      result: 'new_intent_required', lifecycleStatus: 'awaiting_intent',
      nextRequiredAction: { type: 'submit_intent' },
    });
    const advancedBody = bodyRecord(advanced);
    const advancedStateVersion = advancedBody.stateVersion;
    if (typeof advancedStateVersion !== 'number') throw new Error('Advanced encounter stateVersion must be numeric');
    const countsAfterAdvance = {
      operations: await prisma.encounterOperation.count({ where: { encounter: { encounterRef } } }),
      rolls: await prisma.encounterRoll.count({ where: { encounterOperation: { encounter: { encounterRef } } } }),
    };
    expect(countsAfterAdvance.operations).toBe(2);

    const advancedReplay = await post('/api/v1/encounters/manage', advanceRequest);
    expect(advancedReplay.status).toBe(200);
    expect(advancedReplay.body).toEqual(advanced.body);
    await expect(prisma.encounterOperation.count({ where: { encounter: { encounterRef } } }))
      .resolves.toBe(countsAfterAdvance.operations);
    await expect(prisma.encounterRoll.count({ where: { encounterOperation: { encounter: { encounterRef } } } }))
      .resolves.toBe(countsAfterAdvance.rolls);

    const historicalReplay = await post('/api/v1/encounters/manage', createBody);
    expect(historicalReplay.status).toBe(200);
    expect(historicalReplay.body).toEqual(created.body);
    await expect(prisma.encounterOperation.count({ where: { encounter: { encounterRef } } }))
      .resolves.toBe(countsAfterAdvance.operations);
    await expect(prisma.encounterRoll.count({ where: { encounterOperation: { encounter: { encounterRef } } } }))
      .resolves.toBe(countsAfterAdvance.rolls);

    const stale = await post('/api/v1/encounters/manage', {
      operation: 'cancel', encounterRef, idempotencyKey: 'phase-1l-c-stale-001',
      expectedStateVersion: createdStateVersion,
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: { code: 'STATE_VERSION_CONFLICT', retryable: false, recoveryAction: 'load_encounter' } });
    expect(bodyRecord({ body: bodyRecord(stale).error })).not.toHaveProperty('currentStateVersion');

    const wrongScope = await post('/api/v1/encounters/manage', {
      operation: 'load', campaignRef: 'missing-campaign', encounterRef,
    });
    expect(wrongScope.status).toBe(404);
    expect(wrongScope.body).toMatchObject({ error: { code: 'SCOPE_NOT_FOUND', retryable: false } });

    const seededCampaign = await prisma.campaign.findFirstOrThrow({
      where: { code: seedScope.campaignRef, world: { code: seedScope.worldRef, player: { slug: seedScope.playerRef } } },
    });
    const alternateCampaign = await prisma.campaign.create({
      data: {
        worldId: seededCampaign.worldId,
        rulesetVersionId: seededCampaign.rulesetVersionId,
        code: 'phase-1l-c-isolated-campaign',
        name: 'Phase 1L-C Isolated Campaign',
        status: CampaignStatus.ACTIVE,
      },
    });
    const alternateCampaignLoad = await post('/api/v1/game/load', { campaignRef: alternateCampaign.code });
    expect(alternateCampaignLoad.status).toBe(200);
    expect(alternateCampaignLoad.body).toMatchObject({
      campaign: { ref: alternateCampaign.code }, activeEncounter: null,
    });
    const alternateActor = await createMechanicalActor({
      campaignId: alternateCampaign.id,
      code: 'phase-1l-c-isolated-actor',
      name: 'Phase 1L-C Isolated Actor',
      actorType: ActorType.CHARACTER,
    });
    const starterEntry = await prisma.inventoryEntry.findFirstOrThrow({
      where: { actor: { code: 'ralph', campaignId: seededCampaign.id }, entryRef: 'starter-dagger-1' },
    });
    const otherInventoryActor = await createMechanicalActor({
      campaignId: seededCampaign.id,
      code: 'phase-1l-c-inventory-owner',
      name: 'Phase 1L-C Inventory Owner',
      actorType: ActorType.CHARACTER,
    });
    const alternateEntry = await prisma.inventoryEntry.create({
      data: {
        actorId: otherInventoryActor.id,
        entryRef: 'phase-1l-c-isolated-entry',
        contentVersionId: starterEntry.contentVersionId,
        inventoryRulesVersionId: starterEntry.inventoryRulesVersionId,
        entryKind: starterEntry.entryKind,
        quantity: 1,
        instanceLifecycle: starterEntry.instanceLifecycle,
      },
    });
    const isolated = await post('/api/v1/encounters/manage', {
      operation: 'load', campaignRef: alternateCampaign.code, encounterRef,
    });
    expect(isolated.status).toBe(404);
    expect(isolated.body).toMatchObject({ error: { code: 'ENCOUNTER_NOT_FOUND', retryable: false } });

    const intent = (actorRef: string, inventoryEntryRef: string, idempotencyKey: string) => ({
      operation: 'submit_intent', encounterRef, idempotencyKey, expectedStateVersion: advancedStateVersion,
      intent: {
        actorRef, slotRef: 'primary', actionSource: 'basic_weapon_attack', targetSelector: 'explicit',
        targetRefs: ['lyra'], inventoryEntryRef,
      },
    });
    const crossActor = await post('/api/v1/encounters/manage', intent(
      alternateActor.code, alternateEntry.entryRef, 'phase-1l-c-cross-actor-001',
    ));
    const missingActor = await post('/api/v1/encounters/manage', intent(
      'phase-1l-c-missing-actor', alternateEntry.entryRef, 'phase-1l-c-missing-actor-001',
    ));
    expect(crossActor.status).toBe(422);
    expect(crossActor.body).toEqual(missingActor.body);

    const crossInventory = await post('/api/v1/encounters/manage', intent(
      'ralph', alternateEntry.entryRef, 'phase-1l-c-cross-inventory-001',
    ));
    const missingInventory = await post('/api/v1/encounters/manage', intent(
      'ralph', 'phase-1l-c-missing-entry', 'phase-1l-c-missing-inventory-001',
    ));
    expect(crossInventory.status).toBe(422);
    expect(crossInventory.body).toEqual(missingInventory.body);

    const contentIntent = (code: string, idempotencyKey: string) => ({
      operation: 'submit_intent', encounterRef, idempotencyKey, expectedStateVersion: advancedStateVersion,
      intent: {
        actorRef: 'ralph', slotRef: 'primary', actionSource: 'content', targetSelector: 'self',
        contentRef: { scope: 'world', contentType: 'spell', code, versionNumber: 1 },
      },
    });
    const crossContentScope = await post('/api/v1/encounters/manage', contentIntent(
      'seed-mark-spell', 'phase-1l-c-cross-content-scope-001',
    ));
    const missingContent = await post('/api/v1/encounters/manage', contentIntent(
      'phase-1l-c-missing-content', 'phase-1l-c-missing-content-001',
    ));
    expect(crossContentScope.status).toBe(422);
    expect(crossContentScope.body).toEqual(missingContent.body);

    const cancelled = await post('/api/v1/encounters/manage', {
      operation: 'cancel', encounterRef, idempotencyKey: 'phase-1l-c-cancel-001',
      expectedStateVersion: advancedStateVersion,
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({
      result: 'encounter_cancelled', lifecycleStatus: 'cancelled', nextRequiredAction: { type: 'none' },
      consequencesSummary: {
        schemaVersion: 1, outcome: 'cancelled', actorChanges: [], removedEncounterEffects: [],
        persistentEvent: { eventType: 'encounter-cancelled', actorRef: 'ralph' },
      },
    });
    const cancelledReplay = await post('/api/v1/encounters/manage', {
      operation: 'cancel', encounterRef, idempotencyKey: 'phase-1l-c-cancel-001',
      expectedStateVersion: advancedStateVersion,
    });
    expect(cancelledReplay.body).toEqual(cancelled.body);

    const crossCampaignParticipant = await post('/api/v1/encounters/manage', {
      operation: 'create', encounterRef: 'phase-1l-c-cross-participant',
      idempotencyKey: 'phase-1l-c-cross-participant-001',
      participants: [{ actorRef: alternateActor.code, sideRef: 'party', zone: 'near' }],
    });
    expect(crossCampaignParticipant.status).toBe(422);
    expect(crossCampaignParticipant.body).toMatchObject({ error: { code: 'PARTICIPANT_INVALID', retryable: false } });
    await prisma.actor.delete({ where: { id: otherInventoryActor.id } });
    await prisma.actor.delete({ where: { id: alternateActor.id } });
    await prisma.campaign.delete({ where: { id: alternateCampaign.id } });
    const campaignAfterCancel = await post('/api/v1/game/load', {});
    expect(campaignAfterCancel.status).toBe(200);
    expect(campaignAfterCancel.body).toMatchObject({ activeEncounter: null });
  });

  it('continues four initial actor_ready events atomically without loss or duplication', async () => {
    const campaign = await prisma.campaign.findFirstOrThrow({
      where: {
        code: seedScope.campaignRef,
        world: { code: seedScope.worldRef, player: { slug: seedScope.playerRef } },
      },
    });
    const ally = await createMechanicalActor({
      campaignId: campaign.id,
      code: 'phase-1l-c-ready-ally',
      name: 'Ready Ally',
      actorType: ActorType.NPC,
    });
    const hunter = await createMechanicalActor({
      campaignId: campaign.id,
      code: 'phase-1l-c-ready-hunter',
      name: 'Ready Hunter',
      actorType: ActorType.CREATURE,
    });
    const encounterRef = 'phase-1l-c-four-ready';
    const created = await post('/api/v1/encounters/manage', {
      operation: 'create', encounterRef, idempotencyKey: 'phase-1l-c-four-ready-create',
      partySideRef: 'party',
      participants: [
        { actorRef: 'ralph', sideRef: 'party', zone: 'near' },
        { actorRef: ally.code, sideRef: 'party', zone: 'near' },
        { actorRef: 'lyra', sideRef: 'hostile', zone: 'medium' },
        { actorRef: hunter.code, sideRef: 'hostile', zone: 'medium' },
      ],
    });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      lifecycleStatus: 'processing_paused', stateVersion: 1, nextRequiredAction: { type: 'continue' },
    });
    const persistedBefore = await prisma.encounter.findUniqueOrThrow({
      where: { campaignId_encounterRef: { campaignId: campaign.id, encounterRef } },
    });
    const stateBefore = parseCoreV1EncounterSnapshot(persistedBefore.stateSnapshot);
    expect(stateBefore.scheduledEvents).toHaveLength(4);
    expect(stateBefore.scheduledEvents.map((event) => event.type)).toEqual([
      'actor_ready', 'actor_ready', 'actor_ready', 'actor_ready',
    ]);
    const expectedTick = stateBefore.scheduledEvents.at(-1)?.timelineEvent.tick;
    if (expectedTick === undefined) throw new Error('Four-ready fixture requires a final scheduled tick');
    const continueRequest = {
      operation: 'continue', encounterRef, idempotencyKey: 'phase-1l-c-four-ready-continue',
      expectedStateVersion: 1,
    } as const;

    const continued = await post('/api/v1/encounters/manage', continueRequest);

    expect(continued.status).toBe(200);
    expect(continued.body).toMatchObject({
      result: 'new_intent_required', lifecycleStatus: 'awaiting_intent', stateVersion: 5,
      currentTick: expectedTick.toString(),
      nextRequiredAction: { type: 'submit_intent' },
      transitionSummary: { processedEventCount: 4 },
    });
    const continuedBody = bodyRecord(continued);
    const participants = continuedBody.participants;
    if (!Array.isArray(participants)) throw new Error('Four-ready response must contain participants');
    expect(participants.map((entry) => bodyRecord({ body: entry }).actorRef).sort()).toEqual([
      ally.code, hunter.code, 'lyra', 'ralph',
    ].sort());
    const transition = bodyRecord({ body: continuedBody.transitionSummary });
    const transitionEvents = transition.events;
    if (!Array.isArray(transitionEvents)) throw new Error('Four-ready response must contain transition events');
    expect(transitionEvents).toHaveLength(4);
    expect(transitionEvents.map((event) => bodyRecord({ body: event }).category))
      .toEqual(['participant_state_changed', 'participant_state_changed', 'participant_state_changed', 'participant_state_changed']);
    expect(JSON.stringify(continued.body)).not.toMatch(/stateHash|stateSnapshot|adapterState|eventRef|actionRef|[0-9a-f]{8}-[0-9a-f]{4}/i);

    const persistedAfter = await prisma.encounter.findUniqueOrThrow({
      where: { campaignId_encounterRef: { campaignId: campaign.id, encounterRef } },
      include: { operations: { orderBy: { createdAt: 'asc' } } },
    });
    expect(persistedAfter).toMatchObject({
      lifecycleStatus: EncounterLifecycleStatus.AWAITING_INTENT,
      stateVersion: 5,
      currentTick: expectedTick,
    });
    expect(persistedAfter.operations.map((operation) => operation.operation)).toEqual([
      EncounterOperationKind.CREATE, EncounterOperationKind.CONTINUE,
    ]);
    expect(parseCoreV1EncounterSnapshot(persistedAfter.stateSnapshot).scheduledEvents).toEqual([]);
    await expect(prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } }))
      .resolves.toMatchObject({ engineTick: expectedTick });

    const replay = await post('/api/v1/encounters/manage', continueRequest);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(continued.body);
    await expect(prisma.encounterOperation.count({ where: { encounterId: persistedAfter.id } })).resolves.toBe(2);

    const stale = await post('/api/v1/encounters/manage', {
      operation: 'continue', encounterRef, idempotencyKey: 'phase-1l-c-four-ready-stale', expectedStateVersion: 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: { code: 'STATE_VERSION_CONFLICT', recoveryAction: 'load_encounter' } });
    const incompatible = await post('/api/v1/encounters/manage', {
      operation: 'continue', encounterRef, idempotencyKey: 'phase-1l-c-four-ready-incompatible', expectedStateVersion: 5,
    });
    expect(incompatible.status).toBe(409);
    expect(incompatible.body).toMatchObject({ error: { code: 'ENCOUNTER_LIFECYCLE_CONFLICT' } });
    await expect(prisma.idempotencyRecord.count({ where: {
      key: { in: ['encounter:phase-1l-c-four-ready-stale', 'encounter:phase-1l-c-four-ready-incompatible'] },
    } })).resolves.toBe(0);

    const cancelled = await post('/api/v1/encounters/manage', {
      operation: 'cancel', encounterRef, idempotencyKey: 'phase-1l-c-four-ready-cancel', expectedStateVersion: 5,
    });
    expect(cancelled.status).toBe(200);
  });

  it('loads a coherent legacy terminal Encounter without inventing a consequence summary', async () => {
    const encounterRef = 'phase-1m-a-legacy-terminal-http';
    await encounterService.create({
      ...seedScope, encounterRef, idempotencyKey: 'phase-1m-a-legacy-terminal-create', partySideRef: 'party',
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
    const encounter = await prisma.encounter.findFirstOrThrow({
      where: { encounterRef }, include: { operations: { orderBy: { nextStateVersion: 'desc' }, take: 1 } },
    });
    const cancelled = cancelCoreV1Encounter(parseCoreV1EncounterSnapshot(encounter.stateSnapshot));
    if (!cancelled.ok) throw new Error('Legacy terminal fixture cancellation failed');
    const snapshot = serializeCoreV1EncounterState(cancelled.value);
    const stateHash = createCoreV1EncounterSnapshotHash(snapshot);
    const idempotency = await prisma.idempotencyRecord.create({
      data: { key: 'phase-1m-a-legacy-terminal-operation', operation: 'encounter.cancel', requestHash: 'c'.repeat(64) },
    });
    await prisma.$executeRawUnsafe('ALTER TABLE "Encounter" DISABLE TRIGGER "Encounter_terminal_requires_consequence"');
    try {
      await prisma.$transaction(async (transaction) => {
        await transaction.encounter.update({
          where: { id: encounter.id },
          data: {
            lifecycleStatus: EncounterLifecycleStatus.CANCELLED,
            stateVersion: cancelled.value.stateVersion,
            completionCandidate: 'CANCELLED', stateSnapshot: snapshot, stateHash, closedAt: new Date(),
          },
        });
        await transaction.encounterOperation.create({
          data: {
            encounterId: encounter.id, idempotencyRecordId: idempotency.id,
            operation: EncounterOperationKind.CANCEL,
            previousStateVersion: encounter.stateVersion, nextStateVersion: cancelled.value.stateVersion,
            inputHash: 'c'.repeat(64), beforeStateHash: encounter.stateHash, afterStateHash: stateHash,
            resultSummary: encounter.operations[0]!.resultSummary as Prisma.InputJsonValue,
          },
        });
      });
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "Encounter" ENABLE TRIGGER "Encounter_terminal_requires_consequence"');
    }
    const loaded = await post('/api/v1/encounters/manage', { operation: 'load', encounterRef });
    expect(loaded.status).toBe(200);
    expect(loaded.body).toMatchObject({
      result: 'encounter_cancelled', lifecycleStatus: 'cancelled', nextRequiredAction: { type: 'none' },
    });
    expect(bodyRecord(loaded)).not.toHaveProperty('consequencesSummary');
    await expect(prisma.encounterConsequence.count({ where: { encounterId: encounter.id } })).resolves.toBe(0);
    await expect(prisma.encounter.update({
      where: { id: encounter.id }, data: { updatedAt: new Date() },
    })).resolves.toMatchObject({ lifecycleStatus: EncounterLifecycleStatus.CANCELLED });
    await expect(prisma.encounter.update({
      where: { id: encounter.id },
      data: { lifecycleStatus: EncounterLifecycleStatus.COMPLETED, completionCandidate: 'PARTY_VICTORY_CANDIDATE' },
    })).rejects.toThrow(/Terminal Encounter authority is immutable/);
  });

  it('rolls back the entire terminal write when consequence persistence fails, then retries safely', async () => {
    const encounterRef = 'phase-1m-a-terminal-rollback';
    const created = await encounterService.create({
      ...seedScope, encounterRef, idempotencyKey: 'phase-1m-a-terminal-rollback-create', partySideRef: 'party',
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
    const encounter = await prisma.encounter.findFirstOrThrow({ where: { encounterRef } });
    const terminalKey = 'phase-1m-a-terminal-rollback-cancel';
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION phase1ma_test_reject_consequence() RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Encounter consequence terminal rollback injection';
      END
      $function$;
      CREATE TRIGGER phase1ma_test_reject_consequence
        BEFORE INSERT ON "EncounterConsequence"
        FOR EACH ROW EXECUTE FUNCTION phase1ma_test_reject_consequence();
    `);
    try {
      await expect(encounterService.cancel({
        ...seedScope, encounterRef, idempotencyKey: terminalKey, expectedStateVersion: created.stateVersion,
      })).rejects.toMatchObject({ code: 'ENCOUNTER_DENORMALIZED_DRIFT' });
    } finally {
      await prisma.$executeRawUnsafe(`
        DROP TRIGGER IF EXISTS phase1ma_test_reject_consequence ON "EncounterConsequence";
        DROP FUNCTION IF EXISTS phase1ma_test_reject_consequence();
      `);
    }
    await expect(prisma.encounter.findUniqueOrThrow({ where: { id: encounter.id } }))
      .resolves.toMatchObject({ lifecycleStatus: encounter.lifecycleStatus, stateVersion: encounter.stateVersion, closedAt: null });
    await expect(prisma.encounterConsequence.count({ where: { encounterId: encounter.id } })).resolves.toBe(0);
    await expect(prisma.gameEvent.count({ where: { idempotencyKey: `encounter-outcome:${encounter.id}:v1` } })).resolves.toBe(0);
    await expect(prisma.encounterOperation.count({
      where: { encounterId: encounter.id, operation: EncounterOperationKind.CANCEL },
    })).resolves.toBe(0);
    await expect(prisma.idempotencyRecord.count({ where: { key: `encounter:${terminalKey}` } })).resolves.toBe(0);
    const retried = await encounterService.cancel({
      ...seedScope, encounterRef, idempotencyKey: terminalKey, expectedStateVersion: created.stateVersion,
    });
    expect(retried.consequencesSummary?.outcome).toBe('cancelled');
    await expect(prisma.encounterConsequence.count({ where: { encounterId: encounter.id } })).resolves.toBe(1);
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
    const response = await api.get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('reports database readiness without leaking connection details', async () => {
    const response = await api.get('/health/ready');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ready' });
    expect(JSON.stringify(response.body)).not.toMatch(/postgres|Prisma|game_gpt_test/i);
  });

  it('enforces authentication without exposing the configured key', async () => {
    const absent = await api.get('/api/v1/characters/ralph');
    const wrong = await api.get('/api/v1/characters/ralph').set('x-rpg-key', 'wrong-key');
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
  const patch = (path: string, body: object) => api.patch(path).set('x-rpg-key', config.RPG_API_KEY).send({ ...seedScope, ...body });

  it('does not infer the only persisted save when scope refs are absent', async () => {
    const response = await api.post('/api/v1/game/load').set('x-rpg-key', config.RPG_API_KEY).send({});
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
      activeEncounter: null,
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
        mechanicsStateVersion: 3, ruleset: { code: 'core-v1.2', revision: 'RC1.2' },
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
    expect(persistedWorld.defaultRulesetVersion).toEqual({
      code: 'core-v1.2', revision: 'RC1.2', configHash: CORE_V1_2_CONFIG_HASH,
    });
    expect(persistedCampaign.rulesetVersionId).toBe(persistedWorld.defaultRulesetVersionId);
    expect(persistedCampaign.rulesetVersion).toEqual(persistedWorld.defaultRulesetVersion);
    await expect(prisma.rulesetVersion.count({ where: { code: 'core-v1' } })).resolves.toBe(1);
    await expect(prisma.rulesetVersion.count({ where: { code: 'core-v1.2' } })).resolves.toBe(1);
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

  it('keeps full startGame and loadGame within a coarse SQL round-trip budget', async () => {
    const template = structuredStart('query-budget');
    const narrativePackages = (['location', 'faction', 'quest_template', 'recipe', 'other'] as const).map((contentType) => ({
      definition: {
        mode: 'create' as const, scope: 'world' as const, contentType,
        code: `query-budget-${contentType.replace('_', '-')}`,
        name: `Query budget ${contentType}`,
        description: 'Narrative content used only by the integration query budget.',
        profile: null, presentation: {}, tags: ['query-budget'], status: 'active' as const, metadata: {},
      },
      protagonistLink: { state: 'known' as const, rank: 0, progress: 0, mastery: 0, metadata: {} },
    }));
    const input = startGameSchema.parse({
      ...template,
      initialContentPackages: [...template.initialContentPackages, ...narrativePackages],
    });
    const startContext = createOperationTelemetryContext();
    await runWithOperationTelemetry(startContext, () => observeOperation('startGame', () => prismaGptRepository.startGame(input)));
    const startMetrics = operationTelemetrySnapshot(startContext);
    expect(startMetrics).toMatchObject({ outcome: 'commit', timeout: false });
    expect(startMetrics?.queryCount).toBeLessThanOrEqual(350);

    const scope = loadGameSchema.parse({
      playerRef: input.playerRef, worldRef: input.worldRef, campaignRef: input.campaignRef,
    });
    const loadContext = createOperationTelemetryContext();
    await runWithOperationTelemetry(loadContext, () => observeOperation('loadGame', () => prismaGptRepository.loadGame(scope)));
    const loadMetrics = operationTelemetrySnapshot(loadContext);
    expect(loadMetrics).toMatchObject({ outcome: 'commit', timeout: false });
    expect(loadMetrics?.queryCount).toBeLessThanOrEqual(50);
  });

  it('carries a valid starter package through readiness, load and the first resolved beat', async () => {
    const template = structuredStart('readiness-vertical-valid');
    const cosmetic = {
      definition: {
        mode: 'create', scope: 'world', contentType: 'clothing', code: 'travel-cloak', name: 'Manto de Viagem',
        description: 'Cosmético narrativo sem autoridade mecânica.',
        profile: canonicalProfile('clothing', 'travel-cloak', 'Manto de Viagem'),
        inventorySpec: uniqueInventorySpec(1),
        presentation: {}, tags: ['cosmetic'], status: 'active', metadata: {},
      },
      protagonistLink: { state: 'known', rank: 0, progress: 0, mastery: 0, metadata: {} },
    };
    const body = { ...template, initialContentPackages: [...template.initialContentPackages, cosmetic] };
    const started = await post('/api/v1/game/start', body);
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body).toMatchObject({
      protagonist: {
        readiness: {
          status: 'ready', canStartEncounter: true, blockingReasons: [], narrativeContentCount: 1,
          usableActions: [{ source: 'equipped_weapon', ref: 'longbow-1', action: 'attack' }],
        },
      },
    });

    const scope = { playerRef: body.playerRef, worldRef: body.worldRef, campaignRef: body.campaignRef };
    const loaded = await post('/api/v1/game/load', scope);
    expect(loaded.status).toBe(200);
    const startedProtagonist = bodyRecord({ body: bodyRecord(started).protagonist });
    expect(loaded.body).toMatchObject({ protagonist: { readiness: startedProtagonist.readiness } });

    const enemyRef = 'readiness-vertical-valid-enemy';
    const enemy = await post('/api/v1/actors/upsert', {
      ...scope, idempotencyKey: 'readiness-vertical-valid-enemy-upsert', code: enemyRef,
      name: 'Sentinela de Treino', actorType: 'creature', level: 1, primaryAttributes: balancedPrimaryAttributes,
    });
    expect(enemy.status).toBe(200);
    const encounterRef = 'readiness-vertical-valid-encounter';
    const created = await post('/api/v1/encounters/manage', {
      ...scope, operation: 'create', encounterRef, idempotencyKey: 'readiness-vertical-valid-create', partySideRef: 'party',
      participants: [
        { actorRef: body.playerRef, sideRef: 'party', zone: 'near' },
        { actorRef: enemyRef, sideRef: 'hostile', zone: 'near' },
      ],
    });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ operation: 'create', result: 'encounter_created' });
    const createdStateVersion = bodyRecord(created).stateVersion;
    if (typeof createdStateVersion !== 'number') throw new Error('Vertical encounter stateVersion must be numeric');
    let cleanupStateVersion = createdStateVersion;
    try {
      const resolved = await post('/api/v1/encounters/manage', {
        ...scope, operation: 'resolve_beat', encounterRef, idempotencyKey: 'readiness-vertical-valid-resolve',
        expectedStateVersion: createdStateVersion,
        intent: {
          actorRef: body.playerRef, objective: 'test_the_starter_weapon', narrative: 'O herói testa seu arco contra a sentinela.',
          resolutionPolicy: 'atomic',
          components: [{ type: 'attack', inventoryEntryRef: 'longbow-1', targetRefs: [enemyRef] }],
        },
        npcDirectives: [{ actorRef: enemyRef, strategy: 'defensive' }],
      });
      expect(resolved.status).toBe(200);
      expect(resolved.body).toMatchObject({
        operation: 'resolve_beat', result: 'beat_resolved',
        beatSummary: { componentResults: [{ index: 0, type: 'attack', status: 'accepted' }] },
      });
      const resolvedStateVersion = bodyRecord(resolved).stateVersion;
      if (typeof resolvedStateVersion !== 'number') throw new Error('Resolved vertical stateVersion must be numeric');
      cleanupStateVersion = resolvedStateVersion;
    } finally {
      const cancelled = await post('/api/v1/encounters/manage', {
        ...scope, operation: 'cancel', encounterRef, idempotencyKey: 'readiness-vertical-valid-cleanup',
        expectedStateVersion: cleanupStateVersion,
      });
      expect(cancelled.status).toBe(200);
    }
  });

  it('blocks encounter creation when the protagonist has only narrative cosmetics', async () => {
    const template = structuredStart('readiness-vertical-narrative');
    const cosmetic = {
      definition: {
        mode: 'create', scope: 'world', contentType: 'clothing', code: 'ceremonial-scarf', name: 'Faixa Cerimonial',
        description: 'Cosmético narrativo.', profile: canonicalProfile('clothing', 'ceremonial-scarf', 'Faixa Cerimonial'),
        inventorySpec: uniqueInventorySpec(1),
        presentation: {}, tags: ['cosmetic'], status: 'active', metadata: {},
      },
      protagonistLink: { state: 'known', rank: 0, progress: 0, mastery: 0, metadata: {} },
    };
    const body = { ...template, initialContentPackages: [cosmetic], initialInventory: [] };
    const started = await post('/api/v1/game/start', body);
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body).toMatchObject({
      protagonist: { readiness: {
        status: 'narrative_only', canStartEncounter: false,
        blockingReasons: ['no_usable_starter_action'], narrativeContentCount: 1, usableActions: [],
      } },
    });
    const scope = { playerRef: body.playerRef, worldRef: body.worldRef, campaignRef: body.campaignRef };
    const enemyRef = 'readiness-vertical-narrative-enemy';
    await post('/api/v1/actors/upsert', {
      ...scope, idempotencyKey: 'readiness-vertical-narrative-enemy-upsert', code: enemyRef,
      name: 'Oponente Narrativo', actorType: 'creature', level: 1, primaryAttributes: balancedPrimaryAttributes,
    });
    const encounterRef = 'readiness-vertical-narrative-encounter';
    const rejected = await post('/api/v1/encounters/manage', {
      ...scope, operation: 'create', encounterRef, idempotencyKey: 'readiness-vertical-narrative-create', partySideRef: 'party',
      participants: [
        { actorRef: body.playerRef, sideRef: 'party', zone: 'near' },
        { actorRef: enemyRef, sideRef: 'hostile', zone: 'near' },
      ],
    });
    expect(rejected.status).toBe(422);
    expect(rejected.body).toMatchObject({ error: {
      code: 'CHARACTER_NOT_READY', retryable: false, recoveryAction: 'complete_character_setup',
      issues: [expect.objectContaining({ code: 'NO_USABLE_STARTER_ACTION' })],
    } });
    expect(JSON.stringify(rejected.body)).not.toMatch(/actorId|campaignId|contentVersionId|stateHash/i);
    await expect(prisma.encounter.count({ where: { encounterRef } })).resolves.toBe(0);
    await expect(prisma.idempotencyRecord.count({ where: { key: 'encounter:readiness-vertical-narrative-create' } })).resolves.toBe(0);
  });

  it('uses current Mana to block a mechanically valid sole starter spell', async () => {
    const template = structuredStart('readiness-vertical-mana');
    const spellCode = 'starter-firebolt';
    const spellProfile = {
      ...activeProfile('spell', spellCode, 'Seta de Fogo'),
      cost: { type: 'mana' as const, amount: 8 },
      effects: [{
        type: 'damage' as const,
        targeting: { type: 'single_target' as const, rangeBand: 'near' as const, maxTargets: 1 },
        damageComponents: [{
          id: 'starter-firebolt-fire', channel: 'magical' as const, element: 'fire', baseDamage: 6,
          scaling: 'full' as const, canCrit: true,
        }],
      }],
    };
    const spell = {
      definition: {
        mode: 'create', scope: 'world', contentType: 'spell', code: spellCode, name: 'Seta de Fogo',
        description: 'Magia inicial válida com custo de Mana.', profile: spellProfile,
        presentation: {}, tags: ['starter'], status: 'active', metadata: {},
      },
      protagonistLink: { state: 'known', rank: 0, progress: 0, mastery: 0, metadata: {} },
    };
    const body = { ...template, initialContentPackages: [spell], initialInventory: [] };
    const started = await post('/api/v1/game/start', body);
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ protagonist: { readiness: {
      status: 'ready', canStartEncounter: true,
      usableActions: [{ source: 'known_content', ref: spellCode, action: 'cast' }],
    } } });
    const actor = await prisma.actor.findFirstOrThrow({
      where: { code: body.playerRef, campaign: { code: body.campaignRef, world: { code: body.worldRef } } },
    });
    await prisma.$transaction([
      prisma.actorResource.update({
        where: { actorId_type: { actorId: actor.id, type: ActorResourceType.MANA } },
        data: { current: 7, stateVersion: { increment: 1 } },
      }),
    ]);
    const scope = { playerRef: body.playerRef, worldRef: body.worldRef, campaignRef: body.campaignRef };
    const loaded = await post('/api/v1/game/load', scope);
    expect(loaded.status, JSON.stringify(loaded.body)).toBe(200);
    expect(loaded.body).toMatchObject({ protagonist: { readiness: {
      status: 'blocked', canStartEncounter: false, usableActions: [], incompleteContentRefs: [],
      blockingReasons: ['no_usable_starter_action', 'starter_action_resource_insufficient'],
    } } });
    const enemyRef = 'readiness-vertical-mana-enemy';
    await post('/api/v1/actors/upsert', {
      ...scope, idempotencyKey: 'readiness-vertical-mana-enemy-upsert', code: enemyRef,
      name: 'Alvo da Magia', actorType: 'creature', level: 1, primaryAttributes: balancedPrimaryAttributes,
    });
    const encounterRef = 'readiness-vertical-mana-encounter';
    const rejected = await post('/api/v1/encounters/manage', {
      ...scope, operation: 'create', encounterRef, idempotencyKey: 'readiness-vertical-mana-create', partySideRef: 'party',
      participants: [
        { actorRef: body.playerRef, sideRef: 'party', zone: 'near' },
        { actorRef: enemyRef, sideRef: 'hostile', zone: 'near' },
      ],
    });
    expect(rejected.status).toBe(422);
    const publicError = bodyRecord({ body: bodyRecord(rejected).error });
    expect(publicError).toMatchObject({
      code: 'CHARACTER_NOT_READY', retryable: false, recoveryAction: 'complete_character_setup',
    });
    expect(publicError.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'NO_USABLE_STARTER_ACTION' }),
      expect.objectContaining({ code: 'STARTER_ACTION_RESOURCE_INSUFFICIENT' }),
    ]));
    expect(JSON.stringify(rejected.body)).not.toMatch(/actorId|campaignId|contentVersionId|stateHash|current.*7/i);
    await expect(prisma.encounter.count({ where: { encounterRef } })).resolves.toBe(0);
    await expect(prisma.idempotencyRecord.count({ where: { key: 'encounter:readiness-vertical-mana-create' } })).resolves.toBe(0);
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
    await expect(prisma.actorAttribute.update({ where: { id: strength.id }, data: { earnedValue: -1 } })).rejects.toThrow();
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
    expect(stale.body).toMatchObject({ error: {
      code: 'INVENTORY_STATE_VERSION_CONFLICT', retryable: false, recoveryAction: 'load_inventory',
      issues: [expect.objectContaining({ path: 'expectedInventoryStateVersion', code: 'STATE_VERSION_CONFLICT' })],
    } });

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
    expect(equippedRemoval.body).toMatchObject({ error: {
      code: 'INVENTORY_LOADOUT_CONFLICT', retryable: false, recoveryAction: 'load_inventory',
      issues: [expect.objectContaining({ path: 'entryRef', code: 'EQUIPPED_REMOVAL' })],
    } });
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
    expect(noSpec.status).toBe(422);
    expect(noSpec.body).toMatchObject({ error: {
      code: 'INVALID_INVENTORY_OPERATION', retryable: false, recoveryAction: 'correct_request',
    } });
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
      api.post('/api/v1/game/load').set('x-rpg-key', config.RPG_API_KEY).send({}),
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

describe('actor progression persistence and GPT Action', () => {
  const zeroProgression = {
    strength: 0, vitality: 0, agility: 0, dexterity: 0, intelligence: 0,
    wisdom: 0, perception: 0, willpower: 0, luck: 0,
  };

  it('creates high-level actors with full or partial progression and rejects invalid entitlement atomically', async () => {
    const fullProgression = {
      ...zeroProgression,
      strength: 5, vitality: 5, agility: 5, dexterity: 5,
      intelligence: 5, wisdom: 5, perception: 5, willpower: 5,
    };
    const full = await post('/api/v1/actors/upsert', {
      idempotencyKey: 'progression-create-level-five-full',
      code: 'progression-level-five-full',
      name: 'Veterano Completo',
      actorType: 'npc',
      level: 5,
      primaryAttributes: balancedPrimaryAttributes,
      progressionPrimaryAttributes: fullProgression,
    });
    expect(full.status, JSON.stringify(full.body)).toBe(200);
    expect(full.body).toMatchObject({
      code: 'progression-level-five-full',
      level: 5,
      primaryAttributes: {
        strength: 15, vitality: 15, agility: 15, dexterity: 15,
        intelligence: 15, wisdom: 15, perception: 15, willpower: 15, luck: 10,
      },
    });
    const fullState = await post('/api/v1/actors/progression/manage', {
      actorRef: 'progression-level-five-full', operation: 'get',
    });
    expect(fullState.status).toBe(200);
    expect(fullState.body).toMatchObject({
      actorRef: 'progression-level-five-full',
      level: 5,
      xpCurrent: 0,
      basePrimaryAttributes: balancedPrimaryAttributes,
      progressionPrimaryAttributes: fullProgression,
      attributePointsEarned: 40,
      attributePointsAllocated: 40,
      attributePointsAvailable: 0,
      totalAttributeEntitlement: 130,
      mechanicsStateVersion: 1,
      canLevelUp: false,
    });
    expect(fullState.body).not.toHaveProperty('id');

    const partialProgression = { ...zeroProgression, intelligence: 10, wisdom: 5 };
    const partial = await post('/api/v1/actors/upsert', {
      idempotencyKey: 'progression-create-level-five-partial',
      code: 'progression-level-five-partial',
      name: 'Veterano Parcial',
      actorType: 'creature',
      level: 5,
      primaryAttributes: balancedPrimaryAttributes,
      progressionPrimaryAttributes: partialProgression,
    });
    expect(partial.status).toBe(200);
    const partialState = await post('/api/v1/actors/progression/manage', {
      actorRef: 'progression-level-five-partial', operation: 'get',
    });
    expect(partialState.body).toMatchObject({
      level: 5,
      attributePointsEarned: 40,
      attributePointsAllocated: 15,
      attributePointsAvailable: 25,
      totalAttributeEntitlement: 130,
    });

    const excessive = await post('/api/v1/actors/upsert', {
      idempotencyKey: 'progression-create-level-five-excessive',
      code: 'progression-level-five-excessive',
      name: 'Veterano Inválido',
      actorType: 'npc',
      level: 5,
      primaryAttributes: balancedPrimaryAttributes,
      progressionPrimaryAttributes: { ...fullProgression, luck: 1 },
    });
    expect(excessive.status).toBe(409);
    await expect(prisma.actor.count({ where: { code: 'progression-level-five-excessive' } })).resolves.toBe(0);
    await expect(prisma.idempotencyRecord.count({
      where: { key: 'progression-create-level-five-excessive' },
    })).resolves.toBe(0);

    const levelOneGain = await post('/api/v1/actors/upsert', {
      idempotencyKey: 'progression-create-level-one-gain',
      code: 'progression-level-one-gain',
      name: 'Novato Inválido',
      actorType: 'companion',
      level: 1,
      primaryAttributes: balancedPrimaryAttributes,
      progressionPrimaryAttributes: { ...zeroProgression, strength: 1 },
    });
    expect(levelOneGain.status).toBe(409);
    await expect(prisma.actor.count({ where: { code: 'progression-level-one-gain' } })).resolves.toBe(0);
  });

  it('allocates attributes idempotently, rejects stale or excessive writes, and corrects state with audit', async () => {
    const actorRef = 'progression-allocation-actor';
    const created = await post('/api/v1/actors/upsert', {
      idempotencyKey: 'progression-allocation-create',
      code: actorRef,
      name: 'Especialista',
      actorType: 'spirit',
      level: 2,
      primaryAttributes: balancedPrimaryAttributes,
    });
    expect(created.status).toBe(200);
    const allocationBody = {
      actorRef,
      operation: 'allocate_attributes',
      idempotencyKey: 'progression-allocation-write',
      expectedMechanicsStateVersion: 1,
      attributeDeltas: { strength: 6, intelligence: 4 },
    };
    const allocated = await post('/api/v1/actors/progression/manage', allocationBody);
    const replay = await post('/api/v1/actors/progression/manage', allocationBody);
    expect(allocated.status, JSON.stringify(allocated.body)).toBe(200);
    expect(replay.body).toEqual(allocated.body);
    expect(allocated.body).toMatchObject({
      operation: 'allocate_attributes',
      changed: true,
      mechanicsStateVersion: 2,
      progressionPrimaryAttributes: { strength: 6, intelligence: 4 },
      attributePointsAllocated: 10,
      attributePointsAvailable: 0,
    });
    await expect(prisma.gameEvent.count({
      where: { idempotencyKey: 'progression-allocation-write' },
    })).resolves.toBe(1);

    const stale = await post('/api/v1/actors/progression/manage', {
      actorRef,
      operation: 'allocate_attributes',
      idempotencyKey: 'progression-allocation-stale',
      expectedMechanicsStateVersion: 1,
      attributeDeltas: { luck: 1 },
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: {
      code: 'MECHANICS_STATE_VERSION_CONFLICT',
      retryable: false,
      recoveryAction: 'get_actor_progression',
      issues: [{ path: 'expectedMechanicsStateVersion', code: 'STATE_VERSION_CONFLICT' }],
    } });

    const excessive = await post('/api/v1/actors/progression/manage', {
      actorRef,
      operation: 'allocate_attributes',
      idempotencyKey: 'progression-allocation-excessive',
      expectedMechanicsStateVersion: 2,
      attributeDeltas: { luck: 1 },
    });
    expect(excessive.status).toBe(422);
    expect(excessive.body).toMatchObject({ error: {
      code: 'INSUFFICIENT_ATTRIBUTE_POINTS',
      retryable: false,
      recoveryAction: 'get_actor_progression',
    } });

    const unknownAttribute = await post('/api/v1/actors/progression/manage', {
      actorRef,
      operation: 'allocate_attributes',
      idempotencyKey: 'progression-allocation-unknown',
      expectedMechanicsStateVersion: 2,
      attributeDeltas: { courage: 1 },
    });
    expect(unknownAttribute.status).toBe(400);

    const invalidCorrection = await post('/api/v1/actors/progression/manage', {
      actorRef,
      operation: 'set_progression_state',
      idempotencyKey: 'progression-correction-invalid',
      expectedMechanicsStateVersion: 2,
      reason: 'Tentativa inválida para comprovar rollback.',
      level: 1,
    });
    expect(invalidCorrection.status).toBe(422);
    const afterInvalid = await post('/api/v1/actors/progression/manage', { actorRef, operation: 'get' });
    expect(afterInvalid.body).toMatchObject({
      level: 2,
      mechanicsStateVersion: 2,
      progressionPrimaryAttributes: { strength: 6, intelligence: 4 },
    });
    await expect(prisma.idempotencyRecord.count({
      where: { key: 'progression-correction-invalid' },
    })).resolves.toBe(0);
    await expect(prisma.gameEvent.count({
      where: { idempotencyKey: 'progression-correction-invalid' },
    })).resolves.toBe(0);

    const correctedProgression = { ...zeroProgression, intelligence: 10, wisdom: 5 };
    const corrected = await post('/api/v1/actors/progression/manage', {
      actorRef,
      operation: 'set_progression_state',
      idempotencyKey: 'progression-correction-valid',
      expectedMechanicsStateVersion: 2,
      reason: 'Corrigir nível e redistribuir a ficha conforme pedido do jogador.',
      level: 5,
      xp: 25,
      basePrimaryAttributes: balancedPrimaryAttributes,
      progressionPrimaryAttributes: correctedProgression,
    });
    expect(corrected.status).toBe(200);
    expect(corrected.body).toMatchObject({
      operation: 'set_progression_state',
      level: 5,
      xpCurrent: 25,
      mechanicsStateVersion: 3,
      progressionPrimaryAttributes: correctedProgression,
      attributePointsAvailable: 25,
    });
    const audit = await prisma.gameEvent.findUniqueOrThrow({
      where: { idempotencyKey: 'progression-correction-valid' },
    });
    expect(audit.payload).toMatchObject({
      schemaVersion: 1,
      operation: 'set_progression_state',
      changed: true,
      before: { level: 2, mechanicsStateVersion: 2 },
      after: { level: 5, mechanicsStateVersion: 3 },
    });

    const narrativeUpdate = await api.patch(`/api/v1/actors/${actorRef}`)
      .set('x-rpg-key', config.RPG_API_KEY)
      .send({ ...seedScope, idempotencyKey: 'progression-narrative-patch', description: 'Descrição corrigida.' });
    expect(narrativeUpdate.status).toBe(200);
    const afterNarrative = await post('/api/v1/actors/progression/manage', { actorRef, operation: 'get' });
    expect(afterNarrative.body).toMatchObject({ mechanicsStateVersion: 3, level: 5, xpCurrent: 25 });

    const mechanicalUpsert = await post('/api/v1/actors/upsert', {
      idempotencyKey: 'progression-upsert-mechanical-overwrite',
      code: actorRef,
      name: 'Especialista',
      actorType: 'spirit',
      level: 4,
      primaryAttributes: balancedPrimaryAttributes,
      progressionPrimaryAttributes: zeroProgression,
    });
    expect(mechanicalUpsert.status).toBe(409);
    const afterUpsert = await post('/api/v1/actors/progression/manage', { actorRef, operation: 'get' });
    expect(afterUpsert.body).toMatchObject({ mechanicsStateVersion: 3, level: 5, xpCurrent: 25 });
  });

  it('preserves current resources on maximum increases and clamps them on corrections that reduce maximums', async () => {
    const actorRef = 'progression-resource-actor';
    const highVitalityBase = { ...balancedPrimaryAttributes, vitality: 16, luck: 4 };
    const created = await post('/api/v1/actors/upsert', {
      idempotencyKey: 'progression-resource-create',
      code: actorRef,
      name: 'Guardião',
      actorType: 'companion',
      level: 5,
      primaryAttributes: highVitalityBase,
    });
    expect(created.status).toBe(200);
    const actor = await prisma.actor.findFirstOrThrow({
      where: { code: actorRef, campaign: { code: seedScope.campaignRef } },
    });
    await prisma.actorResource.update({
      where: { actorId_type: { actorId: actor.id, type: ActorResourceType.HP } },
      data: { current: 25, stateVersion: { increment: 1 } },
    });

    const increased = await post('/api/v1/actors/progression/manage', {
      actorRef,
      operation: 'allocate_attributes',
      idempotencyKey: 'progression-resource-increase',
      expectedMechanicsStateVersion: 1,
      attributeDeltas: { vitality: 10 },
    });
    expect(increased.status).toBe(200);
    const increasedBody = bodyRecord(increased);
    expect(increasedBody).toMatchObject({ mechanicsStateVersion: 2 });
    expect(increasedBody.resourceChanges).toEqual(expect.arrayContaining([{
        resource: 'hp',
        before: { current: 25, max: 73 },
        after: { current: 25, max: 93 },
    }]));
    const afterIncrease = await prisma.actorResource.findUniqueOrThrow({
      where: { actorId_type: { actorId: actor.id, type: ActorResourceType.HP } },
    });
    expect(afterIncrease.current).toBe(25);

    await prisma.actorResource.update({
      where: { actorId_type: { actorId: actor.id, type: ActorResourceType.HP } },
      data: { current: 90, stateVersion: { increment: 1 } },
    });
    const reduced = await post('/api/v1/actors/progression/manage', {
      actorRef,
      operation: 'set_progression_state',
      idempotencyKey: 'progression-resource-reduce',
      expectedMechanicsStateVersion: 2,
      reason: 'Corrigir a distribuição que elevou Vitalidade indevidamente.',
      basePrimaryAttributes: balancedPrimaryAttributes,
      progressionPrimaryAttributes: zeroProgression,
    });
    expect(reduced.status).toBe(200);
    const reducedBody = bodyRecord(reduced);
    expect(reducedBody).toMatchObject({ mechanicsStateVersion: 3 });
    expect(reducedBody.resourceChanges).toEqual(expect.arrayContaining([{
        resource: 'hp',
        before: { current: 90, max: 93 },
        after: { current: 61, max: 61 },
    }]));
    const afterReduction = await prisma.actorResource.findUniqueOrThrow({
      where: { actorId_type: { actorId: actor.id, type: ActorResourceType.HP } },
    });
    const snapshotAfterReduction = await prisma.actorDerivedSnapshot.findUniqueOrThrow({
      where: { actorId: actor.id },
    });
    expect(afterReduction.current).toBe(61);
    expect(afterReduction.stateVersion).toBe(afterIncrease.stateVersion + 2);
    expect(snapshotAfterReduction).toMatchObject({ mechanicsStateVersion: 3, maxHp: 61 });
  });

  it('grants XP and levels up idempotently without healing or losing excess XP', async () => {
    const actorRef = 'progression-xp-actor';
    const created = await post('/api/v1/actors/upsert', {
      idempotencyKey: 'progression-xp-create',
      code: actorRef,
      name: 'Aprendiz',
      actorType: 'npc',
      level: 1,
      primaryAttributes: balancedPrimaryAttributes,
    });
    expect(created.status).toBe(200);
    const actor = await prisma.actor.findFirstOrThrow({
      where: { code: actorRef, campaign: { code: seedScope.campaignRef } },
    });
    await prisma.actorResource.update({
      where: { actorId_type: { actorId: actor.id, type: ActorResourceType.HP } },
      data: { current: 25, stateVersion: { increment: 1 } },
    });

    const grantBody = {
      actorRef,
      operation: 'grant_xp',
      idempotencyKey: 'progression-xp-grant',
      expectedMechanicsStateVersion: 1,
      xpAmount: 150,
      source: { type: 'event', ref: 'important-objective-result' },
      reason: 'Objetivo importante concluído.',
    };
    const granted = await post('/api/v1/actors/progression/manage', grantBody);
    const grantReplay = await post('/api/v1/actors/progression/manage', grantBody);
    expect(granted.status).toBe(200);
    expect(grantReplay.body).toEqual(granted.body);
    expect(granted.body).toMatchObject({
      level: 1,
      xpCurrent: 150,
      xpRequiredForNextLevel: 100,
      mechanicsStateVersion: 2,
      canLevelUp: true,
    });

    const levelBody = {
      actorRef,
      operation: 'level_up',
      idempotencyKey: 'progression-xp-level-up',
      expectedMechanicsStateVersion: 2,
    };
    const leveled = await post('/api/v1/actors/progression/manage', levelBody);
    const levelReplay = await post('/api/v1/actors/progression/manage', levelBody);
    expect(leveled.status).toBe(200);
    expect(levelReplay.body).toEqual(leveled.body);
    const leveledBody = bodyRecord(leveled);
    expect(leveledBody).toMatchObject({
      level: 2,
      xpCurrent: 50,
      xpRequiredForNextLevel: 140,
      mechanicsStateVersion: 3,
      attributePointsEarned: 10,
      attributePointsAvailable: 10,
      canLevelUp: false,
    });
    expect(leveledBody.resourceChanges).toEqual(expect.arrayContaining([{
      resource: 'hp',
      before: { current: 25, max: 45 },
      after: { current: 25, max: 49 },
    }]));
    const hp = await prisma.actorResource.findUniqueOrThrow({
      where: { actorId_type: { actorId: actor.id, type: ActorResourceType.HP } },
    });
    expect(hp.current).toBe(25);
    await expect(prisma.gameEvent.count({
      where: { idempotencyKey: { in: ['progression-xp-grant', 'progression-xp-level-up'] } },
    })).resolves.toBe(2);

    const insufficientRef = 'progression-xp-insufficient';
    await post('/api/v1/actors/upsert', {
      idempotencyKey: 'progression-xp-insufficient-create',
      code: insufficientRef,
      name: 'Sem Experiência',
      actorType: 'npc',
      primaryAttributes: balancedPrimaryAttributes,
    });
    const insufficient = await post('/api/v1/actors/progression/manage', {
      actorRef: insufficientRef,
      operation: 'level_up',
      idempotencyKey: 'progression-xp-insufficient-level',
      expectedMechanicsStateVersion: 1,
    });
    expect(insufficient.status).toBe(422);
    expect(insufficient.body).toMatchObject({ error: {
      code: 'INSUFFICIENT_XP',
      retryable: false,
      recoveryAction: 'get_actor_progression',
    } });
    const unchanged = await post('/api/v1/actors/progression/manage', {
      actorRef: insufficientRef, operation: 'get',
    });
    expect(unchanged.body).toMatchObject({ level: 1, xpCurrent: 0, mechanicsStateVersion: 1 });
  });

  it('supports RC1.2 high levels, spends every point, levels past 20, and deduplicates XP by source', async () => {
    const rulesetVersion = await prisma.$transaction((transaction) => ensureCurrentCoreRulesetVersion(transaction));
    const suffix = randomUUID().slice(0, 8);
    const scope = {
      playerRef: `progression-v2-${suffix}`,
      worldRef: `progression-v2-world-${suffix}`,
      campaignRef: `progression-v2-campaign-${suffix}`,
    };
    const player = await prisma.player.create({ data: { slug: scope.playerRef, displayName: 'Progression V2' } });
    const world = await prisma.world.create({
      data: {
        playerId: player.id,
        defaultRulesetVersionId: rulesetVersion.id,
        code: scope.worldRef,
        name: 'Progression V2 World',
      },
    });
    await prisma.campaign.create({
      data: {
        worldId: world.id,
        rulesetVersionId: rulesetVersion.id,
        code: scope.campaignRef,
        name: 'Progression V2 Campaign',
        status: CampaignStatus.ACTIVE,
      },
    });
    const currentPost = (path: string, body: object) => api.post(path)
      .set('x-rpg-key', config.RPG_API_KEY)
      .send({ ...scope, ...body });

    const level50Progression = { ...zeroProgression, intelligence: 490 };
    const level50 = await currentPost('/api/v1/actors/upsert', {
      idempotencyKey: `v2-level-50-full-${suffix}`,
      code: 'level-50-full',
      name: 'Arquimaga',
      actorType: 'npc',
      level: 50,
      primaryAttributes: balancedPrimaryAttributes,
      progressionPrimaryAttributes: level50Progression,
    });
    expect(level50.status, JSON.stringify(level50.body)).toBe(200);
    expect(level50.body).toMatchObject({
      level: 50,
      primaryAttributes: { intelligence: 500 },
    });
    const level50State = await currentPost('/api/v1/actors/progression/manage', {
      actorRef: 'level-50-full',
      operation: 'get',
    });
    expect(level50State.body).toMatchObject({
      level: 50,
      attributePointsEarned: 490,
      attributePointsAllocated: 490,
      attributePointsAvailable: 0,
      totalAttributeEntitlement: 580,
      effectivePrimaryAttributes: { intelligence: 500 },
    });

    for (const [actorRef, level, progressionState, expectedAvailable] of [
      ['level-50-partial', 50, { ...zeroProgression, wisdom: 100 }, 390],
      ['level-100-empty', 100, zeroProgression, 990],
    ] as const) {
      const created = await currentPost('/api/v1/actors/upsert', {
        idempotencyKey: `v2-${actorRef}-${suffix}`,
        code: actorRef,
        name: actorRef,
        actorType: 'creature',
        level,
        primaryAttributes: balancedPrimaryAttributes,
        progressionPrimaryAttributes: progressionState,
      });
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      const state = await currentPost('/api/v1/actors/progression/manage', { actorRef, operation: 'get' });
      expect(state.body).toMatchObject({
        level,
        attributePointsEarned: 10 * (level - 1),
        attributePointsAvailable: expectedAvailable,
        totalAttributeEntitlement: 90 + 10 * (level - 1),
      });
    }

    for (const [actorRef, level] of [['level-20-up', 20], ['level-99-up', 99]] as const) {
      const created = await currentPost('/api/v1/actors/upsert', {
        idempotencyKey: `v2-${actorRef}-create-${suffix}`,
        code: actorRef,
        name: actorRef,
        actorType: 'npc',
        level,
        primaryAttributes: balancedPrimaryAttributes,
      });
      expect(created.status).toBe(200);
      const required = nextCoreV12LevelXp(level);
      if (required === null) throw new Error('High-level transition unexpectedly unavailable');
      const granted = await currentPost('/api/v1/actors/progression/manage', {
        actorRef,
        operation: 'grant_xp',
        idempotencyKey: `v2-${actorRef}-grant-${suffix}`,
        expectedMechanicsStateVersion: 1,
        xpAmount: required + 7,
        source: { type: 'manual', ref: `${actorRef}-reward` },
        reason: 'Preparar teste de level-up acima do limite antigo.',
      });
      expect(granted.status, JSON.stringify(granted.body)).toBe(200);
      const leveled = await currentPost('/api/v1/actors/progression/manage', {
        actorRef,
        operation: 'level_up',
        idempotencyKey: `v2-${actorRef}-level-${suffix}`,
        expectedMechanicsStateVersion: 2,
      });
      expect(leveled.status, JSON.stringify(leveled.body)).toBe(200);
      expect(leveled.body).toMatchObject({
        level: level + 1,
        xpCurrent: 7,
        attributePointsEarned: 10 * level,
        attributePointsAvailable: 10 * level,
      });
    }

    const boundaryRef = 'technical-level-boundary';
    const boundaryCreated = await currentPost('/api/v1/actors/upsert', {
      idempotencyKey: `v2-boundary-create-${suffix}`,
      code: boundaryRef,
      name: 'Technical Boundary',
      actorType: 'npc',
      level: CORE_V1_2_TECHNICAL_LEVEL_MAXIMUM - 1,
      primaryAttributes: balancedPrimaryAttributes,
    });
    expect(boundaryCreated.status, JSON.stringify(boundaryCreated.body)).toBe(200);
    const boundaryRequired = nextCoreV12LevelXp(CORE_V1_2_TECHNICAL_LEVEL_MAXIMUM - 1);
    if (boundaryRequired === null) throw new Error('The transition into the technical boundary must exist');
    const boundaryGrant = await currentPost('/api/v1/actors/progression/manage', {
      actorRef: boundaryRef,
      operation: 'grant_xp',
      idempotencyKey: `v2-boundary-grant-${suffix}`,
      expectedMechanicsStateVersion: 1,
      xpAmount: boundaryRequired,
      source: { type: 'manual', ref: 'technical-boundary-reward' },
      reason: 'Validate the final transition representable by the current storage envelope.',
    });
    expect(boundaryGrant.status, JSON.stringify(boundaryGrant.body)).toBe(200);
    const boundaryLevel = await currentPost('/api/v1/actors/progression/manage', {
      actorRef: boundaryRef,
      operation: 'level_up',
      idempotencyKey: `v2-boundary-level-${suffix}`,
      expectedMechanicsStateVersion: 2,
    });
    expect(boundaryLevel.status, JSON.stringify(boundaryLevel.body)).toBe(200);
    expect(boundaryLevel.body).toMatchObject({
      level: CORE_V1_2_TECHNICAL_LEVEL_MAXIMUM,
      xpCurrent: 0,
      xpRequiredForNextLevel: null,
      mechanicsStateVersion: 3,
    });
    const beyondBoundary = await currentPost('/api/v1/actors/progression/manage', {
      actorRef: boundaryRef,
      operation: 'level_up',
      idempotencyKey: `v2-boundary-reject-${suffix}`,
      expectedMechanicsStateVersion: 3,
    });
    expect(beyondBoundary.status).toBe(422);
    expect(beyondBoundary.body).toMatchObject({ error: {
      code: 'LEVEL_TECHNICAL_RANGE_EXCEEDED',
      retryable: false,
      recoveryAction: 'correct_request',
    } });
    const boundaryAfter = await currentPost('/api/v1/actors/progression/manage', {
      actorRef: boundaryRef,
      operation: 'get',
    });
    expect(boundaryAfter.body).toMatchObject({
      level: CORE_V1_2_TECHNICAL_LEVEL_MAXIMUM,
      xpCurrent: 0,
      mechanicsStateVersion: 3,
    });
    await expect(prisma.idempotencyRecord.count({
      where: { key: `v2-boundary-reject-${suffix}` },
    })).resolves.toBe(0);

    for (const actorRef of ['dedup-one', 'dedup-two']) {
      const created = await currentPost('/api/v1/actors/upsert', {
        idempotencyKey: `v2-${actorRef}-create-${suffix}`,
        code: actorRef,
        name: actorRef,
        actorType: 'npc',
        primaryAttributes: balancedPrimaryAttributes,
      });
      expect(created.status).toBe(200);
    }
    const duplicateBase = {
      actorRef: 'dedup-one',
      operation: 'grant_xp',
      expectedMechanicsStateVersion: 1,
      xpAmount: 100,
      source: { type: 'encounter_consequence', ref: 'slime-result-one' },
      reason: 'Resultado confirmado do encontro.',
    };
    const [first, second] = await Promise.all([
      currentPost('/api/v1/actors/progression/manage', {
        ...duplicateBase,
        idempotencyKey: `v2-dedup-a-${suffix}`,
      }),
      currentPost('/api/v1/actors/progression/manage', {
        ...duplicateBase,
        idempotencyKey: `v2-dedup-b-${suffix}`,
      }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const duplicate = first.status === 409 ? first : second;
    expect(duplicate.body).toMatchObject({ error: { code: 'XP_SOURCE_ALREADY_GRANTED', retryable: false } });
    const afterDuplicate = await currentPost('/api/v1/actors/progression/manage', {
      actorRef: 'dedup-one',
      operation: 'get',
    });
    expect(afterDuplicate.body).toMatchObject({ xpCurrent: 100, mechanicsStateVersion: 2 });

    const differentSource = await currentPost('/api/v1/actors/progression/manage', {
      ...duplicateBase,
      idempotencyKey: `v2-dedup-different-${suffix}`,
      expectedMechanicsStateVersion: 2,
      source: { type: 'event', ref: 'different-result' },
    });
    expect(differentSource.status).toBe(200);
    const differentActor = await currentPost('/api/v1/actors/progression/manage', {
      ...duplicateBase,
      actorRef: 'dedup-two',
      idempotencyKey: `v2-dedup-other-actor-${suffix}`,
    });
    expect(differentActor.status).toBe(200);
  });

  it('blocks progression writes for active encounter participants without ending the encounter', async () => {
    const firstRef = 'progression-encounter-first';
    const secondRef = 'progression-encounter-second';
    for (const [actorRef, actorType] of [[firstRef, 'npc'], [secondRef, 'creature']] as const) {
      const created = await post('/api/v1/actors/upsert', {
        idempotencyKey: `${actorRef}-create`,
        code: actorRef,
        name: actorRef,
        actorType,
        level: 2,
        primaryAttributes: balancedPrimaryAttributes,
      });
      expect(created.status).toBe(200);
    }
    const encounterRef = 'progression-active-encounter';
    const encounter = await post('/api/v1/encounters/manage', {
      operation: 'create',
      encounterRef,
      idempotencyKey: 'progression-active-encounter-create',
      partySideRef: 'party',
      participants: [
        { actorRef: firstRef, sideRef: 'party', zone: 'near' },
        { actorRef: secondRef, sideRef: 'hostile', zone: 'near' },
      ],
    });
    expect(encounter.status, JSON.stringify(encounter.body)).toBe(200);
    const stateVersion = bodyRecord(encounter).stateVersion;
    if (typeof stateVersion !== 'number') throw new Error('Progression encounter version must be numeric');
    try {
      const blockedWrites = [
        {
          operation: 'grant_xp',
          idempotencyKey: 'progression-active-encounter-grant',
          xpAmount: 100,
          source: { type: 'manual', ref: 'active-encounter-reward' },
          reason: 'Must remain blocked while the encounter is active.',
        },
        {
          operation: 'level_up',
          idempotencyKey: 'progression-active-encounter-level',
        },
        {
          operation: 'allocate_attributes',
          idempotencyKey: 'progression-active-encounter-allocation',
          attributeDeltas: { strength: 10 },
        },
        {
          operation: 'set_progression_state',
          idempotencyKey: 'progression-active-encounter-correction',
          reason: 'Must remain blocked while the encounter is active.',
          level: 3,
        },
      ] as const;
      for (const blockedWrite of blockedWrites) {
        const blocked = await post('/api/v1/actors/progression/manage', {
          actorRef: firstRef,
          expectedMechanicsStateVersion: 1,
          ...blockedWrite,
        });
        expect(blocked.status).toBe(409);
        expect(blocked.body).toMatchObject({ error: {
          code: 'ACTOR_ENCOUNTER_LOCKED',
          retryable: false,
          recoveryAction: 'finish_or_abandon_encounter',
          issues: [{ code: 'ACTIVE_ENCOUNTER_PARTICIPANT' }],
        } });
        await expect(prisma.idempotencyRecord.count({
          where: { key: blockedWrite.idempotencyKey },
        })).resolves.toBe(0);
      }
      const blockedUpsert = await post('/api/v1/actors/upsert', {
        idempotencyKey: 'progression-active-encounter-upsert',
        code: firstRef,
        name: firstRef,
        actorType: 'npc',
        level: 2,
        primaryAttributes: balancedPrimaryAttributes,
      });
      expect(blockedUpsert.status).toBe(409);
      expect(blockedUpsert.body).toMatchObject({ error: { code: 'ACTOR_ENCOUNTER_LOCKED' } });
      await expect(prisma.idempotencyRecord.count({
        where: { key: 'progression-active-encounter-upsert' },
      })).resolves.toBe(0);
      const persistedEncounter = await prisma.encounter.findFirstOrThrow({ where: { encounterRef } });
      expect(ACTIVE_ENCOUNTER_LIFECYCLES).toContain(persistedEncounter.lifecycleStatus);
    } finally {
      const cancelled = await post('/api/v1/encounters/manage', {
        operation: 'cancel',
        encounterRef,
        idempotencyKey: 'progression-active-encounter-cancel',
        expectedStateVersion: stateVersion,
      });
      expect(cancelled.status).toBe(200);
    }
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
    const reducedHp = 0;
    await prisma.$transaction(async (transaction) => {
      await transaction.actorResource.update({ where: { id: hp.id }, data: { current: reducedHp, stateVersion: { increment: 1 } } });
      await transaction.actor.update({ where: { id: source.id }, data: { status: 'DEFEATED' } });
    });
    const body = {
      operation: 'use_consumable', sourceActorRef: source.code, targetActorRef: source.code,
      inventoryEntryRef: 'integration-potion-stack', expectedSourceState: await expectedState(source.id),
      idempotencyKey: 'integration-use-potion-001',
    };
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION phase1ma_test_reject_heal_resolution() RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'phase1ma heal rollback injection';
      END
      $function$;
      CREATE TRIGGER phase1ma_test_reject_heal_resolution
        BEFORE INSERT ON "EffectResolution"
        FOR EACH ROW EXECUTE FUNCTION phase1ma_test_reject_heal_resolution();
    `);
    try {
      const rolledBack = await post('/api/v1/actors/effects/resolve', {
        ...body, idempotencyKey: 'integration-use-potion-rollback-001',
      });
      expect(rolledBack.status).toBe(500);
    } finally {
      await prisma.$executeRawUnsafe(`
        DROP TRIGGER IF EXISTS phase1ma_test_reject_heal_resolution ON "EffectResolution";
        DROP FUNCTION IF EXISTS phase1ma_test_reject_heal_resolution();
      `);
    }
    await expect(prisma.actorResource.findUniqueOrThrow({ where: { id: hp.id } }))
      .resolves.toMatchObject({ current: 0 });
    await expect(prisma.actor.findUniqueOrThrow({ where: { id: source.id } }))
      .resolves.toMatchObject({ status: 'DEFEATED' });
    await expect(prisma.inventoryEntry.findUnique({
      where: { actorId_entryRef: { actorId: source.id, entryRef: 'integration-potion-stack' } },
    })).resolves.not.toBeNull();
    const first = await post('/api/v1/actors/effects/resolve', body);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      operation: 'use_consumable', source: { actorRef: source.code }, target: { actorRef: source.code },
      inventoryChanges: [{ entryRef: 'integration-potion-stack', change: 'consumed' }], rolls: [],
    });
    await expect(prisma.inventoryEntry.findUnique({ where: { actorId_entryRef: { actorId: source.id, entryRef: 'integration-potion-stack' } } })).resolves.toBeNull();
    await expect(prisma.actorResource.findUniqueOrThrow({ where: { id: hp.id } })).resolves.toMatchObject({ current: 10 });
    await expect(prisma.actor.findUniqueOrThrow({ where: { id: source.id } })).resolves.toMatchObject({ status: 'ACTIVE' });
    const replay = await post('/api/v1/actors/effects/resolve', body);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    await expect(prisma.effectResolution.count({ where: { idempotencyKey: body.idempotencyKey } })).resolves.toBe(1);
  });
});

describe('PostgreSQL encounter authority races with resolve_beat', () => {
  it('serializes inventory equip against resolve_beat without deadlock or partial authority changes', async () => {
    const entryRef = 'race-body-armor-1';
    const fixture = await createBeatNpcFixture('inventory-race', 1, async ({ world, hero, scope }) => {
      const armor = await publishTestContent({
        worldId: world.id, contentType: ContentType.ARMOR, code: 'race-body-armor', name: 'Race Body Armor',
        profile: {
          schemaVersion: 1, rulesetCode: 'core-v1', profileMode: 'mechanical', contentKind: 'armor',
          code: 'race-body-armor', name: 'Race Body Armor', tier: 1, rarity: 'common',
          activation: { type: 'passive' }, cost: { type: 'none' },
          defense: { physicalFlatDefense: 5 }, equipmentSlots: ['body'],
        },
        inventorySpec: uniqueInventorySpec(3, { equipmentSlots: ['body'] }),
      });
      const version = armor.versions[0];
      if (version === undefined) throw new Error('Race armor version is required');
      await prismaGptRepository.manageActorInventory(hero.code, {
        ...scope, operation: 'grant', idempotencyKey: 'inventory-race-grant',
        expectedInventoryStateVersion: hero.inventoryStateVersion,
        contentRef: { scope: 'world', contentType: 'armor', code: armor.code, versionNumber: version.versionNumber },
        quantity: 1, entryRefs: [entryRef],
      });
    });
    const before = await prisma.actor.findUniqueOrThrow({
      where: { id: fixture.hero.id },
      select: {
        inventoryStateVersion: true, mechanicsStateVersion: true, effectsStateVersion: true,
        resources: { orderBy: { type: 'asc' }, select: { type: true, current: true, stateVersion: true } },
      },
    });
    const equipInput = {
      ...fixture.scope, operation: 'equip' as const, idempotencyKey: 'inventory-race-equip',
      expectedInventoryStateVersion: before.inventoryStateVersion, entryRef, targetSlotRef: 'body' as const,
    };
    const beatInput = {
      ...fixture.scope, encounterRef: fixture.encounterRef, idempotencyKey: 'inventory-race-beat',
      expectedStateVersion: fixture.created.stateVersion,
      intent: {
        actorRef: fixture.heroRef, objective: 'hold_position', narrative: 'O herói mantém posição.',
        resolutionPolicy: 'atomic' as const, components: [{ type: 'move' as const, destination: 'medium' as const }],
      },
      npcDirectives: [{ actorRef: fixture.npcRefs[0]!, strategy: 'aggressive' as const }],
    };
    let closed = false;
    try {
      const race = await Promise.allSettled([
        prismaGptRepository.manageActorInventory(fixture.heroRef, equipInput),
        encounterService.resolveBeat(beatInput),
      ]);
      expect(race.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
      expect(race.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
      const equipWon = race[0]?.status === 'fulfilled';
      const winner = race.find((attempt) => attempt.status === 'fulfilled');
      const loser = race.find((attempt) => attempt.status === 'rejected');
      if (winner?.status !== 'fulfilled' || loser?.status !== 'rejected') throw new Error('One race winner and loser are required');
      expect(loser.reason).toMatchObject({
        code: equipWon ? 'ENCOUNTER_INVENTORY_DRIFT' : 'ACTOR_ENCOUNTER_LOCKED',
      });

      const [after, entry, activeEffects] = await Promise.all([
        prisma.actor.findUniqueOrThrow({
          where: { id: fixture.hero.id },
          select: {
            inventoryStateVersion: true, mechanicsStateVersion: true, effectsStateVersion: true,
            resources: { orderBy: { type: 'asc' }, select: { type: true, current: true, stateVersion: true } },
          },
        }),
        prisma.inventoryEntry.findUniqueOrThrow({
          where: { actorId_entryRef: { actorId: fixture.hero.id, entryRef } }, include: { equipmentSlots: true },
        }),
        prisma.activeEffect.count({ where: { targetActorId: fixture.hero.id } }),
      ]);
      expect(after.resources).toEqual(before.resources);
      expect(after.effectsStateVersion).toBe(before.effectsStateVersion);
      expect(activeEffects).toBe(0);
      expect(entry.equipmentSlots.map((slot) => slot.slotRef)).toEqual(equipWon ? [ActorEquipmentSlotRef.BODY] : []);
      expect(after.inventoryStateVersion).toBe(before.inventoryStateVersion + (equipWon ? 1 : 0));
      expect(after.mechanicsStateVersion).toBe(before.mechanicsStateVersion + (equipWon ? 1 : 0));
      await expect(prisma.idempotencyRecord.count({ where: {
        key: equipWon ? equipInput.idempotencyKey : `encounter:${beatInput.idempotencyKey}`,
      } })).resolves.toBe(1);
      await expect(prisma.idempotencyRecord.count({ where: {
        key: equipWon ? `encounter:${beatInput.idempotencyKey}` : equipInput.idempotencyKey,
      } })).resolves.toBe(0);
      if (equipWon) {
        await expect(prismaGptRepository.manageActorInventory(fixture.heroRef, equipInput)).resolves.toEqual(winner.value);
        const persisted = await prisma.encounter.findFirstOrThrow({ where: { encounterRef: fixture.encounterRef } });
        await encounterService.abandon({
          ...fixture.scope, encounterRef: fixture.encounterRef, idempotencyKey: 'inventory-race-cleanup-abandon',
          expectedStateVersion: persisted.stateVersion, confirmAuthorityDrift: true,
        });
      } else {
        await expect(encounterService.resolveBeat(beatInput)).resolves.toEqual(winner.value);
        const resolved = winner.value as Awaited<ReturnType<typeof encounterService.resolveBeat>>;
        await encounterService.cancel({
          ...fixture.scope, encounterRef: fixture.encounterRef, idempotencyKey: 'inventory-race-cleanup-cancel',
          expectedStateVersion: resolved.stateVersion,
        });
      }
      closed = true;
      await expect(prismaGptRepository.loadGame(fixture.scope)).resolves.toMatchObject({ activeEncounter: null });
    } finally {
      if (!closed) {
        const persisted = await prisma.encounter.findFirst({
          where: { campaignId: fixture.campaign.id, encounterRef: fixture.encounterRef },
        });
        if (persisted !== null && !(new Set<EncounterLifecycleStatus>([
          EncounterLifecycleStatus.COMPLETED, EncounterLifecycleStatus.FAILED, EncounterLifecycleStatus.CANCELLED,
        ])).has(persisted.lifecycleStatus)) {
          try {
            await encounterService.cancel({
              ...fixture.scope, encounterRef: fixture.encounterRef, idempotencyKey: 'inventory-race-emergency-cancel',
              expectedStateVersion: persisted.stateVersion,
            });
          } catch {
            await encounterService.abandon({
              ...fixture.scope, encounterRef: fixture.encounterRef, idempotencyKey: 'inventory-race-emergency-abandon',
              expectedStateVersion: persisted.stateVersion, confirmAuthorityDrift: true,
            });
          }
        }
      }
    }
  });

  it('serializes ActorContent mutation against resolve_beat and rolls the blocked write back completely', async () => {
    const contentCode = 'race-known-skill';
    const fixture = await createBeatNpcFixture('content-race', 1, async ({ world }) => {
      await publishTestContent({
        worldId: world.id, contentType: ContentType.SKILL, code: contentCode, name: 'Race Known Skill',
        profile: activeProfile('skill', contentCode, 'Race Known Skill'),
      });
    });
    const contentInput = {
      ...fixture.scope, operation: 'grant' as const, contentRef: contentCode, contentType: 'skill' as const,
      idempotencyKey: 'content-race-grant', changes: { state: 'known' as const, rank: 1 },
    };
    const beatInput = {
      ...fixture.scope, encounterRef: fixture.encounterRef, idempotencyKey: 'content-race-beat',
      expectedStateVersion: fixture.created.stateVersion,
      intent: {
        actorRef: fixture.heroRef, objective: 'hold_position', narrative: 'O herói mantém posição.',
        resolutionPolicy: 'atomic' as const, components: [{ type: 'move' as const, destination: 'medium' as const }],
      },
      npcDirectives: [{ actorRef: fixture.npcRefs[0]!, strategy: 'aggressive' as const }],
    };
    const before = await prisma.actor.findUniqueOrThrow({
      where: { id: fixture.hero.id },
      select: {
        mechanicsStateVersion: true, inventoryStateVersion: true, effectsStateVersion: true,
        resources: { orderBy: { type: 'asc' }, select: { type: true, current: true, stateVersion: true } },
      },
    });
    let closed = false;
    try {
      const race = await Promise.allSettled([
        prismaGptRepository.manageActorContent(fixture.heroRef, contentInput),
        encounterService.resolveBeat(beatInput),
      ]);
      expect(race[0]).toMatchObject({ status: 'rejected', reason: { code: 'ACTOR_ENCOUNTER_LOCKED' } });
      expect(race[1]).toMatchObject({ status: 'fulfilled' });
      if (race[1]?.status !== 'fulfilled') throw new Error('resolve_beat must win the ActorContent race');
      await expect(prisma.actorContent.count({
        where: { actorId: fixture.hero.id, contentDefinition: { code: contentCode } },
      })).resolves.toBe(0);
      await expect(prisma.actor.findUniqueOrThrow({
        where: { id: fixture.hero.id },
        select: {
          mechanicsStateVersion: true, inventoryStateVersion: true, effectsStateVersion: true,
          resources: { orderBy: { type: 'asc' }, select: { type: true, current: true, stateVersion: true } },
        },
      })).resolves.toEqual(before);
      await expect(prisma.activeEffect.count({ where: { targetActorId: fixture.hero.id } })).resolves.toBe(0);
      await expect(prisma.contentDefinition.count({ where: { worldId: fixture.world.id, code: contentCode } })).resolves.toBe(1);
      await expect(prisma.idempotencyRecord.count({ where: { key: contentInput.idempotencyKey } })).resolves.toBe(0);
      await expect(prisma.idempotencyRecord.count({ where: { key: `encounter:${beatInput.idempotencyKey}` } })).resolves.toBe(1);
      await expect(encounterService.resolveBeat(beatInput)).resolves.toEqual(race[1].value);
      await encounterService.cancel({
        ...fixture.scope, encounterRef: fixture.encounterRef, idempotencyKey: 'content-race-cleanup-cancel',
        expectedStateVersion: race[1].value.stateVersion,
      });
      closed = true;
    } finally {
      if (!closed) {
        const persisted = await prisma.encounter.findFirst({ where: { encounterRef: fixture.encounterRef } });
        if (persisted !== null && !(new Set<EncounterLifecycleStatus>([
          EncounterLifecycleStatus.COMPLETED, EncounterLifecycleStatus.FAILED, EncounterLifecycleStatus.CANCELLED,
        ])).has(persisted.lifecycleStatus)) {
          await encounterService.cancel({
            ...fixture.scope, encounterRef: fixture.encounterRef, idempotencyKey: 'content-race-emergency-cancel',
            expectedStateVersion: persisted.stateVersion,
          });
        }
      }
    }
  });
});

describe('resolve_beat mechanical vertical slice', () => {
  it('resolves attack, spell and consumable beats with authoritative deltas and one checkpoint each', async () => {
    const beatService = createEncounterService(
      prisma,
      (executionRef) => new RecordingEncounterRollProvider({ nextBps: () => 1 }, executionRef),
    );
    const source = await prisma.actor.findFirstOrThrow({
      where: { code: 'ralph', campaign: { code: seedScope.campaignRef, world: { code: seedScope.worldRef } } },
      include: { campaign: { include: { world: true } }, derivedSnapshot: true },
    });
    const target = await prisma.actor.findFirstOrThrow({
      where: { code: 'lyra', campaignId: source.campaignId },
      include: { derivedSnapshot: true },
    });
    if (source.derivedSnapshot === null || target.derivedSnapshot === null) {
      throw new Error('Beat mechanical actors require derived snapshots');
    }
    const sourceMaxHp = source.derivedSnapshot.maxHp;
    const sourceMaxMana = source.derivedSnapshot.maxMana;
    const targetMaxHp = target.derivedSnapshot.maxHp;
    await prisma.$transaction(async (transaction) => {
      await transaction.activeEffect.deleteMany({
        where: {
          targetActorId: { in: [source.id, target.id] },
          sourceContentVersion: { contentDefinition: { code: 'seed-mark-spell' } },
        },
      });
      await recomputeActorDerivedSnapshot(transaction, source.id);
      await recomputeActorDerivedSnapshot(transaction, target.id);
    });
    const [sourceHp, sourceMana, targetHp] = await Promise.all([
      prisma.actorResource.findUniqueOrThrow({ where: { actorId_type: { actorId: source.id, type: 'HP' } } }),
      prisma.actorResource.findUniqueOrThrow({ where: { actorId_type: { actorId: source.id, type: 'MANA' } } }),
      prisma.actorResource.findUniqueOrThrow({ where: { actorId_type: { actorId: target.id, type: 'HP' } } }),
    ]);
    const woundedHp = Math.max(1, sourceMaxHp - 10);
    await prisma.$transaction([
      prisma.actorResource.update({
        where: { id: sourceHp.id }, data: { current: woundedHp, stateVersion: { increment: 1 } },
      }),
      prisma.actorResource.update({
        where: { id: sourceMana.id }, data: { current: sourceMaxMana, stateVersion: { increment: 1 } },
      }),
      prisma.actorResource.update({
        where: { id: targetHp.id }, data: { current: targetMaxHp, stateVersion: { increment: 1 } },
      }),
      prisma.actor.update({ where: { id: source.id }, data: { status: 'ACTIVE' } }),
      prisma.actor.update({ where: { id: target.id }, data: { status: 'ACTIVE' } }),
    ]);

    const potion = await prisma.$transaction((transaction) => publishContentVersion(transaction, {
      worldId: source.campaign.world.id,
      campaignId: source.campaignId,
      contentType: ContentType.CONSUMABLE,
      code: 'beat-healing-potion',
      name: 'Poção de Cura do Beat',
      description: 'Restaura HP durante a integração de resolve_beat.',
      profile: {
        schemaVersion: 1, rulesetCode: 'core-v1', profileMode: 'mechanical', contentKind: 'consumable',
        code: 'beat-healing-potion', name: 'Poção de Cura do Beat',
        description: 'Restaura HP durante a integração de resolve_beat.',
        tier: 1, rarity: 'common', activation: { type: 'active' }, cost: { type: 'none' },
        actionProfile: 'potion', consumable: true,
        effects: [{ type: 'restore_resource', resource: 'hp', amount: 10, targeting: { type: 'self', rangeBand: 'self' } }],
      },
      inventorySpec: { ...inventorySpecBase, unitWeight: 1, stacking: { mode: 'stackable', maxStack: 20 } },
      presentation: {}, tags: ['integration', 'beat'], status: ContentStatus.ACTIVE, metadata: {},
    }));
    const potionVersion = potion.versions[0];
    if (potionVersion === undefined) throw new Error('Beat potion version is required');
    const actorBeforeGrant = await prisma.actor.findUniqueOrThrow({ where: { id: source.id } });
    const granted = await post(`/api/v1/actors/${source.code}/inventory/manage`, {
      operation: 'grant', expectedInventoryStateVersion: actorBeforeGrant.inventoryStateVersion,
      idempotencyKey: 'beat-grant-potion-0001',
      contentRef: {
        scope: 'campaign', contentType: 'consumable', code: potion.code,
        versionNumber: potionVersion.versionNumber,
      },
      quantity: 1, entryRefs: ['beat-potion-stack'],
    });
    expect(granted.status).toBe(200);

    const resolve = async (
      suffix: string,
      component: NonNullable<Parameters<typeof encounterService.resolveBeat>[0]['intent']>['components'][number],
      verify: () => Promise<void>,
    ) => {
      const encounterRef = `phase-beat-mechanical-${suffix}`;
      const zone = suffix === 'attack' ? 'engaged' as const : 'near' as const;
      const created = await beatService.create({
        ...seedScope,
        encounterRef,
        idempotencyKey: `phase-beat-mechanical-${suffix}-create-0001`,
        partySideRef: 'party',
        participants: [
          { bindingKind: 'persisted_actor', actorRef: source.code, sideRef: 'party', zone },
          { bindingKind: 'persisted_actor', actorRef: target.code, sideRef: 'hostile', zone },
        ],
        relations: [
          { leftActorRef: source.code, rightActorRef: source.code, relation: 'self' },
          { leftActorRef: target.code, rightActorRef: target.code, relation: 'self' },
          { leftActorRef: source.code, rightActorRef: target.code, relation: 'hostile' },
        ],
      });
      let cleanupNeeded = true;
      try {
        const result = await beatService.resolveBeat({
          ...seedScope,
          encounterRef,
          expectedStateVersion: created.stateVersion,
          idempotencyKey: `phase-beat-mechanical-${suffix}-resolve-0001`,
          intent: {
            actorRef: source.code,
            objective: suffix,
            narrative: `Ralph executa ${suffix} como uma decisão significativa.`,
            resolutionPolicy: 'atomic',
            components: [component],
          },
          npcDirectives: [{ actorRef: target.code, strategy: 'defensive' }],
        });
        expect(result).toMatchObject({
          operation: 'resolve_beat', lifecycleStatus: 'awaiting_intent',
          beatSummary: {
            externalTransitions: 1, resolutionPolicy: 'atomic', partialResolutionApplied: false,
            componentResults: [{ index: 0, type: component.type, status: 'accepted' }],
            requiresPlayerDecision: true,
          },
        });
        expect(result.scene).toMatchObject({ stateVersion: result.stateVersion });
        expect(result.scene?.participants).toHaveLength(2);
        expect(result.nextRequiredAction.type).not.toBe('continue');
        await expect(prisma.encounterOperation.count({ where: { encounter: { encounterRef } } })).resolves.toBe(2);
        await verify();
        await beatService.cancel({
          ...seedScope,
          encounterRef,
          idempotencyKey: `phase-beat-mechanical-${suffix}-cancel-0001`,
          expectedStateVersion: result.stateVersion,
        });
        cleanupNeeded = false;
      } finally {
        if (cleanupNeeded) {
          const persisted = await prisma.encounter.findFirst({
            where: { encounterRef }, select: { lifecycleStatus: true, stateVersion: true },
          });
          const terminalStatuses = new Set<EncounterLifecycleStatus>([
            EncounterLifecycleStatus.COMPLETED,
            EncounterLifecycleStatus.FAILED,
            EncounterLifecycleStatus.CANCELLED,
          ]);
          if (persisted !== null && !terminalStatuses.has(persisted.lifecycleStatus)) {
            await beatService.cancel({
              ...seedScope,
              encounterRef,
              idempotencyKey: `phase-beat-mechanical-${suffix}-cleanup-0001`,
              expectedStateVersion: persisted.stateVersion,
            });
          }
        }
      }
    };

    await resolve('attack', {
      type: 'attack', inventoryEntryRef: 'starter-dagger-1', targetRefs: [target.code],
    }, async () => {
      const targetAfterAttack = await prisma.actorResource.findUniqueOrThrow({ where: { id: targetHp.id } });
      expect(targetAfterAttack.current).toBeLessThan(targetMaxHp);
    });

    await resolve('cast', {
      type: 'cast',
      contentRef: { scope: 'campaign', contentType: 'spell', code: 'seed-mark-spell', versionNumber: 1 },
      targetRefs: [source.code],
    }, async () => {
      await expect(prisma.actorResource.findUniqueOrThrow({ where: { id: sourceMana.id } }))
        .resolves.toMatchObject({ current: sourceMaxMana - 3 });
      await expect(prisma.activeEffect.count({
        where: { targetActorId: source.id, sourceContentVersion: { contentDefinition: { code: 'seed-mark-spell' } } },
      })).resolves.toBe(1);
    });

    await resolve('use-item', { type: 'use_item', inventoryEntryRef: 'beat-potion-stack' }, async () => {
      await expect(prisma.inventoryEntry.findUnique({
        where: { actorId_entryRef: { actorId: source.id, entryRef: 'beat-potion-stack' } },
      })).resolves.toBeNull();
      await expect(prisma.actorResource.findUniqueOrThrow({ where: { id: sourceHp.id } }))
        .resolves.toMatchObject({ current: sourceMaxHp });
    });

    const genericComponents = [
      ['defend', { type: 'defend' }],
      ['protect', { type: 'protect', targetRef: source.code }],
      ['intercept', { type: 'intercept', targetRef: source.code }],
      ['prepare', {
        type: 'prepare', contentRef: { scope: 'campaign', contentType: 'spell', code: 'seed-mark-spell', versionNumber: 1 },
        trigger: 'enemy_attacks', targetRefs: [target.code],
      }],
      ['assist', { type: 'assist', targetRef: source.code }],
      ['observe', { type: 'observe' }],
      ['interact', { type: 'interact', targetRef: source.code, description: 'inspect the ward' }],
      ['improvise', { type: 'improvise', description: 'take cover' }],
    ] as const;
    for (const [suffix, component] of genericComponents) {
      await resolve(suffix, component, () => Promise.resolve());
    }
  });
});

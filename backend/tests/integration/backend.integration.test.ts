import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import process from 'node:process';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { ActorContentState, ActorType, CampaignStatus, ContentStatus, ContentType } from '../../src/generated/prisma/client.js';
import { createApp } from '../../src/app.js';
import { parseConfig } from '../../src/config/env.js';
import { prismaActorRepository } from '../../src/modules/actors/actors.repository.js';
import type { ActorRepository } from '../../src/modules/actors/actors.types.js';
import { prismaContentRepository } from '../../src/modules/content/content.repository.js';
import { prismaGptRepository } from '../../src/modules/gpt/gpt.repository.js';
import { canonicalize, jsonByteSize } from '../../src/modules/gpt/gpt.start-game.js';
import { prismaReadinessCheck } from '../../src/modules/health/health.repository.js';
import { disconnectPrisma, prisma } from '../../src/shared/database/prisma.js';

const config = parseConfig(process.env);
const dependencies = { actorRepository: prismaActorRepository, contentRepository: prismaContentRepository, gptRepository: prismaGptRepository, readiness: prismaReadinessCheck };
const app = createApp(config, dependencies);
const authenticated = (path: string) => request(app).get(path).set('x-rpg-key', config.RPG_API_KEY);
function bodyRecord(response: { body: unknown }): Record<string, unknown> {
  return response.body !== null && typeof response.body === 'object' ? response.body as Record<string, unknown> : {};
}
function responseErrorMessage(response: { body: unknown }): unknown {
  const error = bodyRecord(response).error;
  return error !== null && typeof error === 'object' ? (error as Record<string, unknown>).message : undefined;
}
const seedScope = { playerRef: 'ralph', worldRef: 'elarion', campaignRef: 'main-campaign' };
const seedScopeQuery = 'playerRef=ralph&worldRef=elarion&campaignRef=main-campaign';

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
      code: `${prefix}-player`, name: `${prefix} Hero`, actorType: 'character', className: null, health: 18, maxHealth: 18, mana: cyberpunk ? 0 : 6, maxMana: cyberpunk ? 0 : 6,
      attributes: { intellect: 6 }, appearance: { summary: cyberpunk ? 'Jaqueta urbana.' : 'Manto de viagem.' },
      personality: { traits: cyberpunk ? ['cético'] : ['curioso'] }, origin: { label: 'Sobrevivente', summary: 'Sobreviveu a um acontecimento incomum.' },
    },
    initialContentPackages: [{
      definition: {
        mode: 'create', scope: 'world', contentType: 'weapon', code: cyberpunk ? 'smart-pistol' : 'longbow', name: cyberpunk ? 'Pistola Inteligente' : 'Arco Longo',
        description: 'Arma inicial.', mechanics: { equipBehavior: 'wieldable' }, requirements: {}, presentation: {}, tags: ['weapon'], schemaVersion: 1, status: 'active', metadata: {},
      },
      protagonistLink: { state: 'known', rank: 0, progress: 0, mastery: 0, equipped: true, quantity: 1, metadata: { slotHint: 'hands' } },
    }],
    initialPremise: cyberpunk ? 'Um sinal clandestino chega ao protagonista.' : 'Um dragão desperta além da fronteira.',
  };
}

function campaignInNewWorld(prefix: string, initialContentPackages: object[] = []) {
  const body = structuredStart(prefix);
  return {
    ...body, playerMode: 'reuse', playerRef: 'new-player', playerDisplayName: undefined,
    worldMode: 'reuse', worldRef: 'new-world', worldName: undefined, worldDescription: undefined, worldConfiguration: undefined,
    protagonist: { ...body.protagonist, code: 'new-player' }, initialContentPackages,
  };
}

async function expectNoCreatedIntent(body: { playerRef: string; worldRef: string; campaignRef: string; idempotencyKey: string }) {
  const [players, worlds, campaigns, actors, definitions, links, events, idempotency] = await Promise.all([
    prisma.player.count({ where: { slug: body.playerRef } }),
    prisma.world.count({ where: { code: body.worldRef, player: { slug: body.playerRef } } }),
    prisma.campaign.count({ where: { code: body.campaignRef, world: { code: body.worldRef, player: { slug: body.playerRef } } } }),
    prisma.actor.count({ where: { campaign: { code: body.campaignRef, world: { code: body.worldRef, player: { slug: body.playerRef } } } } }),
    prisma.contentDefinition.count({ where: { world: { code: body.worldRef, player: { slug: body.playerRef } } } }),
    prisma.actorContent.count({ where: { actor: { campaign: { code: body.campaignRef, world: { code: body.worldRef, player: { slug: body.playerRef } } } } } }),
    prisma.gameEvent.count({ where: { campaign: { code: body.campaignRef, world: { code: body.worldRef, player: { slug: body.playerRef } } } } }),
    prisma.idempotencyRecord.count({ where: { key: body.idempotencyKey } }),
  ]);
  expect({ players, worlds, campaigns, actors, definitions, links, events, idempotency }).toEqual({
    players: 0, worlds: 0, campaigns: 0, actors: 0, definitions: 0, links: 0, events: 0, idempotency: 0,
  });
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

  it('contains every principal table', async () => {
    const rows = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('Player', 'World', 'Campaign', 'Actor', 'ContentDefinition', 'ActorContent', 'GameEvent', 'IdempotencyRecord')
    `;
    expect(rows.map((row) => row.table_name).sort()).toEqual(['Actor', 'ActorContent', 'Campaign', 'ContentDefinition', 'GameEvent', 'IdempotencyRecord', 'Player', 'World']);
  });

  it('contains the principal foreign keys', async () => {
    const rows = await prisma.$queryRaw<Array<{ constraint_name: string }>>`
      SELECT constraint_name FROM information_schema.table_constraints
      WHERE constraint_schema = 'public' AND constraint_type = 'FOREIGN KEY'
    `;
    expect(rows.map((row) => row.constraint_name)).toEqual(expect.arrayContaining([
      'World_playerId_fkey', 'Campaign_worldId_fkey', 'Actor_campaignId_fkey',
      'ActorContent_actorId_fkey', 'ActorContent_contentDefinitionId_fkey',
    ]));
  });

  it('contains the partial global ContentDefinition index', async () => {
    const rows = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ContentDefinition_global_scope_key'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain('WHERE ("campaignId" IS NULL)');
  });

  it('enables RLS without public policies on every Node platform table', async () => {
    const tables = await prisma.$queryRaw<Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>>`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN ('Player', 'World', 'Campaign', 'Actor', 'ContentDefinition', 'ActorContent', 'GameEvent', 'IdempotencyRecord')
    `;
    expect(tables).toHaveLength(8);
    expect(tables.every((table) => table.relrowsecurity)).toBe(true);
    expect(tables.every((table) => !table.relforcerowsecurity)).toBe(true);
    await expect(prisma.$queryRaw<Array<{ tablename: string }>>`SELECT tablename::text FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('Player', 'World', 'Campaign', 'Actor', 'ContentDefinition', 'ActorContent', 'GameEvent', 'IdempotencyRecord')`).resolves.toHaveLength(0);
  });

  it('does not grant table privileges to PUBLIC', async () => {
    const rows = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) privilege
      WHERE n.nspname = 'public'
        AND c.relname IN ('Player', 'World', 'Campaign', 'Actor', 'ContentDefinition', 'ActorContent', 'GameEvent', 'IdempotencyRecord')
        AND privilege.grantee = 0
    `;
    expect(rows[0]?.count).toBe(0);
  });

  it('keeps conditional Supabase revocations compatible when local roles do not exist', async () => {
    const roles = await prisma.$queryRaw<Array<{ rolname: string }>>`SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')`;
    expect(roles.map((role) => role.rolname).every((role) => ['anon', 'authenticated'].includes(role))).toBe(true);
    await expect(prisma.player.count()).resolves.toBeGreaterThanOrEqual(1);
  });
});

describe('idempotent seed', () => {
  async function counts() {
    const [players, worlds, campaigns, actors, definitions, links] = await Promise.all([
      prisma.player.count(), prisma.world.count(), prisma.campaign.count(), prisma.actor.count(),
      prisma.contentDefinition.count(), prisma.actorContent.count(),
    ]);
    return { players, worlds, campaigns, actors, definitions, links };
  }

  it('creates the expected initial records', async () => {
    await expect(counts()).resolves.toEqual({ players: 1, worlds: 1, campaigns: 1, actors: 2, definitions: 1, links: 1 });
  });

  it('keeps counts and the Ralph content link unchanged on a second seed', async () => {
    const before = await counts();
    const npmCli = process.env.npm_execpath;
    expect(npmCli).toBeDefined();
    const result = spawnSync(process.execPath, [npmCli ?? '', 'run', 'prisma:seed'], { env: process.env, stdio: 'pipe', encoding: 'utf8' });
    expect(result.status).toBe(0);
    await expect(counts()).resolves.toEqual(before);

    const ralph = await prisma.actor.findFirstOrThrow({ where: { code: 'ralph' }, include: { content: { include: { contentDefinition: true } } } });
    const lyraCount = await prisma.actor.count({ where: { code: 'lyra' } });
    const definitionCount = await prisma.contentDefinition.count({ where: { code: 'wind_breeze_step' } });
    expect(lyraCount).toBe(1);
    expect(definitionCount).toBe(1);
    expect(ralph.content).toHaveLength(1);
    expect(ralph.content[0]).toMatchObject({ state: 'LEARNING', rank: 1, progress: 10, mastery: 0, notes: 'Treino inicial com Lyra' });
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
    expect(response.body).toEqual([expect.objectContaining({ code: 'wind_breeze_step', state: 'learning', rank: 1, progress: 10, mastery: 0, notes: 'Treino inicial com Lyra' })]);
    expect(JSON.stringify(response.body)).not.toContain('contentDefinition');
  });

  it('returns Lyra and Passo da Brisa through real queries', async () => {
    const lyra = await authenticated(`/api/v1/actors/lyra?${seedScopeQuery}`);
    const content = await authenticated(`/api/v1/content/wind_breeze_step?${seedScopeQuery}&contentType=skill`);
    expect(lyra.body).toMatchObject({ code: 'lyra', actorType: 'spirit', status: 'active' });
    expect(content.body).toMatchObject({ code: 'wind_breeze_step', name: 'Passo da Brisa', contentType: 'skill', status: 'active' });
    expect(content.body).not.toHaveProperty('worldId');
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
  const post = (path: string, body: object) => request(app).post(path).set('x-rpg-key', config.RPG_API_KEY).send({ ...seedScope, ...body });
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
      protagonist: { code: 'new-player', actorType: 'character', health: 18, appearance: { summary: 'Manto de viagem.' }, personality: { traits: ['curioso'] } },
      mainActors: [], linkedContent: [expect.objectContaining({ actorRef: 'new-player', code: 'longbow', equipped: true, quantity: 1 })],
      recentEvents: [expect.objectContaining({ eventType: 'campaign-started', actorRef: 'new-player' })],
    });
    await expect(prisma.player.count({ where: { slug: 'new-player' } })).resolves.toBe(1);
    await expect(prisma.idempotencyRecord.count({ where: { key: body.idempotencyKey } })).resolves.toBe(1);
    await expect(prisma.gameEvent.count({ where: { campaign: { code: body.campaignRef, world: { code: body.worldRef } }, eventType: 'campaign-started' } })).resolves.toBe(1);
    await expect(prisma.gameEvent.findFirstOrThrow({ where: { campaign: { code: body.campaignRef, world: { code: body.worldRef } }, eventType: 'campaign-started' } })).resolves.toMatchObject({ idempotencyKey: null });

    const conflict = await post('/api/v1/game/start', { ...body, campaignName: 'Outra Campanha' });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({ error: { code: 'CONFLICT', message: 'Idempotency key already used' } });
    const arrayOrderConflict = await post('/api/v1/game/start', {
      ...body, worldConfiguration: { ...body.worldConfiguration, worldTone: [...body.worldConfiguration.worldTone].reverse() },
    });
    expect(arrayOrderConflict.status).toBe(409);
    expect(responseErrorMessage(arrayOrderConflict)).toBe('Idempotency key already used');
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
    expect(JSON.stringify(created.body)).not.toMatch(/"id"|playerId|worldId|campaignId|actorId|contentDefinitionId/);
  });

  it('reuses Player, World and global content without updating persisted values', async () => {
    const beforePlayer = await prisma.player.findUniqueOrThrow({ where: { slug: 'new-player' } });
    const beforeWorld = await prisma.world.findUniqueOrThrow({ where: { playerId_code: { playerId: beforePlayer.id, code: 'new-world' } } });
    const reusePackage = {
      definition: { mode: 'reuse', scope: 'world', code: 'longbow', contentType: 'weapon' },
      protagonistLink: { state: 'known', rank: 0, progress: 0, mastery: 0, equipped: true, quantity: 1, metadata: {} },
    };
    const body = campaignInNewWorld('reuse', [reusePackage]);
    const response = await post('/api/v1/game/start', body);
    expect(response.status).toBe(200);
    expect(bodyRecord(response).linkedContent).toEqual([expect.objectContaining({ code: 'longbow', equipped: true })]);
    await expect(prisma.player.findUniqueOrThrow({ where: { slug: 'new-player' } })).resolves.toMatchObject({ displayName: beforePlayer.displayName, updatedAt: beforePlayer.updatedAt });
    await expect(prisma.world.findUniqueOrThrow({ where: { id: beforeWorld.id } })).resolves.toMatchObject({
      name: beforeWorld.name, description: beforeWorld.description, metadata: beforeWorld.metadata, updatedAt: beforeWorld.updatedAt,
    });

    const mismatch = await post('/api/v1/game/start', { ...campaignInNewWorld('mismatch'), playerDisplayName: 'Changed Name' });
    expect(mismatch.status).toBe(409);
    expect(responseErrorMessage(mismatch)).toBe('Player display name does not match');
    await expect(prisma.player.findUniqueOrThrow({ where: { slug: 'new-player' } })).resolves.toMatchObject({ displayName: beforePlayer.displayName });
  });

  it('matches className against the persisted public name of a reused mechanical class', async () => {
    const player = await prisma.player.findUniqueOrThrow({ where: { slug: 'new-player' } });
    const world = await prisma.world.findUniqueOrThrow({ where: { playerId_code: { playerId: player.id, code: 'new-world' } } });
    const persistedClass = await prisma.contentDefinition.create({ data: {
      worldId: world.id, code: 'persisted-mage', name: 'Mago Persistido', contentType: ContentType.CLASS,
      mechanics: { equipBehavior: 'none' }, status: ContentStatus.ACTIVE,
    } });
    const classLink = {
      definition: { mode: 'reuse', scope: 'world', code: persistedClass.code, contentType: 'class' },
      protagonistLink: { state: 'known', rank: 1, progress: 0, mastery: 0, equipped: false, quantity: 1, metadata: {} },
    };
    const template = campaignInNewWorld('mechanical-reuse', [classLink]);
    const mechanicalConfig = {
      ...template.campaignConfiguration,
      classModel: { mode: 'mechanical', startingClass: 'required', progressionBasis: ['class', 'content'], description: 'Classe mecânica.' },
    };
    const coherent = await post('/api/v1/game/start', {
      ...template, campaignConfiguration: mechanicalConfig, protagonist: { ...template.protagonist, className: persistedClass.name },
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
    const [attributeDefinition, passiveDefinition] = await Promise.all([
      prisma.contentDefinition.create({ data: {
        worldId: world.id, code: 'attribute-gated', name: 'Técnica Intelectual', contentType: ContentType.SKILL,
        mechanics: { equipBehavior: 'activatable' }, requirements: { minimumAttributes: { intellect: 7 } }, status: ContentStatus.ACTIVE,
      } }),
      prisma.contentDefinition.create({ data: {
        worldId: world.id, code: 'passive-reuse', name: 'Passiva Persistida', contentType: ContentType.TALENT,
        mechanics: { equipBehavior: 'none', passive: true }, status: ContentStatus.ACTIVE,
      } }),
      prisma.contentDefinition.create({ data: {
        worldId: otherWorld.id, code: 'foreign-only', name: 'Outro World', contentType: ContentType.SKILL, status: ContentStatus.ACTIVE,
      } }),
      prisma.contentDefinition.create({ data: {
        worldId: world.id, code: 'typed-only', name: 'Mesmo code, outro tipo', contentType: ContentType.SPELL, status: ContentStatus.ACTIVE,
      } }),
    ]);
    const link = { state: 'known', rank: 1, progress: 0, mastery: 0, equipped: false, quantity: 1, metadata: {} };
    const attributeBody = campaignInNewWorld('attribute-reuse', [{
      definition: { mode: 'reuse', scope: 'world', code: attributeDefinition.code, contentType: 'skill' }, protagonistLink: link,
    }]);
    const attributeFailure = await post('/api/v1/game/start', attributeBody);
    expect(attributeFailure.status).toBe(409);
    expect(responseErrorMessage(attributeFailure)).toBe('Initial attribute requirements are not met');

    const passiveBody = campaignInNewWorld('passive-reuse', [{
      definition: { mode: 'reuse', scope: 'world', code: passiveDefinition.code, contentType: 'talent' },
      protagonistLink: { ...link, equipped: true },
    }]);
    const passiveFailure = await post('/api/v1/game/start', passiveBody);
    expect(passiveFailure.status).toBe(409);
    expect(responseErrorMessage(passiveFailure)).toBe('Initial equipment is incompatible with the content definition');

    const foreign = await post('/api/v1/game/start', campaignInNewWorld('foreign-reuse', [{
      definition: { mode: 'reuse', scope: 'world', code: 'foreign-only', contentType: 'skill' }, protagonistLink: link,
    }]));
    expect(foreign.status).toBe(404);
    const wrongType = await post('/api/v1/game/start', campaignInNewWorld('typed-reuse', [{
      definition: { mode: 'reuse', scope: 'world', code: 'typed-only', contentType: 'skill' }, protagonistLink: link,
    }]));
    expect(wrongType.status).toBe(404);

    const unchanged = await prisma.contentDefinition.findUniqueOrThrow({ where: { id: passiveDefinition.id } });
    expect(unchanged).toMatchObject({ name: passiveDefinition.name, mechanics: passiveDefinition.mechanics, updatedAt: passiveDefinition.updatedAt });
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
    } };
    const success = await post('/api/v1/game/start', campaignInNewWorld('override', [overridePackage]));
    expect(success.status).toBe(200);
    expect(bodyRecord(success).linkedContent).toEqual([expect.objectContaining({ code: 'longbow', name: 'Arco Longo da Campanha' })]);

    const missing = structuredStart('missing-override').initialContentPackages[0]!;
    const missingPackage = { ...missing, definition: {
      ...missing.definition, scope: 'campaign', code: 'absent-global', overridesWorldDefinition: true,
    } };
    const failedTemplate = structuredStart('missing-override');
    const failedBody = { ...failedTemplate, initialContentPackages: [missingPackage] };
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
  });

  it('rolls back a global ContentDefinition P2002 without misreporting idempotency', async () => {
    const basePackage = structuredStart('definition-race').initialContentPackages[0]!;
    const sharedPackage = { ...basePackage, definition: { ...basePackage.definition, code: 'race-global-weapon', name: 'Arma Global Concorrente' } };
    const leftBody = campaignInNewWorld('definition-left', [sharedPackage]);
    const rightBody = campaignInNewWorld('definition-right', [sharedPackage]);
    const [left, right] = await Promise.all([post('/api/v1/game/start', leftBody), post('/api/v1/game/start', rightBody)]);
    expect([left.status, right.status].sort()).toEqual([200, 409]);
    const conflict = left.status === 409 ? left : right;
    expect(responseErrorMessage(conflict)).toBe('Resource already exists');
    expect(responseErrorMessage(conflict)).not.toBe('Idempotency key already used');
    await expect(prisma.contentDefinition.count({ where: { world: { code: 'new-world' }, code: sharedPackage.definition.code } })).resolves.toBe(1);
  });

  it('rolls back every record after global reuse, link and technical event failures', async () => {
    const missingGlobalTemplate = structuredStart('missing-global-reuse');
    const missingGlobalBody = { ...missingGlobalTemplate, initialContentPackages: [{
      definition: { mode: 'reuse', scope: 'world', code: 'missing-global', contentType: 'skill' },
      protagonistLink: { state: 'known', rank: 1, progress: 0, mastery: 0, equipped: false, quantity: 1, metadata: {} },
    }] };
    const missingGlobal = await post('/api/v1/game/start', missingGlobalBody);
    expect(missingGlobal.status).toBe(404);
    await expectNoCreatedIntent(missingGlobalBody);

    const newPlayer = await prisma.player.findUniqueOrThrow({ where: { slug: 'new-player' } });
    const newWorld = await prisma.world.findUniqueOrThrow({ where: { playerId_code: { playerId: newPlayer.id, code: 'new-world' } } });
    const passive = await prisma.contentDefinition.create({ data: {
      worldId: newWorld.id, code: 'passive-reuse-test', name: 'Passiva de teste', contentType: ContentType.SKILL,
      mechanics: { equipBehavior: 'none', passive: true }, status: ContentStatus.ACTIVE,
    } });
    const beforeDefinitionCount = await prisma.contentDefinition.count({ where: { worldId: newWorld.id } });
    const linkTemplate = structuredStart('invalid-link');
    const invalidLinkBody = {
      ...linkTemplate, playerMode: 'reuse', playerRef: 'new-player', playerDisplayName: undefined,
      worldMode: 'reuse', worldRef: 'new-world', worldName: undefined, worldDescription: undefined, worldConfiguration: undefined,
      protagonist: { ...linkTemplate.protagonist, code: 'new-player' },
      initialContentPackages: [{
        definition: { mode: 'reuse', scope: 'world', code: 'passive-reuse-test', contentType: 'skill' },
        protagonistLink: { state: 'known', rank: 1, progress: 0, mastery: 0, equipped: true, quantity: 1, metadata: {} },
      }],
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
      return { ...basePackage, definition: {
        ...basePackage.definition, code: `event-${String(index).padStart(2, '0')}-${'x'.repeat(80)}`, name: `Conteúdo ${index}`,
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
      initialContentPackages: eventPackages, initialPremise: '😀'.repeat(500),
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
    await prisma.campaign.create({ data: { worldId: world.id, code: 'empty-campaign', name: 'Empty Campaign' } });
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
    const body = { idempotencyKey: 'integration-actor-orin-001', code: 'orin', name: 'Orin', actorType: 'npc', role: 'Guardião', health: 12, maxHealth: 12, mana: 2, maxMana: 2, appearance: { eyes: 'cinzentos' }, personality: { traits: ['vigilante'] }, metadata: { zeta: 1, alpha: { second: 2, first: 1 } } };
    const reorderedBody = { metadata: { alpha: { first: 1, second: 2 }, zeta: 1 }, personality: { traits: ['vigilante'] }, appearance: { eyes: 'cinzentos' }, maxMana: 2, mana: 2, maxHealth: 12, health: 12, role: 'Guardião', actorType: 'npc', name: 'Orin', code: 'orin', idempotencyKey: 'integration-actor-orin-001' };
    const [first, retry] = await Promise.all([post('/api/v1/actors/upsert', body), post('/api/v1/actors/upsert', reorderedBody)]);
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    await expect(prisma.actor.count({ where: { code: 'orin' } })).resolves.toBe(1);
    await expect(prisma.idempotencyRecord.count({ where: { key: body.idempotencyKey } })).resolves.toBe(1);
    expect(first.body).toMatchObject({ appearance: { eyes: 'cinzentos' }, personality: { traits: ['vigilante'] } });

    const conflict = await post('/api/v1/actors/upsert', { ...body, name: 'Outro Orin' });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({ error: { code: 'CONFLICT', message: 'Idempotency key already used' } });
  });

  it('patches only approved actor mechanics idempotently', async () => {
    const body = { idempotencyKey: 'integration-actor-orin-patch-001', health: 9, xp: 25, attributes: { strength: 7 }, appearance: { hair: 'preto' }, personality: { traits: ['determinado'] }, status: 'active' };
    const first = await patch('/api/v1/actors/orin', body);
    const retry = await patch('/api/v1/actors/orin', body);
    expect(first.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    expect(first.body).toMatchObject({ code: 'orin', health: 9, xp: 25, attributes: { strength: 7 }, appearance: { hair: 'preto' }, personality: { traits: ['determinado'] }, status: 'active' });
    expect(first.body).not.toHaveProperty('id');
  });

  it('upserts a complete content definition idempotently', async () => {
    const body = {
      idempotencyKey: 'integration-content-quiet-step-001', contentType: 'skill', code: 'quiet-step', name: 'Passo Silencioso',
      description: 'Movimento discreto.', mechanics: { effect: 'stealth' }, requirements: { level: 1 }, presentation: { sound: 'none' },
      tags: ['stealth'], schemaVersion: 1, status: 'active',
    };
    const first = await post('/api/v1/content/upsert', body);
    const retry = await post('/api/v1/content/upsert', body);
    expect(first.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    expect(first.body).toMatchObject({ code: 'quiet-step', contentType: 'skill', status: 'active' });
    await expect(prisma.contentDefinition.count({ where: { code: 'quiet-step' } })).resolves.toBe(1);
  });

  it('gets, lists, learns, updates, equips, unequips and removes actor content', async () => {
    const getExisting = await post('/api/v1/actors/ralph/content/manage', { operation: 'get', contentRef: 'wind_breeze_step', contentType: 'skill' });
    const listExisting = await post('/api/v1/actors/ralph/content/manage', { operation: 'list' });
    expect(getExisting.body).toMatchObject({ code: 'wind_breeze_step', state: 'learning' });
    expect(listExisting.body).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'wind_breeze_step' })]));

    const learnBody = { operation: 'learn', contentRef: 'quiet-step', contentType: 'skill', idempotencyKey: 'integration-learn-quiet-step-001', changes: { progress: 5, notes: 'Primeiro treino' } };
    const learn = await post('/api/v1/actors/ralph/content/manage', learnBody);
    const learnRetry = await post('/api/v1/actors/ralph/content/manage', learnBody);
    expect(learn.status).toBe(200);
    expect(learnRetry.body).toEqual(learn.body);
    expect(learn.body).toMatchObject({ code: 'quiet-step', state: 'learning', progress: 5 });

    const update = await post('/api/v1/actors/ralph/content/manage', { operation: 'update', contentRef: 'quiet-step', contentType: 'skill', idempotencyKey: 'integration-update-quiet-step-001', changes: { state: 'known', rank: 2, progress: 30, mastery: 4 } });
    const equip = await post('/api/v1/actors/ralph/content/manage', { operation: 'equip', contentRef: 'quiet-step', contentType: 'skill', idempotencyKey: 'integration-equip-quiet-step-001' });
    const unequip = await post('/api/v1/actors/ralph/content/manage', { operation: 'unequip', contentRef: 'quiet-step', contentType: 'skill', idempotencyKey: 'integration-unequip-quiet-step-001' });
    const remove = await post('/api/v1/actors/ralph/content/manage', { operation: 'remove', contentRef: 'quiet-step', contentType: 'skill', idempotencyKey: 'integration-remove-quiet-step-001' });
    expect(update.body).toMatchObject({ state: 'known', rank: 2, progress: 30, mastery: 4 });
    expect(equip.body).toMatchObject({ equipped: true });
    expect(unequip.body).toMatchObject({ equipped: false });
    expect(remove.body).toMatchObject({ actorRef: 'ralph', contentRef: 'quiet-step', removed: true });
    await expect(prisma.actorContent.count({ where: { contentDefinition: { code: 'quiet-step' } } })).resolves.toBe(0);
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
    const player = await prisma.player.create({ data: { slug: 'scope-player', displayName: 'Scope Player' } });
    const otherPlayer = await prisma.player.create({ data: { slug: 'other-player', displayName: 'Other Player' } });
    const [worldOne, worldTwo] = await Promise.all([
      prisma.world.create({ data: { playerId: player.id, code: 'world-one', name: 'World One', description: 'Primeiro mundo' } }),
      prisma.world.create({ data: { playerId: player.id, code: 'world-two', name: 'World Two', description: 'Segundo mundo' } }),
      prisma.world.create({ data: { playerId: otherPlayer.id, code: 'foreign-world', name: 'Foreign World' } }),
    ]);
    const [campaignOne, campaignTwo] = await Promise.all([
      prisma.campaign.create({ data: { worldId: worldOne.id, code: 'shared-campaign', name: 'Campaign One', status: CampaignStatus.ACTIVE } }),
      prisma.campaign.create({ data: { worldId: worldTwo.id, code: 'shared-campaign', name: 'Campaign Two', status: CampaignStatus.PAUSED } }),
      prisma.campaign.create({ data: { worldId: worldOne.id, code: 'global-campaign', name: 'Global Fallback', status: CampaignStatus.DRAFT } }),
    ]);
    const [actorOne, actorTwo] = await Promise.all([
      prisma.actor.create({ data: { campaignId: campaignOne.id, code: 'shared-hero', name: 'Hero One', actorType: ActorType.CHARACTER, health: 10, maxHealth: 10, mana: 2, maxMana: 2 } }),
      prisma.actor.create({ data: { campaignId: campaignTwo.id, code: 'shared-hero', name: 'Hero Two', actorType: ActorType.CHARACTER, health: 20, maxHealth: 20, mana: 4, maxMana: 4 } }),
    ]);
    const [globalSkill, campaignSkill, campaignSpell, foreignSkill] = await Promise.all([
      prisma.contentDefinition.create({ data: { worldId: worldOne.id, campaignId: null, code: 'shared-power', name: 'Global Skill', contentType: ContentType.SKILL, status: ContentStatus.ACTIVE } }),
      prisma.contentDefinition.create({ data: { worldId: worldOne.id, campaignId: campaignOne.id, code: 'shared-power', name: 'Campaign Skill', contentType: ContentType.SKILL, status: ContentStatus.ACTIVE } }),
      prisma.contentDefinition.create({ data: { worldId: worldOne.id, campaignId: campaignOne.id, code: 'shared-power', name: 'Campaign Spell', contentType: ContentType.SPELL, status: ContentStatus.ACTIVE } }),
      prisma.contentDefinition.create({ data: { worldId: worldTwo.id, campaignId: campaignTwo.id, code: 'shared-power', name: 'Foreign Skill', contentType: ContentType.SKILL, status: ContentStatus.ACTIVE } }),
    ]);
    await Promise.all([
      prisma.actorContent.create({ data: { actorId: actorOne.id, contentDefinitionId: campaignSkill.id, state: ActorContentState.KNOWN } }),
      prisma.actorContent.create({ data: { actorId: actorTwo.id, contentDefinitionId: foreignSkill.id, state: ActorContentState.MASTERED } }),
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
    expect(actorFromOne.body).toMatchObject({ code: 'shared-hero', name: 'Hero One', health: 10 });
    expect(characterFromTwo.body).toMatchObject({ code: 'shared-hero', name: 'Hero Two', health: 20 });
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
    const world = await prisma.world.create({ data: { playerId: player.id, code: 'mundo-cardinal', name: 'Mundo Cardinal' } });
    const campaign = await prisma.campaign.create({ data: { worldId: world.id, code: 'harem-perfeito', name: 'Harém Perfeito', status: CampaignStatus.ACTIVE } });
    await prisma.actor.create({ data: { campaignId: campaign.id, code: 'ralph', name: 'Ralph', actorType: ActorType.CHARACTER, health: 30, maxHealth: 30, mana: 15, maxMana: 15 } });

    const response = await post('/api/v1/game/load', { playerRef: 'ralph', worldRef: 'mundo-cardinal', campaignRef: 'harem-perfeito' });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      player: { ref: 'ralph' }, world: { ref: 'mundo-cardinal' }, campaign: { ref: 'harem-perfeito' },
      protagonist: { code: 'ralph', actorType: 'character' },
    });
    expect(JSON.stringify(response.body)).not.toMatch(/"id"|playerId|worldId|campaignId|actorId/);
  });
});

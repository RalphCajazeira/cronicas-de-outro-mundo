import request from 'supertest';
import { ActorStatus, ActorType } from './generated/prisma/client.js';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import type { AppConfig } from './config/env.js';
import type { ActorRepository } from './modules/actors/actors.types.js';
import type { ContentRepository } from './modules/content/content.types.js';
import type { GptRepository } from './modules/gpt/gpt.types.js';
import type { ReadinessCheck } from './modules/health/health.routes.js';
import { getOfficialContract } from './modules/openapi/openapi.routes.js';
import type { AuditLogWriter, HttpAuditRecord } from './shared/http/request-audit.js';
import { actorMechanicalSheetFixture } from '../tests/support/actor-mechanics-fixture.js';
import { getInitialAttributePreset } from './modules/rules/core-v1/index.js';
import { actorContentFixture, publishedContentFixture, skillPublicationInput } from '../tests/support/content-fixture.js';

const config: AppConfig = { NODE_ENV: 'test', HOST: '0.0.0.0', PORT: 3000, DATABASE_URL: 'postgresql://test:test@localhost:5432/test', DIRECT_URL: 'postgresql://test:test@localhost:5432/test', RPG_API_KEY: 'test-key' };
const primaryAttributes = getInitialAttributePreset('balanced');
const mechanicalSheet = actorMechanicalSheetFixture(primaryAttributes);
const actor = { id: '7e7b7cbe-5767-47de-a0b5-4b7bc9365c89', code: 'ralph', name: 'Ralph', actorType: ActorType.CHARACTER, species: null, className: 'Aventureiro', role: null, description: null, level: 1, xp: 0, gold: 0, appearance: {}, personality: {}, metadata: {}, status: ActorStatus.ACTIVE, mechanicalSheet };
const contentItem = actorContentFixture();
const definition = publishedContentFixture();
const scope = { playerRef: 'ralph', worldRef: 'elarion', campaignRef: 'main-campaign' };
const scopeQuery = 'playerRef=ralph&worldRef=elarion&campaignRef=main-campaign';
const startGameBody = {
  ...scope, idempotencyKey: 'start-game-http-001', playerMode: 'create', playerDisplayName: 'Ralph',
  worldMode: 'create', worldName: 'Novo Mundo', worldDescription: 'Descrição privada do mundo.',
  worldConfiguration: {
    schemaVersion: 1, genres: ['fantasy'], setting: 'Reinos.', era: 'medieval',
    technologyLevel: { grade: 'preindustrial' }, magicLevel: { grade: 'high' }, worldTone: ['heroic'],
  },
  campaignName: 'Nova Campanha',
  campaignConfiguration: {
    schemaVersion: 1, difficulty: { preset: 'standard', overrides: { opponentCunning: 4 } }, progressionPace: 'standard',
    narrativeTone: ['heroic'], focus: ['exploration'], playerFreedom: 'open', consequenceLevel: 'serious',
    classModel: { mode: 'identity', startingClass: 'optional', progressionBasis: ['content'], description: 'Identidade narrativa.' },
  },
  protagonist: {
    code: 'ralph', name: 'Ralph', actorType: 'character', primaryAttributes,
    appearance: { summary: 'Descrição privada.' }, personality: { summary: 'Personalidade privada.' },
  },
  initialContentPackages: [{
    definition: {
      mode: 'create', scope: 'world', contentType: 'weapon', code: 'longbow', name: 'Arco', description: 'Descrição privada.',
      profile: {
        schemaVersion: 1, rulesetCode: 'core-v1', profileMode: 'mechanical', contentKind: 'weapon',
        code: 'longbow', name: 'Arco', description: 'Descrição privada.', lore: 'segredo narrativo', presentation: {}, tags: ['weapon'],
        tier: 1, rarity: 'common', activation: { type: 'active' }, cost: { type: 'none' }, actionProfile: 'bow',
        targeting: { type: 'single_target', rangeBand: 'far', maxTargets: 1 },
        damageComponents: [{ id: 'arrow', channel: 'physical', element: null, baseDamage: 3, scaling: 'full', canCrit: true }],
        handedness: 'two_handed', weaponTags: ['bow'],
      }, presentation: {}, tags: ['weapon'], status: 'active',
    },
    protagonistLink: { state: 'known', rank: 0, progress: 0, mastery: 0, equipped: true, quantity: 1, metadata: { slotHint: 'hands' } },
  }],
  initialPremise: 'Premissa narrativa privada.',
};
const emptyGptRepository: GptRepository = {
  loadGame: () => Promise.resolve({}), listPlayerWorlds: () => Promise.resolve([]), listWorldCampaigns: () => Promise.resolve([]),
  startGame: () => Promise.resolve({}), listCampaignActors: () => Promise.resolve([]), upsertActor: () => Promise.resolve({}),
  patchActor: () => Promise.resolve({}), upsertContent: () => Promise.resolve({}), manageActorContent: () => Promise.resolve({}), createEvent: () => Promise.resolve({}),
};

function appWith(
  actorRepository: ActorRepository = { findByReference: () => Promise.resolve(actor), listContent: () => Promise.resolve([contentItem]) },
  contentRepository: ContentRepository = { findByReference: () => Promise.resolve(definition) },
  gptRepository: GptRepository = {
    loadGame: (input) => Promise.resolve({ ...input, protagonist: { code: 'ralph' } }),
    listPlayerWorlds: () => Promise.resolve([{ ref: 'elarion', name: 'Elarion', description: null }]),
    listWorldCampaigns: () => Promise.resolve([{ ref: 'main-campaign', name: 'Campanha Principal', status: 'active', currentTime: null, hasProtagonist: true }]),
    startGame: (input) => Promise.resolve({ player: { ref: input.playerRef }, world: { ref: input.worldRef }, campaign: { ref: input.campaignRef }, protagonist: input.protagonist }),
    listCampaignActors: () => Promise.resolve([{ code: 'ralph', actorType: 'character' }]),
    upsertActor: (input) => Promise.resolve({ code: input.code, name: input.name, actorType: input.actorType }),
    patchActor: (actorRef, input) => Promise.resolve({ code: actorRef, name: input.name }),
    upsertContent: (input) => Promise.resolve({ code: input.code, contentType: input.contentType }),
    manageActorContent: (_actorRef, input) => Promise.resolve({ operation: input.operation, state: input.changes?.state ?? 'known' }),
    createEvent: (input) => Promise.resolve({ eventType: input.eventType, title: input.title }),
  },
  readiness: ReadinessCheck = { check: () => Promise.resolve(true) },
  auditLog?: AuditLogWriter,
) {
  return createApp(config, {
    actorRepository, contentRepository, gptRepository, readiness,
    ...(auditLog === undefined ? {} : { auditLog }),
  });
}

describe('HTTP API', () => {
  it('returns health without authentication', async () => { const response = await request(appWith()).get('/health'); expect(response.status).toBe(200); expect(response.body).toEqual({ status: 'ok' }); });
  it('returns safe readiness states without authentication', async () => {
    const ready = await request(appWith()).get('/health/ready');
    const notReady = await request(appWith(undefined, undefined, undefined, { check: () => Promise.reject(new Error('postgresql://secret/internal')) })).get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: 'ready' });
    expect(notReady.status).toBe(503);
    expect(notReady.body).toEqual({ status: 'not_ready' });
    expect(JSON.stringify(notReady.body)).not.toContain('secret');
  });
  it('serves OpenAPI publicly with the configured base URL', async () => {
    const response = await request(createApp({ ...config, PUBLIC_BASE_URL: 'https://rpg.example.com' }, {
      actorRepository: { findByReference: () => Promise.resolve(actor), listContent: () => Promise.resolve([]) },
      contentRepository: { findByReference: () => Promise.resolve(definition) },
      gptRepository: emptyGptRepository,
      readiness: { check: () => Promise.resolve(true) },
    })).get('/openapi.json');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ servers: [{ url: 'https://rpg.example.com' }] });
    expect(getOfficialContract()).toMatchObject({ servers: [{ url: 'https://api.example.com' }] });
  });
  it('rejects a private route without x-rpg-key', async () => { expect((await request(appWith()).get(`/api/v1/characters/ralph?${scopeQuery}`)).status).toBe(401); });
  it('rejects a private route with the wrong x-rpg-key', async () => { expect((await request(appWith()).get(`/api/v1/characters/ralph?${scopeQuery}`).set('x-rpg-key', 'wrong-key')).status).toBe(401); });
  it('reaches the controller with a valid key and normalizes a character', async () => { const response = await request(appWith()).get(`/api/v1/characters/ralph?${scopeQuery}`).set('x-rpg-key', 'test-key'); expect(response.status).toBe(200); expect(response.body).toEqual({ code: 'ralph', name: 'Ralph', actorType: 'character', species: null, className: 'Aventureiro', role: null, description: null, level: 1, xp: 0, gold: 0, appearance: {}, personality: {}, metadata: {}, status: 'active', ...mechanicalSheet }); expect(response.body).not.toHaveProperty('id'); expect(JSON.stringify(response.body)).not.toMatch(/inputHash|rulesetVersionId|[0-9a-f]{8}-[0-9a-f-]{27}/); });
  it('validates an invalid characterRef', async () => { expect((await request(appWith()).get(`/api/v1/characters/not%20valid?${scopeQuery}`).set('x-rpg-key', 'test-key')).status).toBe(400); });
  it('returns 404 for a missing character', async () => { const repository: ActorRepository = { findByReference: () => Promise.resolve(null), listContent: () => Promise.resolve(null) }; expect((await request(appWith(repository)).get(`/api/v1/characters/missing?${scopeQuery}`).set('x-rpg-key', 'test-key')).status).toBe(404); });
  it('normalizes character content', async () => { const response = await request(appWith()).get(`/api/v1/characters/ralph/content?${scopeQuery}`).set('x-rpg-key', 'test-key'); expect(response.status).toBe(200); expect(response.body).toEqual([expect.objectContaining({ code: 'wind_breeze_step', contentType: 'skill', state: 'learning', status: 'active', progress: 10, notes: 'Treino inicial com Lyra', versionNumber: 1 })]); expect(JSON.stringify(response.body)).not.toContain('contentDefinition'); });
  it('normalizes content and omits raw Prisma fields', async () => { const response = await request(appWith()).get(`/api/v1/content/wind_breeze_step?${scopeQuery}&contentType=skill`).set('x-rpg-key', 'test-key'); expect(response.status).toBe(200); expect(response.body).toMatchObject({ code: 'wind_breeze_step', contentType: 'skill', status: 'active' }); expect(response.body).not.toHaveProperty('id'); expect(response.body).not.toHaveProperty('worldId'); });
  it('returns a contract-safe 404 for a missing content definition', async () => { const repository: ContentRepository = { findByReference: () => Promise.resolve(null) }; const response = await request(appWith(undefined, repository)).get(`/api/v1/content/missing?${scopeQuery}&contentType=skill`).set('x-rpg-key', 'test-key'); expect(response.status).toBe(404); expect(response.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Content not found' } }); });
  it('does not expose repository errors', async () => { const repository: ActorRepository = { findByReference: () => Promise.reject(new Error('postgresql://secret@remote/internal Prisma failure')), listContent: () => Promise.resolve([]) }; const response = await request(appWith(repository)).get(`/api/v1/actors/ralph?${scopeQuery}`).set('x-rpg-key', 'test-key'); expect(response.status).toBe(500); expect(JSON.stringify(response.body)).not.toContain('Prisma'); expect(JSON.stringify(response.body)).not.toContain('secret'); });
  it('requires explicit scope when loading the protected GPT API', async () => {
    const missingScope = await request(appWith()).post('/api/v1/game/load').set('x-rpg-key', 'test-key').send({});
    const response = await request(appWith()).post('/api/v1/game/load').set('x-rpg-key', 'test-key').send(scope);
    expect(missingScope.status).toBe(400);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ playerRef: 'ralph', worldRef: 'elarion', campaignRef: 'main-campaign' });
  });
  it('requires explicit scope on preserved reads and discovers worlds and campaigns without IDs', async () => {
    const missingScope = await request(appWith()).get('/api/v1/actors/ralph').set('x-rpg-key', 'test-key');
    const worlds = await request(appWith()).get('/api/v1/players/ralph/worlds').set('x-rpg-key', 'test-key');
    const campaigns = await request(appWith()).get('/api/v1/players/ralph/worlds/elarion/campaigns').set('x-rpg-key', 'test-key');
    expect(missingScope.status).toBe(400);
    expect(worlds.body).toEqual([{ ref: 'elarion', name: 'Elarion', description: null }]);
    expect(campaigns.body).toEqual([{ ref: 'main-campaign', name: 'Campanha Principal', status: 'active', currentTime: null, hasProtagonist: true }]);
    expect(JSON.stringify([worlds.body, campaigns.body])).not.toMatch(/"id"|playerId|worldId/);
  });
  it('starts a complete new game scope through one protected idempotent contract', async () => {
    const response = await request(appWith()).post('/api/v1/game/start').set('x-rpg-key', 'test-key').send(startGameBody);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      player: { ref: 'ralph' }, world: { ref: 'elarion' }, campaign: { ref: 'main-campaign' },
      protagonist: { code: 'ralph', actorType: 'character' },
    });
  });
  it('rejects a startGame payload above the domain limit before repository persistence', async () => {
    const repository = { ...emptyGptRepository, startGame: () => Promise.reject(new Error('repository must not be reached')) };
    const firstPackage = startGameBody.initialContentPackages[0]!;
    const oversized = { ...startGameBody, initialContentPackages: Array.from({ length: 24 }, (_, index) => {
      const code = `oversized-${String(index).padStart(2, '0')}`;
      const name = `Oversized ${index}`;
      return {
        ...firstPackage,
        definition: {
          ...firstPackage.definition, code, name,
          profile: { ...firstPackage.definition.profile, code, name, lore: '😀'.repeat(800) },
        },
      };
    }) };
    const response = await request(appWith(undefined, undefined, repository)).post('/api/v1/game/start').set('x-rpg-key', 'test-key').send(oversized);
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: 'INVALID_INPUT', issues: [expect.objectContaining({ path: '$' })] } });
  });
  it('audits structured startGame counts without narrative or mechanical values', async () => {
    const records: HttpAuditRecord[] = [];
    const response = await request(appWith(undefined, undefined, undefined, undefined, (record) => records.push(record)))
      .post('/api/v1/game/start').set('x-rpg-key', 'test-key').send(startGameBody);
    expect(response.status).toBe(200);
    expect(records[0]?.request).toMatchObject({ body: {
      playerMode: 'create', worldMode: 'create', playerRef: 'ralph', worldRef: 'elarion', campaignRef: 'main-campaign',
      difficultyPreset: 'standard',
      initialContent: { packageCount: 1, linkCount: 1, equippedCount: 1, contentTypes: { weapon: 1 } },
      protagonist: { attributeCount: 9 },
    } });
    expect(records[0]?.response).toMatchObject({ attributeCount: 9 });
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain('Premissa narrativa privada');
    expect(serialized).not.toContain('Descrição privada');
    expect(serialized).not.toContain('Personalidade privada');
    expect(serialized).not.toContain('segredo narrativo');
    expect(serialized).not.toContain('start-game-http-001');
    expect(serialized).not.toContain('"strength"');
  });
  it('lists campaign actors and supports actor upsert and approved patch fields', async () => {
    const list = await request(appWith()).get('/api/v1/campaigns/main-campaign/actors?playerRef=ralph&worldRef=elarion').set('x-rpg-key', 'test-key');
    const upsert = await request(appWith()).post('/api/v1/actors/upsert').set('x-rpg-key', 'test-key').send({ ...scope, idempotencyKey: 'actor-create-001', code: 'orin', name: 'Orin', actorType: 'npc', primaryAttributes });
    const patchResponse = await request(appWith()).patch('/api/v1/actors/orin').set('x-rpg-key', 'test-key').send({ ...scope, idempotencyKey: 'actor-patch-001', name: 'Orin Renomeado' });
    const rejectedMechanicalPatch = await request(appWith()).patch('/api/v1/actors/orin').set('x-rpg-key', 'test-key').send({ ...scope, idempotencyKey: 'actor-patch-002', health: 7 });
    expect(list.body).toEqual([{ code: 'ralph', actorType: 'character' }]);
    expect(upsert.body).toMatchObject({ code: 'orin', actorType: 'npc' });
    expect(patchResponse.body).toMatchObject({ code: 'orin', name: 'Orin Renomeado' });
    expect(rejectedMechanicalPatch.status).toBe(400);
  });
  it('rejects arbitrary actor relation fields', async () => {
    const response = await request(appWith()).patch('/api/v1/actors/ralph').set('x-rpg-key', 'test-key').send({ ...scope, idempotencyKey: 'actor-patch-002', campaignId: 'forbidden' });
    expect(response.status).toBe(400);
  });
  it('upserts content and validates actor-content idempotency for writes', async () => {
    const content = await request(appWith()).post('/api/v1/content/upsert').set('x-rpg-key', 'test-key').send({
      ...scope, idempotencyKey: 'content-upsert-001', ...skillPublicationInput(),
    });
    const invalidManage = await request(appWith()).post('/api/v1/actors/ralph/content/manage').set('x-rpg-key', 'test-key').send({ ...scope, operation: 'learn', contentRef: 'quiet-step', contentType: 'skill' });
    const manage = await request(appWith()).post('/api/v1/actors/ralph/content/manage').set('x-rpg-key', 'test-key').send({ ...scope, operation: 'learn', contentRef: 'quiet-step', contentType: 'skill', idempotencyKey: 'learn-quiet-step-001' });
    expect(content.status).toBe(200);
    expect(content.body).toMatchObject({ code: 'quiet-step', contentType: 'skill' });
    expect(invalidManage.status).toBe(400);
    expect(manage.body).toMatchObject({ operation: 'learn' });
  });
  it('registers events and requires authentication before input validation', async () => {
    const unauthorized = await request(appWith()).post('/api/v1/events').send({});
    const event = await request(appWith()).post('/api/v1/events').set('x-rpg-key', 'test-key').send({ ...scope, eventType: 'scene-ended', title: 'Cena encerrada', payload: {}, idempotencyKey: 'event-scene-001' });
    expect(unauthorized.status).toBe(401);
    expect(event.body).toMatchObject({ eventType: 'scene-ended', title: 'Cena encerrada' });
  });
  it('audits a GPT write with safe request and response summaries', async () => {
    const records: HttpAuditRecord[] = [];
    const response = await request(appWith(undefined, undefined, undefined, undefined, (record) => records.push(record)))
      .post('/api/v1/actors/ralph/content/manage')
      .set('x-rpg-key', 'test-key')
      .send({
        ...scope, operation: 'update', contentRef: 'wind_breeze_step', contentType: 'skill', idempotencyKey: 'persist-secret-key-001',
        changes: { state: 'learning', progress: 20, notes: 'private narrative secret', metadata: { hidden: 'sensitive value' } },
      });

    expect(response.status).toBe(200);
    expect(records).toHaveLength(1);
    expect(response.headers['x-request-id']).toBe(records[0]?.requestId);
    expect(records[0]).toMatchObject({
      event: 'http_request_completed', source: 'gpt_api', method: 'POST', path: '/api/v1/actors/ralph/content/manage', statusCode: 200,
      request: {
        body: {
          operation: 'update', contentRef: 'wind_breeze_step', contentType: 'skill',
          idempotency: { length: 22 },
          changes: { state: 'learning', progress: 20, notesPresent: true, metadataKeys: ['hidden'] },
        },
      },
      response: { kind: 'object', operation: 'update', state: 'learning' },
    });
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain('test-key');
    expect(serialized).not.toContain('persist-secret-key-001');
    expect(serialized).not.toContain('private narrative secret');
    expect(serialized).not.toContain('sensitive value');
  });
  it('audits validation issue paths without rejected values or authentication headers', async () => {
    const records: HttpAuditRecord[] = [];
    const response = await request(appWith(undefined, undefined, undefined, undefined, (record) => records.push(record)))
      .post('/api/v1/actors/ralph/content/manage')
      .set('x-rpg-key', 'test-key')
      .send({ ...scope, operation: 'update', contentRef: 'wind_breeze_step', contentType: 'skill', changes: { progress: 20 } });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: {
        code: 'INVALID_INPUT', retryable: true,
        issues: [expect.objectContaining({ path: 'idempotencyKey', message: 'Required for write operations' })],
      },
    });
    expect(JSON.stringify(response.body)).toContain('retry once');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      statusCode: 400,
      response: { error: { code: 'INVALID_INPUT' } },
      error: { type: 'validation', code: 'INVALID_INPUT', issues: [expect.objectContaining({ path: 'idempotencyKey' })] },
    });
    expect(JSON.stringify(records)).not.toContain('test-key');
  });
  it('does not echo rejected field values in validation responses or audit logs', async () => {
    const records: HttpAuditRecord[] = [];
    const response = await request(appWith(undefined, undefined, undefined, undefined, (record) => records.push(record)))
      .post('/api/v1/actors/ralph/content/manage')
      .set('x-rpg-key', 'test-key')
      .send({ ...scope, operation: 'list', unexpected: 'private rejected value' });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { issues: [expect.objectContaining({ path: '$', message: 'Remove unsupported fields: unexpected' })] },
    });
    expect(JSON.stringify(response.body)).not.toContain('private rejected value');
    expect(JSON.stringify(records)).not.toContain('private rejected value');
  });
});

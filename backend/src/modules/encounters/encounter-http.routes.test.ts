import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import type { AppConfig } from '../../config/env.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { HttpAuditRecord } from '../../shared/http/request-audit.js';
import type { EncounterPublicDto } from './encounter-http.dto.js';
import type { EncounterHttpService } from './encounter-http.service.js';

const config: AppConfig = { NODE_ENV: 'test', HOST: '0.0.0.0', PORT: 3000, DATABASE_URL: 'postgresql://test:test@localhost:5432/test', DIRECT_URL: 'postgresql://test:test@localhost:5432/test', RPG_API_KEY: 'test-key' };
const scope = { playerRef: 'player', worldRef: 'world', campaignRef: 'campaign', encounterRef: 'encounter' };
const result: EncounterPublicDto = {
  result: 'encounter_loaded', operation: 'load', encounterRef: 'encounter', lifecycleStatus: 'awaiting_intent', stateVersion: 1,
  currentTick: '0', stopReason: null, completionCandidate: null,
  participants: [{ actorRef: 'hero', bindingKind: 'persisted_actor', sideRef: 'party', combatState: 'ready', zone: 'near', resources: { hp: { current: 10, maximum: 10 }, mana: { current: 5, maximum: 5 }, sp: { current: 4, maximum: 4 } } }],
  nextRequiredAction: { type: 'submit_intent', actors: [{ actorRef: 'hero', readySlotRefs: ['primary'] }] },
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function app(service: EncounterHttpService, audit?: (record: HttpAuditRecord) => void, appConfig: AppConfig = config) {
  return createApp(appConfig, {
    actorRepository: { findByReference: () => Promise.resolve(null), listContent: () => Promise.resolve(null) },
    contentRepository: { findByReference: () => Promise.resolve(null) },
    gptRepository: {
      loadGame: () => Promise.resolve({}), listPlayerWorlds: () => Promise.resolve([]), listWorldCampaigns: () => Promise.resolve([]),
      startGame: () => Promise.resolve({}), listCampaignActors: () => Promise.resolve([]), upsertActor: () => Promise.resolve({}),
      patchActor: () => Promise.resolve({}), upsertContent: () => Promise.resolve({}), manageActorContent: () => Promise.resolve({}),
      manageActorInventory: () => Promise.resolve({}), manageActorProgression: () => Promise.resolve({}),
      createEvent: () => Promise.resolve({}), resolveActorEffect: () => Promise.resolve({}),
    },
    readiness: { check: () => Promise.resolve(true) }, encounterHttpService: service,
    ...(audit === undefined ? {} : { auditLog: audit }),
  });
}

describe('manageEncounter HTTP route', () => {
  it('authenticates before parsing and returns retryable false for invalid input', async () => {
    const service = { manage: vi.fn(() => Promise.resolve(result)) };
    const unauthorized = await request(app(service)).post('/api/v1/encounters/manage').send({});
    const wrongKey = await request(app(service)).post('/api/v1/encounters/manage').set('x-rpg-key', 'wrong-key').send({});
    const invalid = await request(app(service)).post('/api/v1/encounters/manage').set('x-rpg-key', 'test-key').send({ operation: 'load', ...scope, rolls: [10] });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.body).toEqual({ error: { code: 'UNAUTHORIZED', message: 'Invalid API key', retryable: false } });
    expect(wrongKey.body).toEqual(unauthorized.body);
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ error: { code: 'INVALID_INPUT', retryable: false, recoveryAction: 'correct_request' } });
    expect(service.manage).not.toHaveBeenCalled();
  });

  it.each([
    { operation: 'create', ...scope, idempotencyKey: 'create-key-001', participants: [{ actorRef: 'hero', sideRef: 'party', zone: 'near' }] },
    { operation: 'load', ...scope },
    { operation: 'submit_intent', ...scope, idempotencyKey: 'intent-key-001', expectedStateVersion: 1, intent: { actorRef: 'hero', slotRef: 'primary', actionSource: 'content', targetSelector: 'self', contentRef: { scope: 'campaign', contentType: 'skill', code: 'focus', versionNumber: 1 } } },
    { operation: 'resolve_reaction', ...scope, idempotencyKey: 'reaction-key-001', expectedStateVersion: 1, reactorRef: 'hero', reactionKind: 'block' },
    { operation: 'continue', ...scope, idempotencyKey: 'continue-key-001', expectedStateVersion: 1 },
    { operation: 'confirm_completion', ...scope, idempotencyKey: 'complete-key-001', expectedStateVersion: 1 },
    { operation: 'cancel', ...scope, idempotencyKey: 'cancel-key-001', expectedStateVersion: 1 },
  ])('accepts and dispatches $operation', async (body) => {
    const service = { manage: vi.fn(() => Promise.resolve(result)) };
    const response = await request(app(service)).post('/api/v1/encounters/manage').set('x-rpg-key', 'test-key').send(body);
    expect(response.status).toBe(200);
    expect(service.manage).toHaveBeenCalledWith(expect.objectContaining({ operation: body.operation }));
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each([
    [new AppError(409, 'STATE_VERSION_CONFLICT', 'Encounter state version does not match', { retryable: false, recoveryAction: 'load_encounter' }), 409, 'STATE_VERSION_CONFLICT'],
    [new AppError(409, 'ENCOUNTER_ALREADY_OPEN', 'Campaign already has an open encounter', { retryable: false, recoveryAction: 'load_encounter' }), 409, 'ENCOUNTER_ALREADY_OPEN'],
    [new AppError(409, 'ENCOUNTER_LIFECYCLE_CONFLICT', 'Encounter lifecycle conflict', { retryable: false, recoveryAction: 'load_encounter' }), 409, 'ENCOUNTER_LIFECYCLE_CONFLICT'],
    [new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key reused', { retryable: false, recoveryAction: 'use_new_idempotency_key' }), 409, 'IDEMPOTENCY_KEY_REUSED'],
    [new AppError(422, 'ACTION_REJECTED', 'Encounter action rejected', { retryable: false, recoveryAction: 'choose_new_intent' }), 422, 'ACTION_REJECTED'],
    [new AppError(500, 'ENCOUNTER_INTEGRITY_ERROR', 'Encounter integrity validation failed', { retryable: false, recoveryAction: 'stop_encounter_flow' }), 500, 'ENCOUNTER_INTEGRITY_ERROR'],
    [new AppError(503, 'TEMPORARY_UNAVAILABLE', 'Encounter operation is temporarily unavailable', { retryable: true, recoveryAction: 'retry_same_request' }), 503, 'TEMPORARY_UNAVAILABLE'],
    [new Error('Prisma postgresql://secret SQL'), 500, 'INTERNAL_ERROR'],
  ] as const)('sanitizes service failure %#', async (error, status, code) => {
    const service: EncounterHttpService = { manage: () => Promise.reject(error) };
    const response = await request(app(service)).post('/api/v1/encounters/manage').set('x-rpg-key', 'test-key').send({ operation: 'load', ...scope });
    expect(response.status).toBe(status);
    expect(record(record(response.body).error).code).toBe(code);
    expect(JSON.stringify(response.body)).not.toMatch(/Prisma|postgres|secret|SQL/);
  });

  it('audits only the explicit encounter allowlist and excludes sentinel payload and response values', async () => {
    const records: HttpAuditRecord[] = [];
    const service: EncounterHttpService = { manage: () => Promise.resolve({
      ...result, result: 'processing_paused', lifecycleStatus: 'processing_paused', stateVersion: 2,
      nextRequiredAction: { type: 'continue' },
      transitionSummary: {
        processedEventCount: 1, visibleEventCount: 1, eventsTruncated: false,
        actorsActed: ['private-target-sentinel'],
        events: [{ category: 'damage_applied', actorRef: 'private-target-sentinel' }],
        changes: [{ actorRef: 'private-target-sentinel', categories: ['damage_applied'], resources: { hp: { before: 99991, after: 99990, delta: -1 } } }],
      },
    }) };
    const response = await request(app(service, (record) => records.push(record)))
      .post('/api/v1/encounters/manage').set('x-rpg-key', 'test-key')
      .send({ operation: 'submit_intent', ...scope, idempotencyKey: 'idempotency-secret-sentinel', expectedStateVersion: 1, intent: { actorRef: 'hero', slotRef: 'primary', actionSource: 'basic_weapon_attack', targetSelector: 'explicit', targetRefs: ['private-target-sentinel'], inventoryEntryRef: 'inventory-secret-sentinel' } });
    expect(response.status).toBe(200);
    expect(records[0]).toMatchObject({
      operationId: 'manageEncounter', statusCode: 200,
      encounter: { operation: 'submit_intent', encounterRef: 'encounter', result: 'processing_paused', lifecycleStatus: 'processing_paused', stateVersion: 2, expectedStateVersion: 1, processedEventCount: 1, sourceActorRef: 'hero' },
    });
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain('idempotency-secret-sentinel');
    expect(serialized).not.toContain('private-target-sentinel');
    expect(serialized).not.toContain('inventory-secret-sentinel');
    expect(serialized).not.toContain('99991');
  });

  it('audits terminal consequences only as outcome, counts and event type', async () => {
    const records: HttpAuditRecord[] = [];
    const service: EncounterHttpService = { manage: () => Promise.resolve({
      ...result, result: 'encounter_completed', lifecycleStatus: 'completed', stateVersion: 2,
      completionCandidate: 'party_victory_candidate', nextRequiredAction: { type: 'none' },
      consequencesSummary: {
        schemaVersion: 1, outcome: 'party_victory',
        actorChanges: [{ actorRef: 'private-actor-sentinel', statusBefore: 'active', statusAfter: 'defeated' }],
        removedEncounterEffects: [{ actorRef: 'private-actor-sentinel', count: 3 }],
        persistentEvent: { eventType: 'encounter-completed', actorRef: 'private-actor-sentinel' },
      },
    }) };
    const response = await request(app(service, (record) => records.push(record)))
      .post('/api/v1/encounters/manage').set('x-rpg-key', 'test-key')
      .send({ operation: 'confirm_completion', ...scope, idempotencyKey: 'private-key-sentinel', expectedStateVersion: 1 });
    expect(response.status).toBe(200);
    expect(records[0]).toMatchObject({
      encounter: {
        operation: 'confirm_completion', outcome: 'party_victory', actorChangeCount: 1,
        removedEncounterEffectCount: 3, eventType: 'encounter-completed',
      },
    });
    expect(JSON.stringify(records)).not.toMatch(/private-actor-sentinel|private-key-sentinel/);
  });

  it('audits automatic budgets and stop semantics without policy or narrative payloads', async () => {
    const records: HttpAuditRecord[] = [];
    const service: EncounterHttpService = { manage: () => Promise.resolve({
      ...result,
      operation: 'resolve_beat',
      result: 'processing_paused',
      lifecycleStatus: 'processing_paused',
      stateVersion: 9,
      nextRequiredAction: { type: 'continue' },
      batchSummary: {
        mode: 'automatic',
        startingStateVersion: 3,
        endingStateVersion: 9,
        beatsProcessed: 6,
        actionsResolved: 18,
        actorsActed: [],
        stopReason: 'processing_limit',
        stopCategory: 'technical',
        requiresPlayerDecision: false,
        decisionReason: null,
        availableAlternatives: [],
        terminalCandidate: null,
        narrativeFacts: ['private-narrative-sentinel'],
      },
    }) };
    const response = await request(app(service, (record) => records.push(record)))
      .post('/api/v1/encounters/manage').set('x-rpg-key', 'test-key')
      .send({
        operation: 'resolve_beat',
        ...scope,
        idempotencyKey: 'automatic-audit-key',
        expectedStateVersion: 3,
        policy: {
          actorRef: 'hero',
          mode: 'until_decision',
          strategy: 'balanced',
          objective: 'private-objective-sentinel',
          maximumBeats: 6,
        },
      });
    expect(response.status).toBe(200);
    expect(records[0]).toMatchObject({
      operationId: 'manageEncounter',
      encounter: {
        operation: 'resolve_beat',
        mode: 'automatic',
        beatsProcessed: 6,
        actionsResolved: 18,
        stopReason: 'processing_limit',
        stopCategory: 'technical',
        requiresPlayerDecision: false,
      },
      performance: { operation: 'manageEncounter', outcome: 'commit', queryCount: 0 },
    });
    expect(JSON.stringify(records)).not.toMatch(/private-objective-sentinel|private-narrative-sentinel|automatic-audit-key/);
  });

  it.each([
    ['auth', undefined, 401, 'UNAUTHORIZED'],
    ['zod', undefined, 400, 'INVALID_INPUT'],
    ['conflict', new AppError(409, 'STATE_VERSION_CONFLICT', 'Conflict', { retryable: false }), 409, 'STATE_VERSION_CONFLICT'],
    ['rejected', new AppError(422, 'ACTION_REJECTED', 'Rejected', { retryable: false }), 422, 'ACTION_REJECTED'],
    ['integrity', new AppError(500, 'ENCOUNTER_INTEGRITY_ERROR', 'Integrity', { retryable: false }), 500, 'ENCOUNTER_INTEGRITY_ERROR'],
    ['temporary', new AppError(503, 'TEMPORARY_UNAVAILABLE', 'Temporary', { retryable: true }), 503, 'TEMPORARY_UNAVAILABLE'],
  ] as const)('keeps %s audit failures allowlisted and sentinel-free', async (kind, failure, status, code) => {
    const records: HttpAuditRecord[] = [];
    const service: EncounterHttpService = {
      manage: () => failure === undefined ? Promise.resolve(result) : Promise.reject(failure),
    };
    const secretConfig = { ...config, RPG_API_KEY: 'api-key-secret-sentinel' };
    const agent = request(app(service, (auditRecord) => records.push(auditRecord), secretConfig))
      .post('/api/v1/encounters/manage');
    const response = kind === 'auth'
      ? await agent.set('x-rpg-key', 'wrong-key-secret-sentinel').send({ operation: 'load', ...scope })
      : kind === 'zod'
        ? await agent.set('x-rpg-key', secretConfig.RPG_API_KEY).send({
          operation: 'load', ...scope, idempotencyKey: 'idempotency-error-secret-sentinel',
        })
        : await agent.set('x-rpg-key', secretConfig.RPG_API_KEY).send({
          operation: 'continue', ...scope, idempotencyKey: 'idempotency-error-secret-sentinel',
          expectedStateVersion: 7,
        });
    expect(response.status).toBe(status);
    expect(record(record(response.body).error).code).toBe(code);
    expect(records).toHaveLength(1);
    const serialized = JSON.stringify(records);
    expect(serialized).not.toMatch(/api-key-secret-sentinel|wrong-key-secret-sentinel|idempotency-error-secret-sentinel/);
    if (!['auth', 'zod'].includes(kind)) {
      expect(records[0]).toMatchObject({
        operationId: 'manageEncounter', encounter: { operation: 'continue', expectedStateVersion: 7 },
      });
    }
  });

  it('audits integrity mismatch categories without exposing them in the public error', async () => {
    const records: HttpAuditRecord[] = [];
    const failure = new AppError(500, 'ENCOUNTER_INTEGRITY_ERROR', 'Integrity', {
      retryable: false,
      recoveryAction: 'stop_encounter_flow',
      auditCode: 'ENCOUNTER_DENORMALIZED_DRIFT',
      auditCategories: ['stateVersion', 'operation'],
    });
    const service: EncounterHttpService = { manage: () => Promise.reject(failure) };
    const response = await request(app(service, (auditRecord) => records.push(auditRecord)))
      .post('/api/v1/encounters/manage')
      .set('x-rpg-key', config.RPG_API_KEY)
      .send({
        operation: 'continue',
        ...scope,
        idempotencyKey: 'integrity-audit-categories',
        expectedStateVersion: 7,
      });
    expect(response.status).toBe(500);
    expect(response.body).not.toHaveProperty('error.mismatchCategories');
    expect(records[0]?.error).toEqual({
      type: 'application',
      code: 'ENCOUNTER_DENORMALIZED_DRIFT',
      mismatchCategories: ['stateVersion', 'operation'],
    });
  });

});

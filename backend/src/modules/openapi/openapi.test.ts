import { describe, expect, it } from 'vitest';
import {
  CORE_V1_PASSIVE_MODIFIER_TARGETS,
  CORE_V1_SECONDARY_MODIFIER_CODES,
} from '../rules/core-v1/core-v1.content-mechanics.config.js';
import { ACTIVE_API_ROUTES, getOfficialContract } from './openapi.routes.js';
import { manageEncounterSchema } from '../encounters/encounter-http.schemas.js';
import { manageActorInventorySchema } from '../gpt/gpt.schemas.js';

interface Operation { operationId?: string; security?: unknown; tags?: string[]; parameters?: Array<Schema & { name?: string; in?: string; required?: boolean }>; requestBody?: { content?: { 'application/json'?: { schema?: Schema; examples?: Record<string, { value?: unknown }> } } }; description?: string; responses?: Record<string, unknown> }
interface Schema {
  type?: string;
  $ref?: string;
  description?: string;
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  allOf?: Schema[];
  additionalProperties?: boolean;
  enum?: unknown[];
  format?: string;
  minItems?: number;
  maxItems?: number;
  maxLength?: number;
  if?: Schema;
  then?: Schema;
  not?: Schema;
}
interface Contract {
  openapi: string;
  servers: Array<{ url: string }>;
  security: unknown;
  paths: Record<string, Record<string, Operation>>;
  components: { securitySchemes: Record<string, Record<string, unknown>>; schemas: Record<string, Schema> };
}

const contract = getOfficialContract() as unknown as Contract;
const methods = new Set(['get', 'post', 'put', 'patch', 'delete']);

function operations() {
  return Object.entries(contract.paths).flatMap(([path, pathItem]) => Object.entries(pathItem)
    .filter(([method]) => methods.has(method))
    .map(([method, operation]) => ({ path, method, operation })));
}

function resolveSchema(schema: Schema | undefined): Schema {
  if (schema?.$ref === undefined) return schema ?? {};
  return contract.components.schemas[schema.$ref.split('/').at(-1) ?? ''] ?? {};
}

function reachableSchemas(schemaName: string, seen = new Set<string>()): Record<string, Schema> {
  if (seen.has(schemaName)) return {};
  seen.add(schemaName);
  const schema = contract.components.schemas[schemaName];
  if (schema === undefined) return {};
  const result: Record<string, Schema> = { [schemaName]: schema };
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value !== null && typeof value === 'object') {
      const reference = (value as { $ref?: unknown }).$ref;
      if (typeof reference === 'string') Object.assign(result, reachableSchemas(reference.split('/').at(-1) ?? '', seen));
      Object.values(value).forEach(visit);
    }
  };
  visit(schema);
  return result;
}

function collectEnums(value: unknown, result: unknown[][] = []): unknown[][] {
  if (Array.isArray(value)) {
    value.forEach((item) => collectEnums(item, result));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'enum' && Array.isArray(item)) result.push(item);
      collectEnums(item, result);
    }
  }
  return result;
}

describe('official OpenAPI contract', () => {
  it('is valid JSON loaded as OpenAPI 3.1 with exactly 20 unique operationIds', () => {
    const ids = operations().map(({ operation }) => operation.operationId);
    expect(contract.openapi).toBe('3.1.0');
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(20);
  });

  it('keeps operation descriptions within the GPT Actions editor limit', () => {
    for (const { operation } of operations()) {
      expect(operation.description?.length ?? 0, operation.operationId).toBeLessThanOrEqual(300);
    }
  });

  it('matches every registered Express route exactly', () => {
    const documented = operations().map(({ path, method }) => `${method.toUpperCase()} ${path.replaceAll(/{([^}]+)}/g, ':$1')}`).sort();
    expect(documented).toEqual([...ACTIVE_API_ROUTES].sort());
  });

  it('contains no dangling local component references', () => {
    const missing: string[] = [];
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value !== null && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        if (typeof record.$ref === 'string' && record.$ref.startsWith('#/components/')) {
          const [, , group, name] = record.$ref.split('/');
          const components = contract.components as unknown as Record<string, Record<string, unknown>>;
          if (group === undefined || name === undefined || components[group]?.[name] === undefined) missing.push(record.$ref);
        }
        Object.values(record).forEach(visit);
      }
    };
    visit(contract);
    expect(missing).toEqual([]);
  });

  it('uses x-rpg-key globally and explicitly keeps only public routes unauthenticated', () => {
    expect(contract.components.securitySchemes.RpgApiKey).toMatchObject({ type: 'apiKey', in: 'header', name: 'x-rpg-key' });
    expect(contract.security).toEqual([{ RpgApiKey: [] }]);
    const publicIds = operations().filter(({ operation }) => Array.isArray(operation.security) && operation.security.length === 0).map(({ operation }) => operation.operationId).sort();
    expect(publicIds).toEqual(['checkHealth', 'checkReadiness', 'getOpenApiContract']);
    expect(operations().filter(({ operation }) => !Array.isArray(operation.security) || operation.security.length > 0)).toHaveLength(17);
  });

  it('contains no localhost production server', () => {
    expect(contract.servers.every(({ url }) => !/localhost|127\.0\.0\.1/i.test(url))).toBe(true);
  });

  it.each(['startGame', 'upsertActor', 'updateActor', 'upsertContent', 'createGameEvent'])('%s requires idempotencyKey', (operationId) => {
    const operation = operations().find((item) => item.operation.operationId === operationId)?.operation;
    const schema = resolveSchema(operation?.requestBody?.content?.['application/json']?.schema);
    const required = new Set([...(schema.required ?? []), ...(schema.allOf ?? []).flatMap((item) => resolveSchema(item).required ?? [])]);
    expect(required.has('idempotencyKey')).toBe(true);
  });

  it('documents conditional idempotency for actor-content writes', () => {
    const operation = operations().find((item) => item.operation.operationId === 'manageActorContent')?.operation;
    const schema = resolveSchema(operation?.requestBody?.content?.['application/json']?.schema);
    expect(schema.properties).toHaveProperty('idempotencyKey');
    expect(operation?.description).toContain('exigem idempotencyKey');
    expect(schema.allOf).toEqual(expect.arrayContaining([
      expect.objectContaining({ then: { required: ['idempotencyKey'] } }),
    ]));
  });

  it('documents inventory conditional fields with physical refs and optimistic concurrency', () => {
    const operation = operations().find((item) => item.operation.operationId === 'manageActorInventory')?.operation;
    const schema = resolveSchema(operation?.requestBody?.content?.['application/json']?.schema);
    expect(operation?.description).toContain('expectedInventoryStateVersion');
    expect(operation?.description).toContain('versatileMode');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties).toMatchObject({
      operation: { enum: ['get', 'grant', 'remove', 'split', 'merge', 'reserve', 'release', 'destroy', 'equip', 'unequip'] },
      expectedInventoryStateVersion: { type: 'integer' },
      contentRef: { $ref: '#/components/schemas/InventoryContentReference' },
    });
    expect(schema.properties?.targetSlotRef?.description).toContain('accessory_1');
    expect(schema.properties?.targetSlotRef?.description).toContain('omitir');
    expect(schema.properties?.versatileMode?.description).toContain('Obrigatória');
    expect(schema.allOf).toEqual(expect.arrayContaining([
      expect.objectContaining({ then: { required: ['idempotencyKey', 'expectedInventoryStateVersion'] } }),
      expect.objectContaining({ then: { required: ['entryRef'] } }),
    ]));
    expect(contract.components.schemas.InventorySpec?.additionalProperties).toBe(false);
    expect(contract.components.schemas.ActorContent?.properties).not.toHaveProperty('equipped');
    expect(contract.components.schemas.ActorContent?.properties).not.toHaveProperty('quantity');
  });

  it('documents authoritative effect resolution without accepting client rolls', () => {
    const operation = operations().find((item) => item.operation.operationId === 'resolveActorEffect')?.operation;
    const schema = resolveSchema(operation?.requestBody?.content?.['application/json']?.schema);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(expect.arrayContaining(['playerRef', 'worldRef', 'campaignRef', 'operation', 'sourceActorRef']));
    expect(schema.properties?.operation?.enum).toEqual(['get', 'execute_content', 'use_consumable']);
    expect(schema.properties).toHaveProperty('expectedSourceState');
    expect(schema.properties).not.toHaveProperty('rolls');
    expect(operation?.description).toContain('REQUIRES_ACTION_ORCHESTRATOR');
  });

  it('documents safe errors for every protected API operation', () => {
    for (const { path, operation } of operations().filter(({ path }) => path.startsWith('/api/v1/'))) {
      expect(Object.keys(operation.responses ?? {}), path).toEqual(expect.arrayContaining(['400', '401', '404', '409', '500']));
    }
  });

  it('documents retry guidance and field issues in the shared public error envelope', () => {
    const errorEnvelope = contract.components.schemas.Error;
    expect(errorEnvelope).toBeDefined();
    const error = errorEnvelope?.properties?.error;
    expect(error?.properties).toMatchObject({
      retryable: { type: 'boolean' },
      recoveryAction: { type: 'string' },
      issues: { type: 'array' },
    });
    expect(error?.properties?.issues?.items?.required).toEqual(['path', 'code', 'message']);
    expect(error?.properties?.recoveryAction?.enum).toContain('load_inventory');
  });

  it('keeps manageActorInventory request examples valid against the real Zod schema', () => {
    const operation = operations().find((item) => item.operation.operationId === 'manageActorInventory')?.operation;
    const examples = operation?.requestBody?.content?.['application/json']?.examples ?? {};

    expect(Object.keys(examples)).toEqual([
      'equip_chest_declared_slots',
      'equip_one_handed_weapon',
      'equip_versatile_weapon',
      'equip_accessory',
    ]);
    for (const [name, example] of Object.entries(examples)) {
      expect(manageActorInventorySchema.safeParse(example.value).success, name).toBe(true);
    }
  });

  it('documents sanitized actionable inventory error examples without changing the Action count', () => {
    const operation = operations().find((item) => item.operation.operationId === 'manageActorInventory')?.operation;
    const responses = operation?.responses as Record<string, {
      content?: { 'application/json'?: { examples?: Record<string, { value?: unknown }> } };
    }>;
    const examples = {
      ...(responses['409']?.content?.['application/json']?.examples ?? {}),
      ...(responses['422']?.content?.['application/json']?.examples ?? {}),
    };
    const errorSchema = contract.components.schemas.Error?.properties?.error;
    const recoveryActions = new Set(errorSchema?.properties?.recoveryAction?.enum ?? []);

    expect(Object.keys(examples)).toEqual([
      'inventory_state_version_conflict',
      'occupied_slot',
      'body_incompatible_with_chest',
      'narrative_content_not_equippable',
    ]);
    for (const [name, example] of Object.entries(examples)) {
      const envelope = example.value as { error?: Record<string, unknown> };
      expect(Object.keys(envelope), name).toEqual(['error']);
      expect(Object.keys(envelope.error ?? {}).sort(), name).toEqual(['code', 'issues', 'message', 'recoveryAction', 'retryable']);
      expect(typeof envelope.error?.code, name).toBe('string');
      expect(typeof envelope.error?.message, name).toBe('string');
      expect(envelope.error?.retryable, name).toBe(false);
      expect(recoveryActions.has(envelope.error?.recoveryAction), name).toBe(true);
      const issues = envelope.error?.issues;
      expect(Array.isArray(issues), name).toBe(true);
      const firstIssue = (issues as unknown[])[0] as Record<string, unknown> | undefined;
      expect(typeof firstIssue?.path, name).toBe('string');
      expect(typeof firstIssue?.code, name).toBe('string');
      expect(typeof firstIssue?.message, name).toBe('string');
    }
    expect(operation?.responses).toHaveProperty('422');
    expect(operations()).toHaveLength(20);
    expect(JSON.stringify(examples)).not.toMatch(/api[_-]?key|authorization|cookie|postgres|prisma|sql|stack trace|[0-9a-f]{8}-[0-9a-f-]{27}/i);
  });

  it('uses GPT Action-compatible inline parameters and explicit object properties', () => {
    expect(operations().flatMap(({ operation }) => operation.parameters ?? []).every((parameter) => parameter.$ref === undefined)).toBe(true);
    const objectSchemasWithoutProperties: string[] = [];
    const visit = (value: unknown, path = '$'): void => {
      if (Array.isArray(value)) value.forEach((item, index) => visit(item, `${path}[${index}]`));
      else if (value !== null && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        if (record.type === 'object' && !('properties' in record)) objectSchemasWithoutProperties.push(path);
        Object.entries(record).forEach(([key, item]) => visit(item, `${path}.${key}`));
      }
    };
    visit(contract);
    expect(objectSchemasWithoutProperties).toEqual([]);
  });

  it('documents discovery and requires explicit scope on every public game-state read', () => {
    const byId = new Map(operations().map(({ operation }) => [operation.operationId, operation]));
    expect([...byId.keys()]).toEqual(expect.arrayContaining(['listPlayerWorlds', 'listWorldCampaigns']));
    const expectedQueryParameters: Record<string, string[]> = {
      listCampaignActors: ['playerRef', 'worldRef'],
      getActor: ['playerRef', 'worldRef', 'campaignRef'],
      getCharacter: ['playerRef', 'worldRef', 'campaignRef'],
      listCharacterContent: ['playerRef', 'worldRef', 'campaignRef'],
      getContent: ['playerRef', 'worldRef', 'campaignRef', 'contentType'],
    };
    for (const [operationId, names] of Object.entries(expectedQueryParameters)) {
      const query = (byId.get(operationId)?.parameters ?? []).filter((parameter) => parameter.in === 'query');
      expect(query.map((parameter) => parameter.name), operationId).toEqual(names);
      expect(query.every((parameter) => parameter.required === true), operationId).toBe(true);
    }
    const scope = contract.components.schemas.ScopeInput;
    expect(scope?.required).toEqual(['playerRef', 'worldRef', 'campaignRef']);
    expect(contract.components.schemas.Code?.not).toEqual({ format: 'uuid' });
    for (const operationId of ['loadGame', 'startGame', 'upsertActor', 'updateActor', 'upsertContent', 'manageActorContent', 'manageActorInventory', 'createGameEvent', 'resolveActorEffect']) {
      const operation = byId.get(operationId);
      const schema = resolveSchema(operation?.requestBody?.content?.['application/json']?.schema);
      expect(schema.required, operationId).toEqual(expect.arrayContaining(['playerRef', 'worldRef', 'campaignRef']));
    }
    expect(JSON.stringify(contract)).not.toContain('"default"');
  });

  it('uses closed request objects and lowercase public enums', () => {
    const requestSchemas = operations().map(({ operation }) => resolveSchema(operation.requestBody?.content?.['application/json']?.schema)).filter((schema) => Object.keys(schema).length > 0);
    expect(requestSchemas.every((schema) => schema.additionalProperties === false)).toBe(true);
    const enumStrings = collectEnums(contract).flat().filter((value): value is string => typeof value === 'string');
    const canonicalCamelCase = new Set([...CORE_V1_SECONDARY_MODIFIER_CODES, ...CORE_V1_PASSIVE_MODIFIER_TARGETS]);
    expect(enumStrings.every((value) => value === value.toLowerCase() || canonicalCamelCase.has(value as never))).toBe(true);
  });

  it('documents structured startGame without request unions and with reusable closed objects', () => {
    const start = contract.components.schemas.StartGameInput;
    if (start === undefined) throw new Error('StartGameInput schema is required');
    expect(start.required).toEqual(expect.arrayContaining([
      'idempotencyKey', 'playerMode', 'playerRef', 'worldMode', 'worldRef', 'campaignRef', 'campaignName',
      'campaignConfiguration', 'protagonist', 'initialContentPackages', 'initialPremise',
    ]));
    expect(start.additionalProperties).toBe(false);
    const reachable = reachableSchemas('StartGameInput');
    expect(JSON.stringify(reachable)).not.toMatch(/"oneOf"|"anyOf"|effectiveProfile/);
    for (const schemaName of ['WorldConfiguration', 'CampaignConfiguration', 'Appearance', 'Personality', 'Origin', 'InitialContentDefinition', 'InitialActorContentLink', 'InitialContentPackage']) {
      expect(contract.components.schemas[schemaName]?.additionalProperties, schemaName).toBe(false);
      expect(contract.components.schemas[schemaName]?.properties, schemaName).toBeDefined();
    }
    expect(contract.components.schemas.InitialContentDefinition?.description).toContain('reuse aceita somente');
    expect(contract.components.schemas.InitialActorContentLink?.properties).not.toHaveProperty('actorRef');
    expect(start.description).toContain('81920 bytes UTF-8');
    expect(start.properties?.initialContentPackages?.maxItems).toBe(24);
    expect(start.properties?.initialInventory?.maxItems).toBe(256);
    expect(start.properties?.initialPremise?.maxLength).toBe(1000);
  });

  it('publishes one closed manageEncounter Action with seven Zod-valid examples', () => {
    const operation = operations().find((item) => item.operation.operationId === 'manageEncounter')?.operation;
    expect(operations().filter((item) => item.operation.operationId === 'manageEncounter')).toHaveLength(1);
    expect(operation?.tags).toEqual(['Encounters']);
    expect(operation?.responses === undefined ? [] : Object.keys(operation.responses).sort()).toEqual([
      '200', '400', '401', '404', '409', '422', '500', '503',
    ]);
    expect(JSON.stringify(operation?.responses)).toContain('#/components/headers/RequestId');
    const schema = resolveSchema(operation?.requestBody?.content?.['application/json']?.schema);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties?.operation?.enum).toEqual([
      'create', 'load', 'submit_intent', 'resolve_reaction', 'continue', 'confirm_completion', 'cancel',
    ]);
    expect(schema.allOf).toHaveLength(5);
    expect(JSON.stringify(schema)).not.toMatch(/"oneOf"|"anyOf"/);
    const examples = operation?.requestBody?.content?.['application/json']?.examples ?? {};
    expect(Object.keys(examples).sort()).toEqual([
      'cancel', 'confirm_completion', 'continue', 'create', 'load', 'resolve_reaction', 'submit_intent',
    ]);
    for (const example of Object.values(examples)) expect(manageEncounterSchema.safeParse(example.value).success).toBe(true);
    const intent = contract.components.schemas.EncounterIntentInput;
    expect(intent?.required).toContain('targetSelector');
    expect(intent?.properties).toHaveProperty('targetSelector');
    expect(intent?.properties).not.toHaveProperty('selector');
  });

  it('keeps encounter request and response schemas closed, bounded and free of internal fields', () => {
    const request = reachableSchemas('ManageEncounterInput');
    const response = reachableSchemas('EncounterResult');
    for (const [name, schema] of Object.entries({ ...request, ...response })) {
      if (schema.type === 'object') expect(schema.additionalProperties, name).toBe(false);
    }
    expect(contract.components.schemas.ManageEncounterInput?.properties?.participants?.maxItems).toBe(64);
    expect(contract.components.schemas.ManageEncounterInput?.properties?.relationOverrides?.maxItems).toBe(128);
    expect(contract.components.schemas.EncounterIntentInput?.properties?.targetRefs?.maxItems).toBe(16);
    expect(contract.components.schemas.EncounterNextRequiredAction?.properties?.actors?.minItems).toBe(1);
    expect(contract.components.schemas.EncounterResult?.properties?.participants?.minItems).toBe(1);
    expect(contract.components.schemas.EncounterTransitionSummary?.properties?.events?.minItems).toBe(1);
    expect(contract.components.schemas.EncounterConsequencesSummary).toMatchObject({
      type: 'object', additionalProperties: false,
      required: ['schemaVersion', 'outcome', 'actorChanges', 'removedEncounterEffects', 'persistentEvent'],
    });
    expect(contract.components.schemas.EncounterConsequencesSummary?.properties?.actorChanges?.maxItems).toBe(64);
    expect(contract.components.schemas.EncounterConsequencesSummary?.properties?.removedEncounterEffects?.maxItems).toBe(64);
    expect(contract.components.schemas.EncounterResult?.properties?.consequencesSummary)
      .toEqual({ '$ref': '#/components/schemas/EncounterConsequencesSummary' });
    expect(contract.components.schemas.EncounterActorStatusChange?.properties).not.toHaveProperty('id');
    expect(contract.components.schemas.EncounterActorStatusChange?.properties).toMatchObject({
      statusBefore: { const: 'active' }, statusAfter: { const: 'defeated' },
    });
    expect(contract.components.schemas.EncounterRemovedEffectsSummary?.properties).not.toHaveProperty('effectRefs');
    expect(contract.components.schemas.Code?.maxLength).toBe(100);
    expect(contract.components.schemas.EncounterRuntimeRef?.maxLength).toBe(160);
    expect(resolveSchema(contract.components.schemas.EncounterParticipantInput?.properties?.actorRef).maxLength).toBe(100);
    expect(resolveSchema(contract.components.schemas.EncounterParticipant?.properties?.actorRef).maxLength).toBe(160);
    const propertyNames: string[] = [];
    const visitProperties = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(visitProperties);
      else if (value !== null && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        if (record.properties !== null && typeof record.properties === 'object' && !Array.isArray(record.properties)) {
          propertyNames.push(...Object.keys(record.properties));
        }
        Object.values(record).forEach(visitProperties);
      }
    };
    visitProperties({ request, response });
    expect(propertyNames).not.toEqual(expect.arrayContaining([
      'stateHash', 'beforeStateHash', 'afterStateHash', 'inputHash', 'adapterState', 'snapshot',
      'rolls', 'eventRef', 'actionRef', 'id',
      'xp', 'levelChanges', 'gold', 'loot', 'rewardPolicyVersion', 'effectRefs',
    ]));
    expect(JSON.stringify(contract)).not.toMatch(/staging conclu[íi]do|deploy conclu[íi]do|action j[áa] publicada|importa[cç][aã]o no gpt validada/i);
  });

  it('exposes appearance, personality and an explicit linkedContent DTO', () => {
    expect(contract.components.schemas.Actor?.required).toEqual(expect.arrayContaining(['appearance', 'personality']));
    expect(contract.components.schemas.Actor?.properties).toMatchObject({
      appearance: { $ref: '#/components/schemas/Appearance' }, personality: { $ref: '#/components/schemas/Personality' },
    });
    expect(contract.components.schemas.GameState?.properties?.linkedContent?.items).toEqual({ $ref: '#/components/schemas/LinkedActorContent' });
    expect(contract.components.schemas.LinkedActorContent).toBeDefined();
  });

  it('publishes the authoritative actor mechanical sheet without writable derived fields', () => {
    const primary = contract.components.schemas.PrimaryAttributes;
    expect(primary?.additionalProperties).toBe(false);
    expect(primary?.required).toEqual([
      'strength', 'vitality', 'agility', 'dexterity', 'intelligence', 'wisdom', 'perception', 'willpower', 'luck',
    ]);
    for (const schemaName of ['ActorResources', 'SecondaryAttributes', 'ActorMechanicalSheet']) {
      expect(contract.components.schemas[schemaName]?.additionalProperties, schemaName).toBe(false);
    }
    expect(contract.components.schemas.Actor?.required).toEqual(expect.arrayContaining([
      'primaryAttributes', 'resources', 'secondaryAttributes', 'mechanicsStateVersion', 'inventoryStateVersion', 'inventorySummary', 'ruleset',
    ]));
    const forbidden = ['health', 'maxHealth', 'mana', 'maxMana', 'attributes', 'resistances', 'affinities', 'inputHash', 'rulesetVersionId'];
    expect(forbidden.every((field) => contract.components.schemas.InitialActorInput?.properties?.[field] === undefined)).toBe(true);
    expect(forbidden.every((field) => contract.components.schemas.ActorPatchInput?.properties?.[field] === undefined)).toBe(true);
    expect(forbidden.every((field) => contract.components.schemas.ActorUpsertInput?.properties?.[field] === undefined)).toBe(true);
    expect(contract.components.schemas.InitialActorInput?.required).toContain('primaryAttributes');
    expect(contract.components.schemas.ActorUpsertInput?.required).toContain('primaryAttributes');
  });

  it('contains neither legacy endpoints nor sensitive infrastructure', () => {
    const serialized = JSON.stringify(contract);
    expect(Object.keys(contract.paths).every((path) => !/rpg-gpt|rpg-state|rpg-combat|functions\/v1/i.test(path))).toBe(true);
    expect(serialized).not.toMatch(/supabase\.co|onrender\.com|service[_-]?role|postgres(?:ql)?:\/\//i);
  });
});

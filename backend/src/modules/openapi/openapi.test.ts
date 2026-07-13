import { describe, expect, it } from 'vitest';
import {
  CORE_V1_PASSIVE_MODIFIER_TARGETS,
  CORE_V1_SECONDARY_MODIFIER_CODES,
} from '../rules/core-v1/core-v1.content-mechanics.config.js';
import { ACTIVE_API_ROUTES, getOfficialContract } from './openapi.routes.js';

interface Operation { operationId?: string; security?: unknown; parameters?: Array<Schema & { name?: string; in?: string; required?: boolean }>; requestBody?: { content?: { 'application/json'?: { schema?: Schema } } }; description?: string; responses?: Record<string, unknown> }
interface Schema {
  $ref?: string;
  description?: string;
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  allOf?: Schema[];
  additionalProperties?: boolean;
  enum?: unknown[];
  format?: string;
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
  it('is valid JSON loaded as OpenAPI 3.1 with exactly 17 unique operationIds', () => {
    const ids = operations().map(({ operation }) => operation.operationId);
    expect(contract.openapi).toBe('3.1.0');
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(17);
  });

  it('matches every registered Express route exactly', () => {
    const documented = operations().map(({ path, method }) => `${method.toUpperCase()} ${path.replaceAll(/{([^}]+)}/g, ':$1')}`).sort();
    expect(documented).toEqual([...ACTIVE_API_ROUTES].sort());
  });

  it('uses x-rpg-key globally and explicitly keeps only public routes unauthenticated', () => {
    expect(contract.components.securitySchemes.RpgApiKey).toMatchObject({ type: 'apiKey', in: 'header', name: 'x-rpg-key' });
    expect(contract.security).toEqual([{ RpgApiKey: [] }]);
    const publicIds = operations().filter(({ operation }) => Array.isArray(operation.security) && operation.security.length === 0).map(({ operation }) => operation.operationId).sort();
    expect(publicIds).toEqual(['checkHealth', 'checkReadiness', 'getOpenApiContract']);
    expect(operations().filter(({ operation }) => !Array.isArray(operation.security) || operation.security.length > 0)).toHaveLength(14);
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

  it('documents safe errors for every protected API operation', () => {
    for (const { path, operation } of operations().filter(({ path }) => path.startsWith('/api/v1/'))) {
      expect(Object.keys(operation.responses ?? {}), path).toEqual(expect.arrayContaining(['400', '401', '404', '409', '500']));
    }
  });

  it('documents retry guidance and field issues for invalid input only', () => {
    const errorEnvelope = contract.components.schemas.Error;
    expect(errorEnvelope).toBeDefined();
    const error = errorEnvelope?.properties?.error;
    expect(error?.properties).toMatchObject({
      retryable: { type: 'boolean' },
      retryInstruction: { type: 'string' },
      issues: { type: 'array' },
    });
    expect(error?.properties?.issues?.items?.required).toEqual(['path', 'code', 'message']);
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
    for (const operationId of ['loadGame', 'startGame', 'upsertActor', 'updateActor', 'upsertContent', 'manageActorContent', 'createGameEvent']) {
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
    expect(start.properties?.initialPremise?.maxLength).toBe(1000);
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
      'primaryAttributes', 'resources', 'secondaryAttributes', 'mechanicsStateVersion', 'ruleset',
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

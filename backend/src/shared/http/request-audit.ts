import { createHash, randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

type AuditValue = boolean | number | string | null | AuditValue[] | { [key: string]: AuditValue };

export interface AuditErrorDiagnostic {
  type: 'application' | 'internal' | 'validation';
  code?: string;
  issues?: Array<{ code: string; message?: string; path: string }>;
}

export interface HttpAuditRecord {
  event: 'http_request_completed';
  timestamp: string;
  requestId: string;
  source: 'gpt_api' | 'public';
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  request: Record<string, AuditValue>;
  response: Record<string, AuditValue>;
  error?: AuditErrorDiagnostic;
  operationId?: string;
  encounter?: Record<string, AuditValue>;
}

export type AuditLogWriter = (record: HttpAuditRecord) => void;

const allowedStringFields = [
  'actorRef', 'actorType', 'campaignRef', 'code', 'contentRef', 'contentType', 'eventType',
  'encumbranceState', 'entryKind', 'entryRef', 'inventoryEntryRef', 'operation', 'playerMode', 'playerRef', 'preset',
  'sourceActorRef', 'state', 'status', 'targetActorRef', 'weaponEntryRef', 'worldMode', 'worldRef',
] as const;
const allowedNumberFields = [
  'entryCount', 'equippedCount', 'expectedInventoryStateVersion', 'inventoryStateVersion',
  'mastery', 'mechanicsStateVersion', 'progress', 'rank', 'removed',
] as const;
const sensitiveKeyPattern = /authorization|cookie|key|password|secret|token/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeKeys(value: unknown): string[] {
  if (!isRecord(value)) return [];
  return Object.keys(value)
    .filter((key) => !sensitiveKeyPattern.test(key))
    .map((key) => (/^[a-zA-Z0-9_.-]{1,64}$/.test(key) ? key : '[invalid]'))
    .slice(0, 30)
    .sort();
}

function safeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 100 || /[\r\n]/.test(normalized)) return undefined;
  return normalized;
}

function addAllowedScalars(source: Record<string, unknown>, target: Record<string, AuditValue>): void {
  for (const field of allowedStringFields) {
    const value = safeString(source[field]);
    if (value !== undefined) target[field] = value;
  }
  for (const field of allowedNumberFields) {
    const value = source[field];
    if (typeof value === 'number' && Number.isFinite(value)) target[field] = value;
    if (typeof value === 'boolean') target[field] = value;
  }
}

function addMechanicalSummary(source: Record<string, unknown>, target: Record<string, AuditValue>): void {
  if (isRecord(source.primaryAttributes)) target.attributeCount = Object.keys(source.primaryAttributes).length;
  if (isRecord(source.resources)) {
    target.resourceTypes = Object.keys(source.resources).filter((type) => ['hp', 'mana', 'sp'].includes(type)).sort();
  }
  if (isRecord(source.secondaryAttributes)) target.derivedSnapshotPresent = true;
  if (isRecord(source.ruleset)) {
    const rulesetCode = safeString(source.ruleset.code);
    if (rulesetCode !== undefined) target.rulesetCode = rulesetCode;
  }
}

function fingerprint(value: unknown): { fingerprint: string; length: number } | undefined {
  if (typeof value !== 'string') return undefined;
  return { fingerprint: createHash('sha256').update(value).digest('hex').slice(0, 12), length: value.length };
}

function summarizeRequest(request: Request): Record<string, AuditValue> {
  const summary: Record<string, AuditValue> = {};
  const query: Record<string, AuditValue> = {};
  if (isRecord(request.query)) addAllowedScalars(request.query, query);
  if (Object.keys(query).length > 0) summary.query = query;

  if (!isRecord(request.body)) return summary;
  const body: Record<string, AuditValue> = { keys: safeKeys(request.body) };
  addAllowedScalars(request.body, body);
  addMechanicalSummary(request.body, body);
  const inventoryActor = request.path.match(/^\/api\/v1\/actors\/([a-z0-9_-]+)\/inventory\/manage$/i)?.[1];
  if (inventoryActor !== undefined) body.actorRef = inventoryActor;
  if (typeof request.body.expectedInventoryStateVersion === 'number') {
    body.inventoryStateVersionBefore = request.body.expectedInventoryStateVersion;
  }
  if (isRecord(request.body.contentRef)) {
    const contentRef: Record<string, AuditValue> = {};
    const contentType = safeString(request.body.contentRef.contentType);
    const contentCode = safeString(request.body.contentRef.code);
    if (contentType !== undefined) contentRef.contentType = contentType;
    if (contentCode !== undefined) contentRef.contentCode = contentCode;
    if (typeof request.body.contentRef.versionNumber === 'number' && Number.isFinite(request.body.contentRef.versionNumber)) {
      contentRef.versionNumber = request.body.contentRef.versionNumber;
    }
    if (Object.keys(contentRef).length > 0) body.content = contentRef;
  }
  if ((request.originalUrl.split('?', 1)[0] ?? request.path) === '/api/v1/actors/effects/resolve') {
    if (isRecord(request.body.expectedSourceState)) {
      for (const field of ['mechanicsStateVersion', 'inventoryStateVersion', 'effectsStateVersion'] as const) {
        const value = request.body.expectedSourceState[field];
        if (typeof value === 'number' && Number.isFinite(value)) body[`${field}Before`] = value;
      }
    }
    if (isRecord(request.body.expectedTargetState)
      && typeof request.body.expectedTargetState.effectsStateVersion === 'number') {
      body.targetEffectsStateVersionBefore = request.body.expectedTargetState.effectsStateVersion;
    }
  }

  const idempotency = fingerprint(request.body.idempotencyKey);
  if (idempotency !== undefined) body.idempotency = idempotency;

  if (isRecord(request.body.changes)) {
    const changes: Record<string, AuditValue> = { keys: safeKeys(request.body.changes) };
    addAllowedScalars(request.body.changes, changes);
    if ('notes' in request.body.changes) changes.notesPresent = request.body.changes.notes !== undefined;
    if (isRecord(request.body.changes.metadata)) changes.metadataKeys = safeKeys(request.body.changes.metadata);
    body.changes = changes;
  }
  if (isRecord(request.body.protagonist)) {
    const protagonist: Record<string, AuditValue> = { keys: safeKeys(request.body.protagonist) };
    addAllowedScalars(request.body.protagonist, protagonist);
    addMechanicalSummary(request.body.protagonist, protagonist);
    body.protagonist = protagonist;
  }
  if (Array.isArray(request.body.initialContentPackages)) {
    const contentTypes: Record<string, number> = {};
    let linkCount = 0;
    for (const item of request.body.initialContentPackages) {
      if (!isRecord(item)) continue;
      if (isRecord(item.definition)) {
        const contentType = safeString(item.definition.contentType);
        if (contentType !== undefined) contentTypes[contentType] = (contentTypes[contentType] ?? 0) + 1;
      }
      if (isRecord(item.protagonistLink)) {
        linkCount += 1;
      }
    }
    body.initialContent = {
      packageCount: request.body.initialContentPackages.length,
      linkCount,
      contentTypes,
    };
  }
  if (Array.isArray(request.body.entryRefs)) body.entryRefCount = request.body.entryRefs.length;
  if (Array.isArray(request.body.initialInventory)) body.initialInventoryCount = request.body.initialInventory.length;
  if (isRecord(request.body.campaignConfiguration) && isRecord(request.body.campaignConfiguration.difficulty)) {
    const preset = safeString(request.body.campaignConfiguration.difficulty.preset);
    if (preset !== undefined) body.difficultyPreset = preset;
  }
  if (isRecord(request.body.metadata)) body.metadataKeys = safeKeys(request.body.metadata);
  if (isRecord(request.body.payload)) body.payloadKeys = safeKeys(request.body.payload);
  summary.body = body;
  return summary;
}

function summarizeResponse(body: unknown): Record<string, AuditValue> {
  if (Array.isArray(body)) return { kind: 'array', itemCount: body.length };
  if (!isRecord(body)) return { kind: body === undefined ? 'empty' : typeof body };

  const summary: Record<string, AuditValue> = { kind: 'object', keys: safeKeys(body) };
  addAllowedScalars(body, summary);
  addMechanicalSummary(body, summary);
  if (typeof body.inventoryStateVersion === 'number') summary.inventoryStateVersionAfter = body.inventoryStateVersion;
  if (Array.isArray(body.entries)) {
    summary.entryCount = body.entries.length;
    summary.equippedCount = body.entries.filter((entry) => isRecord(entry)
      && Array.isArray(entry.equippedSlots) && entry.equippedSlots.length > 0).length;
  }
  if (isRecord(body.encumbrance)) {
    const encumbranceState = safeString(body.encumbrance.state);
    if (encumbranceState !== undefined) summary.encumbranceState = encumbranceState;
  }
  if (Array.isArray(body.rolls)) summary.rollCount = body.rolls.length;
  if (Array.isArray(body.activeEffectChanges)) summary.activeEffectChanges = body.activeEffectChanges.length;
  if (Array.isArray(body.inventoryChanges)) summary.inventoryChanged = body.inventoryChanges.length > 0;
  if (Array.isArray(body.resourceChanges)) {
    summary.resourceTypesChanged = [...new Set(body.resourceChanges.flatMap((change) => (
      isRecord(change) && ['hp', 'mana', 'sp'].includes(String(change.resource)) ? [String(change.resource)] : []
    )))].sort();
  }
  if (Array.isArray(body.damageResults)) {
    summary.damageAppliedPresent = body.damageResults.some((damage) => isRecord(damage)
      && typeof damage.damageApplied === 'number' && damage.damageApplied > 0);
    const firstDamage = body.damageResults.find(isRecord);
    if (firstDamage !== undefined) {
      if (typeof firstDamage.hit === 'boolean') summary.hit = firstDamage.hit;
      if (typeof firstDamage.critical === 'boolean') summary.critical = firstDamage.critical;
    }
  }
  if (isRecord(body.source) && typeof body.source.effectsStateVersion === 'number') {
    summary.effectsStateVersionAfter = body.source.effectsStateVersion;
  }
  if (isRecord(body.target) && typeof body.target.effectsStateVersion === 'number') {
    summary.targetEffectsStateVersionAfter = body.target.effectsStateVersion;
  }
  if (isRecord(body.protagonist)) addMechanicalSummary(body.protagonist, summary);
  if (Array.isArray(body.mainActors)) summary.mainActorCount = body.mainActors.length;
  if (Array.isArray(body.linkedContent)) summary.linkedContentCount = body.linkedContent.length;
  if (Array.isArray(body.recentEvents)) summary.recentEventCount = body.recentEvents.length;
  if (isRecord(body.error)) {
    const code = safeString(body.error.code);
    summary.error = code === undefined ? { present: true } : { code };
  }
  return summary;
}

function summarizeEncounterAudit(value: unknown): Record<string, AuditValue> | undefined {
  if (!isRecord(value) || value.operationId !== 'manageEncounter') return undefined;
  const result: Record<string, AuditValue> = {};
  for (const field of [
    'operation', 'encounterRef', 'result', 'lifecycleStatus', 'sourceActorRef', 'reactorRef',
    'outcome', 'eventType',
  ]) {
    const item = safeString(value[field]);
    if (item !== undefined) result[field] = item;
  }
  for (const field of [
    'participantCount', 'relationOverrideCount', 'processedEventCount', 'stateVersion', 'expectedStateVersion',
    'actorChangeCount', 'removedEncounterEffectCount',
  ]) {
    const item = value[field];
    if (typeof item === 'number' && Number.isSafeInteger(item) && item >= 0) result[field] = item;
  }
  return result;
}

export function setAuditError(response: Response, diagnostic: AuditErrorDiagnostic): void {
  response.locals.auditError = diagnostic;
}

export const writeHttpAuditLog: AuditLogWriter = (record) => {
  console.info(JSON.stringify(record));
};

export function createRequestAudit(writer?: AuditLogWriter): RequestHandler {
  return (request: Request, response: Response, next: NextFunction) => {
    const requestId = randomUUID();
    const requestPath = (request.originalUrl.split('?', 1)[0] ?? request.path).replace(/[\r\n]/g, '').slice(0, 500);
    const startedAt = process.hrtime.bigint();
    let responseBody: unknown;
    const originalJson = response.json.bind(response);

    response.setHeader('x-request-id', requestId);
    response.json = ((body: unknown) => {
      responseBody = body;
      return originalJson(body);
    }) as typeof response.json;

    response.once('finish', () => {
      if (writer === undefined) return;
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const auditError = response.locals.auditError as AuditErrorDiagnostic | undefined;
      const encounter = summarizeEncounterAudit(response.locals.encounterAudit);
      writer({
        event: 'http_request_completed',
        timestamp: new Date().toISOString(),
        requestId,
        source: requestPath.startsWith('/api/v1') ? 'gpt_api' : 'public',
        method: request.method,
        path: requestPath,
        statusCode: response.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        request: summarizeRequest(request),
        response: summarizeResponse(responseBody),
        ...(encounter === undefined ? {} : { operationId: 'manageEncounter', encounter }),
        ...(auditError === undefined ? {} : { error: auditError }),
      });
    });

    next();
  };
}

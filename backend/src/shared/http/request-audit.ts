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
}

export type AuditLogWriter = (record: HttpAuditRecord) => void;

const allowedStringFields = [
  'actorRef', 'actorType', 'campaignRef', 'code', 'contentRef', 'contentType', 'eventType',
  'operation', 'playerMode', 'playerRef', 'preset', 'state', 'status', 'worldMode', 'worldRef',
] as const;
const allowedNumberFields = ['equipped', 'mastery', 'mechanicsStateVersion', 'progress', 'quantity', 'rank', 'removed'] as const;
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
    let equippedCount = 0;
    for (const item of request.body.initialContentPackages) {
      if (!isRecord(item)) continue;
      if (isRecord(item.definition)) {
        const contentType = safeString(item.definition.contentType);
        if (contentType !== undefined) contentTypes[contentType] = (contentTypes[contentType] ?? 0) + 1;
      }
      if (isRecord(item.protagonistLink)) {
        linkCount += 1;
        if (item.protagonistLink.equipped === true) equippedCount += 1;
      }
    }
    body.initialContent = {
      packageCount: request.body.initialContentPackages.length,
      linkCount,
      equippedCount,
      contentTypes,
    };
  }
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
        ...(auditError === undefined ? {} : { error: auditError }),
      });
    });

    next();
  };
}

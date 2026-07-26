import { AuditEventRejectedError } from './audit-event.errors.js';
import type {
  AuditEventRepository,
  RecordAuditEventInput,
  SafeAuditMetadata,
  SafeAuditMetadataValue,
} from './audit-event.types.js';

const allowedMetadataKeys = new Set([
  'clientId',
  'membershipStatus',
  'newStatus',
  'operation',
  'permission',
  'previousStatus',
  'resourceType',
  'result',
  'role',
  'scope',
  'toolName',
  'userStatus',
]);
const unsafeValuePattern = /(?:\bbearer\s+)|(?:postgres(?:ql)?:\/\/)|(?:[^\s@]+@[^\s@]+\.[^\s@]+)|(?:^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$)/iu;

function isSafeLabel(value: string, maximumLength: number): boolean {
  return value.length > 0
    && value.length <= maximumLength
    && value.trim() === value
    && !/[\r\n]/u.test(value);
}

function safeMetadataValue(value: SafeAuditMetadataValue): boolean {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') {
    return value.length <= 200 && !/[\r\n]/u.test(value) && !unsafeValuePattern.test(value);
  }
  return false;
}

export function sanitizeAuditMetadata(metadata: SafeAuditMetadata | undefined): Record<string, SafeAuditMetadataValue> {
  if (metadata === undefined) return {};
  const entries = Object.entries(metadata);
  if (entries.length > 20) throw new AuditEventRejectedError();
  const sanitized: Record<string, SafeAuditMetadataValue> = {};
  for (const [key, value] of entries) {
    if (!allowedMetadataKeys.has(key) || !safeMetadataValue(value)) throw new AuditEventRejectedError();
    sanitized[key] = value;
  }
  return sanitized;
}

export function createAuditEventService(repository: AuditEventRepository) {
  return {
    async record(input: RecordAuditEventInput): Promise<{ readonly id: string }> {
      if (!isSafeLabel(input.eventType, 100)
        || !isSafeLabel(input.source, 100)
        || (input.reasonCode !== undefined && !isSafeLabel(input.reasonCode, 100))
        || (input.requestId !== undefined && !isSafeLabel(input.requestId, 128))
        || (input.traceId !== undefined && !isSafeLabel(input.traceId, 128))) {
        throw new AuditEventRejectedError();
      }
      return repository.create({
        occurredAt: input.occurredAt ?? new Date(),
        eventType: input.eventType,
        userId: input.userId ?? null,
        externalIdentityId: input.externalIdentityId ?? null,
        campaignId: input.campaignId ?? null,
        actorId: input.actorId ?? null,
        requestId: input.requestId ?? null,
        traceId: input.traceId ?? null,
        decision: input.decision,
        reasonCode: input.reasonCode ?? null,
        source: input.source,
        metadata: sanitizeAuditMetadata(input.metadata),
      });
    },
  };
}

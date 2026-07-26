import type { AuditDecision } from '../../generated/prisma/client.js';

export type SafeAuditMetadataValue = boolean | number | string | null;
export type SafeAuditMetadata = Readonly<Record<string, SafeAuditMetadataValue>>;

export interface RecordAuditEventInput {
  readonly occurredAt?: Date;
  readonly eventType: string;
  readonly userId?: string;
  readonly externalIdentityId?: string;
  readonly campaignId?: string;
  readonly actorId?: string;
  readonly gameSessionId?: string;
  readonly requestId?: string;
  readonly traceId?: string;
  readonly decision: AuditDecision;
  readonly reasonCode?: string;
  readonly source: string;
  readonly metadata?: SafeAuditMetadata;
}

export interface PersistedAuditEventInput {
  readonly occurredAt: Date;
  readonly eventType: string;
  readonly userId: string | null;
  readonly externalIdentityId: string | null;
  readonly campaignId: string | null;
  readonly actorId: string | null;
  readonly gameSessionId: string | null;
  readonly requestId: string | null;
  readonly traceId: string | null;
  readonly decision: AuditDecision;
  readonly reasonCode: string | null;
  readonly source: string;
  readonly metadata: Record<string, SafeAuditMetadataValue>;
}

export interface AuditEventRepository {
  create(input: PersistedAuditEventInput): Promise<{ readonly id: string }>;
}

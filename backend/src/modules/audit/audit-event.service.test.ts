import { AuditDecision } from '../../generated/prisma/client.js';
import { describe, expect, it, vi } from 'vitest';
import { createAuditEventService, sanitizeAuditMetadata } from './audit-event.service.js';
import type { AuditEventRepository } from './audit-event.types.js';

function repository(): {
  readonly target: AuditEventRepository;
  readonly createAuditEvent: ReturnType<typeof vi.fn<AuditEventRepository['create']>>;
} {
  const createAuditEvent = vi.fn<AuditEventRepository['create']>().mockResolvedValue({
      id: '10000000-0000-0000-0000-000000000001',
  });
  return { target: { create: createAuditEvent }, createAuditEvent };
}

describe('audit event service', () => {
  it('persists only a small allowlisted metadata projection', async () => {
    const { target, createAuditEvent } = repository();
    await expect(createAuditEventService(target).record({
      eventType: 'campaign_access',
      userId: '20000000-0000-0000-0000-000000000001',
      campaignId: '30000000-0000-0000-0000-000000000001',
      decision: AuditDecision.ALLOW,
      source: 'authorization_service',
      reasonCode: 'campaign_membership_active',
      metadata: { role: 'PLAYER', resourceType: 'campaign', result: 'allowed' },
    })).resolves.toEqual({ id: '10000000-0000-0000-0000-000000000001' });

    expect(createAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      decision: AuditDecision.ALLOW,
      metadata: { role: 'PLAYER', resourceType: 'campaign', result: 'allowed' },
    }));
  });

  it('rejects free-form email, token, connection string, and unknown metadata keys', () => {
    expect(() => sanitizeAuditMetadata({ email: 'person@example.test' })).toThrow(/unsafe data/u);
    expect(() => sanitizeAuditMetadata({ result: 'Bearer secret-token' })).toThrow(/unsafe data/u);
    expect(() => sanitizeAuditMetadata({ result: 'postgresql://user:secret@example.test/db' })).toThrow(/unsafe data/u);
    expect(() => sanitizeAuditMetadata({ narrative: 'full payload' })).toThrow(/unsafe data/u);
  });

  it.each([
    'token',
    'accessToken',
    'refreshToken',
    'authorization',
    'cookie',
    'password',
    'secret',
    'apiKey',
    'clientSecret',
    'TOKEN',
    'AccessToken',
  ])('rejects the sensitive or non-allowlisted metadata key %s', (key) => {
    expect(() => sanitizeAuditMetadata({ [key]: 'unsafe' })).toThrow(/unsafe data/u);
  });

  it('rejects nested values, arrays, oversized strings, and excessive key counts at runtime', () => {
    expect(() => sanitizeAuditMetadata({
      result: { token: 'hidden' },
    } as unknown as Parameters<typeof sanitizeAuditMetadata>[0])).toThrow(/unsafe data/u);
    expect(() => sanitizeAuditMetadata({
      result: ['hidden'],
    } as unknown as Parameters<typeof sanitizeAuditMetadata>[0])).toThrow(/unsafe data/u);
    expect(() => sanitizeAuditMetadata({ result: 'x'.repeat(201) })).toThrow(/unsafe data/u);
    expect(() => sanitizeAuditMetadata(Object.fromEntries(
      Array.from({ length: 21 }, (_, index) => [`key${index}`, index]),
    ) as Parameters<typeof sanitizeAuditMetadata>[0])).toThrow(/unsafe data/u);
  });

  it('rejects unsafe labels before writing', async () => {
    const { target, createAuditEvent } = repository();
    await expect(createAuditEventService(target).record({
      eventType: 'campaign_access\nforged',
      decision: AuditDecision.DENY,
      source: 'authorization_service',
    })).rejects.toMatchObject({ code: 'AUDIT_EVENT_REJECTED' });
    expect(createAuditEvent).not.toHaveBeenCalled();
  });
});

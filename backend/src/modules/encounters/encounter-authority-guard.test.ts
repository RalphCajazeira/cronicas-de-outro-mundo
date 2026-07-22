import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '../../generated/prisma/client.js';
import { assertActorsMutableOutsideEncounter } from './encounter-authority-guard.js';

function transaction(open: unknown) {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    encounter: { findFirst: vi.fn().mockResolvedValue(open) },
  } as unknown as Prisma.TransactionClient;
}

describe('active encounter authority guard', () => {
  it('allows writes when none of the actors participates in an open encounter', async () => {
    const client = transaction(null);
    await expect(assertActorsMutableOutsideEncounter(client, 'campaign-id', [{ id: 'actor-id', code: 'hero' }]))
      .resolves.toBeUndefined();
    expect(client.$queryRaw).toHaveBeenCalledOnce();
  });

  it('returns a safe actionable conflict for an active participant', async () => {
    const client = transaction({
      encounterRef: 'bridge-ambush',
      participants: [{ actorRef: 'hero' }],
    });
    await expect(assertActorsMutableOutsideEncounter(client, 'campaign-id', [{ id: 'actor-id', code: 'hero' }]))
      .rejects.toMatchObject({
        statusCode: 409,
        code: 'ACTOR_ENCOUNTER_LOCKED',
        retryable: false,
        recoveryAction: 'finish_or_abandon_encounter',
        issues: [{ path: 'actors.hero', code: 'ACTIVE_ENCOUNTER_PARTICIPANT' }],
      });
  });
});

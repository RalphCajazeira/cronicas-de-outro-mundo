import type { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors/app-error.js';
import { ACTIVE_ENCOUNTER_LIFECYCLES } from './encounter.types.js';
import { lockCampaign } from './encounter.repository.js';

/**
 * Serializes external authority writes with encounter operations and rejects
 * mutations that would invalidate an open encounter snapshot.
 */
export async function assertActorsMutableOutsideEncounter(
  transaction: Prisma.TransactionClient,
  campaignId: string,
  actors: readonly { readonly id: string; readonly code: string }[],
): Promise<void> {
  await lockCampaign(transaction, campaignId);
  const actorIds = [...new Set(actors.map((actor) => actor.id))];
  if (actorIds.length === 0) return;
  const open = await transaction.encounter.findFirst({
    where: {
      campaignId,
      lifecycleStatus: { in: [...ACTIVE_ENCOUNTER_LIFECYCLES] },
      participants: { some: { actorId: { in: actorIds } } },
    },
    select: {
      encounterRef: true,
      participants: {
        where: { actorId: { in: actorIds } },
        select: { actorRef: true },
        orderBy: { actorRef: 'asc' },
      },
    },
  });
  if (open === null) return;
  throw new AppError(409, 'ACTOR_ENCOUNTER_LOCKED', 'Actor authority cannot change during an active encounter', {
    retryable: false,
    recoveryAction: 'finish_or_abandon_encounter',
    auditCode: 'ACTIVE_ENCOUNTER_AUTHORITY_MUTATION_BLOCKED',
    issues: open.participants.map((participant) => ({
      path: `actors.${participant.actorRef}`,
      code: 'ACTIVE_ENCOUNTER_PARTICIPANT',
      message: `Finish or abandon encounter ${open.encounterRef} before changing this actor`,
    })),
  });
}

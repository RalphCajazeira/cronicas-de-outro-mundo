import type { NextFunction, Request, Response } from 'express';
import { observeOperation } from '../../shared/observability/operation-observability.js';
import { manageEncounterSchema } from './encounter-http.schemas.js';
import type { EncounterHttpService } from './encounter-http.service.js';

export function createManageEncounterController(service: EncounterHttpService) {
  return async (request: Request, response: Response, next: NextFunction) => {
    try {
      const input = manageEncounterSchema.parse(request.body);
      const auditContext: Record<string, string | number | boolean> = {
        operationId: 'manageEncounter',
        operation: input.operation,
        encounterRef: input.encounterRef,
        mode: input.operation === 'create'
          ? input.setupMode === 'assisted' ? 'assisted' : 'explicit'
          : input.operation === 'resolve_beat'
            ? 'policy' in input ? 'automatic' : 'plan'
            : 'granular',
        ...(input.operation === 'create' ? {
          participantCount: input.setupMode === 'assisted'
            ? input.partyActorRefs.length + input.hostileActorRefs.length + (input.neutralActorRefs?.length ?? 0)
            : input.participants.length,
          relationOverrideCount: input.setupMode === 'assisted' ? 0 : input.relationOverrides?.length ?? 0,
        } : {}),
        ...('expectedStateVersion' in input ? { expectedStateVersion: input.expectedStateVersion } : {}),
        ...(input.operation === 'submit_intent' ? { sourceActorRef: input.intent.actorRef } : {}),
        ...(input.operation === 'resolve_reaction' ? { reactorRef: input.reactorRef } : {}),
      };
      response.locals.encounterAudit = auditContext;
      const result = await observeOperation('manageEncounter', () => service.manage(input));
      const capsuleActionCount = result.scene?.participants.reduce((total, participant) => (
        total
        + participant.usableActions.attacks.length
        + participant.usableActions.abilities.length
        + participant.usableActions.items.length
      ), 0) ?? 0;
      Object.assign(auditContext, {
        result: result.result,
        lifecycleStatus: result.lifecycleStatus,
        stateVersion: result.stateVersion,
        processedEventCount: result.transitionSummary?.processedEventCount ?? 0,
        capsuleActionCount,
        ...(result.batchSummary === undefined ? {} : {
          stopReason: result.batchSummary.stopReason,
          stopCategory: result.batchSummary.stopCategory,
          beatsProcessed: result.batchSummary.beatsProcessed,
          actionsResolved: result.batchSummary.actionsResolved,
          requiresPlayerDecision: result.batchSummary.requiresPlayerDecision,
        }),
        ...(result.consequencesSummary === undefined ? {} : {
          outcome: result.consequencesSummary.outcome,
          actorChangeCount: result.consequencesSummary.actorChanges.length,
          removedEncounterEffectCount: result.consequencesSummary.removedEncounterEffects
            .reduce((total, entry) => total + entry.count, 0),
          eventType: result.consequencesSummary.persistentEvent.eventType,
        }),
      });
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  };
}

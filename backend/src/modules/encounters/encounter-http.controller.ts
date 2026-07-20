import type { NextFunction, Request, Response } from 'express';
import { manageEncounterSchema } from './encounter-http.schemas.js';
import type { EncounterHttpService } from './encounter-http.service.js';

export function createManageEncounterController(service: EncounterHttpService) {
  return async (request: Request, response: Response, next: NextFunction) => {
    try {
      const input = manageEncounterSchema.parse(request.body);
      const auditContext: Record<string, string | number> = {
        operationId: 'manageEncounter',
        operation: input.operation,
        encounterRef: input.encounterRef,
        ...(input.operation === 'create' ? {
          participantCount: input.participants.length,
          relationOverrideCount: input.relationOverrides?.length ?? 0,
        } : {}),
        ...('expectedStateVersion' in input ? { expectedStateVersion: input.expectedStateVersion } : {}),
        ...(input.operation === 'submit_intent' ? { sourceActorRef: input.intent.actorRef } : {}),
        ...(input.operation === 'resolve_reaction' ? { reactorRef: input.reactorRef } : {}),
      };
      response.locals.encounterAudit = auditContext;
      const result = await service.manage(input);
      Object.assign(auditContext, {
        result: result.result,
        lifecycleStatus: result.lifecycleStatus,
        stateVersion: result.stateVersion,
        processedEventCount: result.transitionSummary?.processedEventCount ?? 0,
      });
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  };
}

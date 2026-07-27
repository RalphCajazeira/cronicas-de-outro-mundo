import {
  authenticatedGameSessionSelectionResultSchema,
  authenticatedObservationResultSchema,
  performAuthenticatedObservationInputSchema,
  selectAuthenticatedGameContextInputSchema,
  type SelectAuthenticatedGameContextInput,
  type PerformAuthenticatedObservationInput,
} from './authenticated-game-session.dto.js';
import type {
  AuthenticatedGameSessionAuditContext,
  AuthenticatedGameSessionRepository,
} from './authenticated-game-session.types.js';

export function createAuthenticatedGameSessionService(
  repository: AuthenticatedGameSessionRepository,
) {
  return {
    async select(
      userId: string,
      input: SelectAuthenticatedGameContextInput,
      audit: AuthenticatedGameSessionAuditContext,
    ) {
      const parsedInput = selectAuthenticatedGameContextInputSchema.parse(input);
      return authenticatedGameSessionSelectionResultSchema.parse(
        await repository.select(userId, parsedInput, audit),
      );
    },
    async observe(
      userId: string,
      input: PerformAuthenticatedObservationInput,
      audit: AuthenticatedGameSessionAuditContext,
    ) {
      const parsedInput = performAuthenticatedObservationInputSchema.parse(input);
      return authenticatedObservationResultSchema.parse(
        await repository.observe(userId, parsedInput, audit),
      );
    },
  };
}

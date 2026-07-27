import type {
  AuthenticatedGameSessionSelectionResult,
  AuthenticatedObservationResult,
  PerformAuthenticatedObservationInput,
  SelectAuthenticatedGameContextInput,
} from './authenticated-game-session.dto.js';

export interface AuthenticatedGameSessionAuditContext {
  readonly requestId?: string;
  readonly traceId?: string;
  readonly origin: 'widget';
}

export interface AuthenticatedGameSessionRepository {
  select(
    userId: string,
    input: SelectAuthenticatedGameContextInput,
    audit: AuthenticatedGameSessionAuditContext,
  ): Promise<AuthenticatedGameSessionSelectionResult>;
  observe(
    userId: string,
    input: PerformAuthenticatedObservationInput,
    audit: AuthenticatedGameSessionAuditContext,
  ): Promise<AuthenticatedObservationResult>;
}

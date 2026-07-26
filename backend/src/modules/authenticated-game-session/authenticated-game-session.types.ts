import type {
  AuthenticatedGameSessionSelectionResult,
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
}

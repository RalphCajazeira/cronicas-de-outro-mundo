export type AuthenticatedGameContextReason =
  | 'context_inconsistent'
  | 'resource_unavailable'
  | 'selection_incomplete';

export class AuthenticatedGameContextAccessError extends Error {
  constructor(readonly reasonCode: AuthenticatedGameContextReason) {
    super('Authorized game context is unavailable');
    this.name = 'AuthenticatedGameContextAccessError';
  }
}

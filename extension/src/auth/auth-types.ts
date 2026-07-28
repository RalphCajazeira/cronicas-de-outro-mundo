export type PublicAuthErrorCode =
  | 'cancelled'
  | 'state_invalid'
  | 'redirect_invalid'
  | 'session_expired'
  | 'refresh_failed'
  | 'user_revoked'
  | 'user_suspended'
  | 'backend_unavailable'
  | 'configuration_invalid';

export type PublicAuthState =
  | { readonly status: 'signed_out' }
  | { readonly status: 'authorizing' }
  | { readonly status: 'authenticated'; readonly user: { readonly displayName: string } }
  | { readonly status: 'expired' }
  | { readonly status: 'error'; readonly code: PublicAuthErrorCode };

export interface ExtensionOAuthConfig {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly resourceUri: string;
  readonly scopes: readonly string[];
}

export function isPublicAuthState(value: unknown): value is PublicAuthState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if (state.status === 'signed_out' || state.status === 'authorizing' || state.status === 'expired') return Object.keys(state).length === 1;
  if (state.status === 'authenticated') {
    return Object.keys(state).length === 2
      && typeof state.user === 'object' && state.user !== null && !Array.isArray(state.user)
      && Object.keys(state.user).length === 1
      && typeof (state.user as { displayName?: unknown }).displayName === 'string';
  }
  return state.status === 'error'
    && Object.keys(state).length === 2
    && typeof state.code === 'string'
    && ['cancelled', 'state_invalid', 'redirect_invalid', 'session_expired', 'refresh_failed', 'user_revoked', 'user_suspended', 'backend_unavailable', 'configuration_invalid'].includes(state.code);
}

export const AUTHORIZATION_STORAGE_KEY = 'cronicas.oauth.authorization-id';
export const OAUTH_SESSION_STORAGE_KEY = 'cronicas.oauth.session';
const authorizationIdPattern = /^[A-Za-z0-9_-]{16,128}$/u;

export interface OAuthUser {
  readonly id: string;
  readonly email?: string;
}

export interface ConsentDetails {
  readonly authorization_id: string;
  readonly client: { readonly name: string };
  readonly redirect_uri: string;
  readonly scope?: string;
}

export interface OAuthRedirect {
  readonly redirect_url: string;
}

export interface OAuthPort {
  signInWithPassword(credentials: { email: string; password: string }): Promise<{
    data: { user: OAuthUser | null };
    error: unknown;
  }>;
  getUser(): Promise<{ data: { user: OAuthUser | null }; error: unknown }>;
  getAuthorizationDetails(authorizationId: string): Promise<{
    data: ConsentDetails | OAuthRedirect | null;
    error: unknown;
  }>;
  approveAuthorization(authorizationId: string): Promise<{
    data: OAuthRedirect | null;
    error: unknown;
  }>;
  denyAuthorization(authorizationId: string): Promise<{
    data: OAuthRedirect | null;
    error: unknown;
  }>;
}

export type ConsentLoadResult =
  | { readonly kind: 'login_required' }
  | { readonly kind: 'consent'; readonly details: ConsentDetails }
  | { readonly kind: 'redirect'; readonly redirectUrl: string }
  | { readonly kind: 'error' };

export function parseAuthorizationId(value: string | null): string | undefined {
  if (value === null || !authorizationIdPattern.test(value)) return undefined;
  return value;
}

export function parseScopes(scope: string | undefined): string[] {
  if (scope === undefined || scope.length > 1_024) return [];
  const values = scope.split(' ').filter(Boolean);
  if (new Set(values).size !== values.length
    || values.some((value) => !/^[\x21\x23-\x5B\x5D-\x7E]{1,100}$/u.test(value))) {
    return [];
  }
  return values;
}

export function isSafeReturnedRedirect(returnedUrl: string, approvedRedirectUri?: string): boolean {
  if (returnedUrl.length === 0 || returnedUrl.length > 4_096) return false;
  try {
    const returned = new URL(returnedUrl);
    if (returned.username.length > 0 || returned.password.length > 0 || returned.hash.length > 0) return false;
    const isHttps = returned.protocol === 'https:';
    const isLoopback = returned.protocol === 'http:' && returned.hostname === '127.0.0.1';
    if (!isHttps && !isLoopback) return false;
    if (approvedRedirectUri === undefined) return true;
    const approved = new URL(approvedRedirectUri);
    return returned.origin === approved.origin && returned.pathname === approved.pathname;
  } catch {
    return false;
  }
}

export async function signInForAuthorization(
  port: OAuthPort,
  email: string,
  password: string,
): Promise<boolean> {
  if (email.length === 0 || email.length > 320 || password.length === 0 || password.length > 1_024) return false;
  const result = await port.signInWithPassword({ email, password });
  return result.error === null && result.data.user !== null;
}

export async function loadConsent(
  port: OAuthPort,
  authorizationId: string,
): Promise<ConsentLoadResult> {
  const userResult = await port.getUser();
  if (userResult.error !== null || userResult.data.user === null) return { kind: 'login_required' };
  const result = await port.getAuthorizationDetails(authorizationId);
  if (result.error !== null || result.data === null) return { kind: 'error' };
  if ('authorization_id' in result.data) {
    if (result.data.authorization_id !== authorizationId) return { kind: 'error' };
    return { kind: 'consent', details: result.data };
  }
  if (!isSafeReturnedRedirect(result.data.redirect_url)) return { kind: 'error' };
  return { kind: 'redirect', redirectUrl: result.data.redirect_url };
}

export async function decideAuthorization(
  port: OAuthPort,
  decision: 'approve' | 'deny',
  authorizationId: string,
  approvedRedirectUri: string,
): Promise<string | undefined> {
  const result = decision === 'approve'
    ? await port.approveAuthorization(authorizationId)
    : await port.denyAuthorization(authorizationId);
  const redirectUrl = result.data?.redirect_url;
  if (result.error !== null
    || redirectUrl === undefined
    || !isSafeReturnedRedirect(redirectUrl, approvedRedirectUri)) {
    return undefined;
  }
  return redirectUrl;
}

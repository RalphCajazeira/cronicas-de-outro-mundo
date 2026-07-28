import { afterEach, describe, expect, it, vi } from 'vitest';

const extensionId = 'ddmcennimefoiapgjhmienohiapencdm';

function installChrome(options: { readonly accessFails?: boolean; readonly value?: unknown } = {}) {
  const calls: string[] = [];
  const get = vi.fn(() => {
    calls.push('get');
    return Promise.resolve({ 'cronicas.oauth.extension.refresh.v1': options.value });
  });
  Object.assign(globalThis, {
    chrome: {
      runtime: { id: extensionId },
      storage: {
        local: {
          setAccessLevel: vi.fn(() => {
            calls.push('access');
            return options.accessFails ? Promise.reject(new Error('unsupported')) : Promise.resolve();
          }),
          get,
          set: vi.fn(() => Promise.resolve()),
          remove: vi.fn(() => {
            calls.push('remove');
            return Promise.resolve();
          }),
        },
      },
    },
  });
  return { calls, get };
}

function installFetch() {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({
      authorizationEndpoint: 'https://project.supabase.co/auth/v1/oauth/authorize',
      tokenEndpoint: 'https://project.supabase.co/auth/v1/oauth/token',
      clientId: 'public-client',
      resourceUri: 'https://cronicas-de-outro-mundo-staging-api.onrender.com/extension/session',
      scopes: ['openid', 'profile'],
    }),
  })));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('trusted extension storage', () => {
  it('restricts local storage before session recovery', async () => {
    const { calls } = installChrome();
    installFetch();
    const session = await import('../src/background/auth-session.js');
    await expect(session.getAuthState()).resolves.toEqual({ status: 'signed_out' });
    expect(calls).toEqual(['access', 'get']);
  });

  it('fails closed when trusted-context restriction is unavailable', async () => {
    const { get } = installChrome({ accessFails: true });
    installFetch();
    const session = await import('../src/background/auth-session.js');
    await expect(session.getAuthState()).resolves.toEqual({ status: 'error', code: 'configuration_invalid' });
    expect(get).not.toHaveBeenCalled();
  });

  it('removes corrupted persisted session material only after restricting access', async () => {
    const { calls } = installChrome({ value: { unexpected: 'value' } });
    installFetch();
    const session = await import('../src/background/auth-session.js');
    await session.getAuthState();
    expect(calls).toEqual(['access', 'get', 'remove']);
  });
});

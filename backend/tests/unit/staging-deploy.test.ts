import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildDeployHookUrl,
  poll,
  trigger,
  validateExpectedRelease,
  validateStagingBaseUrl,
} from '../../scripts/staging-deploy.js';

const targetSha = 'a'.repeat(40);
const baselineSha = 'b'.repeat(40);
const unexpectedSha = 'c'.repeat(40);
const stagingBaseUrl = 'https://cronicas-de-outro-mundo-staging-api.onrender.com';
const deployHookUrl = 'https://api.render.com/deploy/srv-d99u3tho3t8c738038qg?key=secret-value';
const temporaryDirectories: string[] = [];

function release(commit: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'ok',
    commit,
    branch: 'develop',
    nodeVersion: 'v22.22.0',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function configureEnvironment(overrides: Record<string, string | undefined> = {}): string {
  const directory = mkdtempSync(join(tmpdir(), 'staging-deploy-test-'));
  temporaryDirectories.push(directory);
  vi.stubEnv('GITHUB_OUTPUT', join(directory, 'output'));
  vi.stubEnv('STAGING_TARGET_SHA', targetSha);
  vi.stubEnv('STAGING_PREVIOUS_SHA', baselineSha);
  vi.stubEnv('STAGING_BASE_URL', stagingBaseUrl);
  vi.stubEnv('STAGING_EXPECTED_BRANCH', 'develop');
  vi.stubEnv('STAGING_NODE_VERSION', '22.22.0');
  vi.stubEnv('STAGING_RENDER_SERVICE_ID', 'srv-d99u3tho3t8c738038qg');
  vi.stubEnv('RENDER_STAGING_DEPLOY_HOOK_URL', deployHookUrl);
  vi.stubEnv('STAGING_DEPLOY_TIMEOUT_MS', '60000');
  for (const [name, value] of Object.entries(overrides)) vi.stubEnv(name, value);
  return join(directory, 'output');
}

function output(path: string): string {
  return readFileSync(path, 'utf8');
}

function queuedFetch(...responses: Array<Response | Error>): typeof fetch {
  const queue = [...responses];
  return vi.fn(() => {
    const next = queue.shift();
    if (next === undefined) return Promise.reject(new Error('Unexpected fetch'));
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('staging deploy safety helpers', () => {
  it('builds an exact-commit Render hook URL without replacing its secret key', () => {
    const url = buildDeployHookUrl(deployHookUrl, 'srv-d99u3tho3t8c738038qg', targetSha);
    expect(url.searchParams.get('key')).toBe('secret-value');
    expect(url.searchParams.get('ref')).toBe(targetSha);
    expect(url.hostname).toBe('api.render.com');
  });

  it.each([
    'http://cronicas-de-outro-mundo-staging-api.onrender.com',
    'https://example.com',
    'https://user:password@cronicas-de-outro-mundo-staging-api.onrender.com',
  ])('rejects a staging URL outside the public HTTPS allowlist: %s', (url) => {
    expect(() => validateStagingBaseUrl(url)).toThrow();
  });

  it('normalizes an allowlisted staging base URL', () => {
    expect(validateStagingBaseUrl(stagingBaseUrl).href).toBe(`${stagingBaseUrl}/`);
  });

  it.each([
    ['wrong host', 'https://example.com/deploy/srv-d99u3tho3t8c738038qg?key=secret'],
    ['wrong service', 'https://api.render.com/deploy/srv-other?key=secret'],
    ['missing key', 'https://api.render.com/deploy/srv-d99u3tho3t8c738038qg'],
  ])('rejects a %s deploy hook', (_name, hook) => {
    expect(() => buildDeployHookUrl(hook, 'srv-d99u3tho3t8c738038qg', targetSha)).toThrow();
  });

  it('accepts only the exact commit, develop branch, and pinned Node runtime', () => {
    expect(validateExpectedRelease(release(targetSha), targetSha, 'develop', 'v22.22.0')).toEqual(release(targetSha));
  });

  it.each([
    ['commit', release('b'.repeat(40))],
    ['branch', release(targetSha, { branch: 'main' })],
    ['Node', release(targetSha, { nodeVersion: 'v24.14.1' })],
    ['extra metadata', release(targetSha, { database: 'secret' })],
  ])('rejects a release with an unexpected %s', (_name, value) => {
    expect(() => validateExpectedRelease(value, targetSha, 'develop', 'v22.22.0')).toThrow();
  });
});

describe('staging deploy trigger', () => {
  it.each([
    ['timeout', new Error('AbortError')],
    ['network failure', new Error('network unavailable')],
    ['404', jsonResponse({ error: 'not found' }, 404)],
    ['500', jsonResponse({ error: 'unavailable' }, 500)],
    ['invalid JSON', new Response('{', { status: 200 })],
    ['invalid contract', jsonResponse(release(baselineSha, { branch: '' }))],
    ['invalid SHA', jsonResponse(release('not-a-commit'))],
  ])('aborts before the deploy hook when the live baseline has %s', async (_name, initialResponse) => {
    configureEnvironment();
    const fetchImplementation = queuedFetch(initialResponse);

    await expect(trigger({ fetch: fetchImplementation })).rejects.toThrow('Live staging release baseline is unavailable');
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['200', jsonResponse({ deploy: { id: 'dep-safe123' } }, 200), 'started'],
    ['202', new Response(null, { status: 202 }), 'queued'],
  ])('exports the complete validated baseline when the hook returns %s', async (_status, hookResponse, expectedStatus) => {
    const outputPath = configureEnvironment();
    const fetchImplementation = queuedFetch(jsonResponse(release(baselineSha)), hookResponse);

    await trigger({ fetch: fetchImplementation });

    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(output(outputPath)).toContain(`deploy_status=${expectedStatus}`);
    expect(output(outputPath)).toContain(`previous_release_sha=${baselineSha}`);
    expect(output(outputPath)).not.toContain('previous_release_sha=\n');
  });

  it('skips the hook for a target already live and exports the target as the validated baseline', async () => {
    const outputPath = configureEnvironment();
    const fetchImplementation = queuedFetch(jsonResponse(release(targetSha)));

    await trigger({ fetch: fetchImplementation });

    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(output(outputPath)).toContain('deploy_status=already_live');
    expect(output(outputPath)).toContain(`previous_release_sha=${targetSha}`);
  });
});

describe('staging deploy poll', () => {
  const noWait = (): Promise<void> => Promise.resolve();

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['invalid', 'not-a-commit'],
    ['zero', '0'.repeat(40)],
  ])('requires a complete prior live baseline after a deploy was started: %s', async (_name, previousSha) => {
    configureEnvironment({ STAGING_PREVIOUS_SHA: previousSha });
    const fetchImplementation = queuedFetch(jsonResponse(release(targetSha)));

    await expect(poll({ fetch: fetchImplementation, sleep: noWait })).rejects.toThrow();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('tolerates the validated prior baseline while the target has not entered', async () => {
    configureEnvironment();
    const fetchImplementation = queuedFetch(
      jsonResponse(release(baselineSha)),
      jsonResponse(release(targetSha)),
      jsonResponse({ status: 'ok' }),
      jsonResponse({ status: 'ok' }),
    );

    await expect(poll({ fetch: fetchImplementation, sleep: noWait })).resolves.toBeUndefined();
  });

  it('fails immediately when a different commit becomes live during the rollout', async () => {
    configureEnvironment();
    const fetchImplementation = queuedFetch(jsonResponse(release(unexpectedSha)));

    await expect(poll({ fetch: fetchImplementation, sleep: noWait })).rejects.toThrow(
      'A different commit became live during the staging rollout',
    );
  });

  it('requires health and readiness after the target commit is live', async () => {
    configureEnvironment();
    const fetchImplementation = queuedFetch(
      jsonResponse(release(targetSha)),
      jsonResponse({ status: 'unhealthy' }, 503),
      jsonResponse({ status: 'ok' }),
      jsonResponse(release(targetSha)),
      jsonResponse({ status: 'ok' }),
      jsonResponse({ status: 'ok' }),
    );

    await expect(poll({ fetch: fetchImplementation, sleep: noWait })).resolves.toBeUndefined();
    expect(fetchImplementation).toHaveBeenCalledTimes(6);
  });
});

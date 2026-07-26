import { describe, expect, it } from 'vitest';
import {
  buildDeployHookUrl,
  validateExpectedRelease,
  validateStagingBaseUrl,
} from '../../scripts/staging-deploy.js';

const targetSha = 'a'.repeat(40);

describe('staging deploy safety helpers', () => {
  it('builds an exact-commit Render hook URL without replacing its secret key', () => {
    const url = buildDeployHookUrl(
      'https://api.render.com/deploy/srv-d99u3tho3t8c738038qg?key=secret-value',
      'srv-d99u3tho3t8c738038qg',
      targetSha,
    );
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
    expect(validateStagingBaseUrl(
      'https://cronicas-de-outro-mundo-staging-api.onrender.com',
    ).href).toBe('https://cronicas-de-outro-mundo-staging-api.onrender.com/');
  });

  it.each([
    ['wrong host', 'https://example.com/deploy/srv-d99u3tho3t8c738038qg?key=secret'],
    ['wrong service', 'https://api.render.com/deploy/srv-other?key=secret'],
    ['missing key', 'https://api.render.com/deploy/srv-d99u3tho3t8c738038qg'],
  ])('rejects a %s deploy hook', (_name, hook) => {
    expect(() => buildDeployHookUrl(hook, 'srv-d99u3tho3t8c738038qg', targetSha)).toThrow();
  });

  it('accepts only the exact commit, develop branch, and pinned Node runtime', () => {
    expect(validateExpectedRelease({
      status: 'ok',
      commit: targetSha,
      branch: 'develop',
      nodeVersion: 'v22.22.0',
    }, targetSha, 'develop', 'v22.22.0')).toEqual({
      status: 'ok',
      commit: targetSha,
      branch: 'develop',
      nodeVersion: 'v22.22.0',
    });
  });

  it.each([
    ['commit', { status: 'ok', commit: 'b'.repeat(40), branch: 'develop', nodeVersion: 'v22.22.0' }],
    ['branch', { status: 'ok', commit: targetSha, branch: 'main', nodeVersion: 'v22.22.0' }],
    ['Node', { status: 'ok', commit: targetSha, branch: 'develop', nodeVersion: 'v24.14.1' }],
    ['extra metadata', { status: 'ok', commit: targetSha, branch: 'develop', nodeVersion: 'v22.22.0', database: 'secret' }],
  ])('rejects a release with an unexpected %s', (_name, release) => {
    expect(() => validateExpectedRelease(release, targetSha, 'develop', 'v22.22.0')).toThrow();
  });
});

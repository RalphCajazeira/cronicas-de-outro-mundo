import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const DEPLOY_ID = /^dep-[a-z0-9]+$/u;
const releaseInfoSchema = z.object({
  status: z.literal('ok'),
  commit: z.string().regex(COMMIT_SHA),
  branch: z.string().min(1).max(128),
  nodeVersion: z.string().regex(/^v\d+\.\d+\.\d+$/u),
}).strict();

export interface ReleaseInfo {
  status: 'ok';
  commit: string;
  branch: string;
  nodeVersion: string;
}

class SafePipelineError extends Error {}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new SafePipelineError(`Required staging setting is missing: ${name}`);
  return value;
}

function validateCommit(value: string, name: string): string {
  const normalized = value.trim().toLowerCase();
  if (!COMMIT_SHA.test(normalized)) throw new SafePipelineError(`${name} must be a full commit SHA`);
  return normalized;
}

export function validateStagingBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SafePipelineError('Staging base URL is invalid');
  }
  if (
    url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || url.search !== ''
    || url.hash !== ''
    || !url.hostname.endsWith('.onrender.com')
  ) {
    throw new SafePipelineError('Staging base URL is outside the Render allowlist');
  }
  url.pathname = '/';
  return url;
}

export function buildDeployHookUrl(hookValue: string, serviceId: string, commit: string): URL {
  let hook: URL;
  try {
    hook = new URL(hookValue);
  } catch {
    throw new SafePipelineError('Render deploy hook is invalid');
  }
  if (
    hook.protocol !== 'https:'
    || hook.hostname !== 'api.render.com'
    || !hook.pathname.includes(serviceId)
    || hook.searchParams.get('key') === null
  ) {
    throw new SafePipelineError('Render deploy hook does not match the staging service');
  }
  hook.searchParams.set('ref', validateCommit(commit, 'Target commit'));
  return hook;
}

export function validateExpectedRelease(
  value: unknown,
  targetCommit: string,
  expectedBranch: string,
  expectedNodeVersion: string,
): ReleaseInfo {
  const parsed = releaseInfoSchema.safeParse(value);
  if (!parsed.success) throw new SafePipelineError('Release endpoint returned an invalid contract');
  if (parsed.data.commit !== targetCommit) throw new SafePipelineError('Release endpoint returned a different commit');
  if (parsed.data.branch !== expectedBranch) throw new SafePipelineError('Release endpoint returned a different branch');
  if (parsed.data.nodeVersion !== expectedNodeVersion) throw new SafePipelineError('Release endpoint returned a different Node version');
  return parsed.data;
}

async function fetchWithTimeout(url: URL, init: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function currentRelease(baseUrl: URL): Promise<ReleaseInfo | null> {
  try {
    const response = await fetchWithTimeout(new URL('/health/version', baseUrl));
    if (response.status === 404) return null;
    if (!response.ok) return null;
    const parsed = releaseInfoSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function appendOutput(lines: string[]): void {
  const output = process.env.GITHUB_OUTPUT;
  if (output !== undefined) appendFileSync(output, `${lines.join('\n')}\n`);
}

function appendSummary(lines: string[]): void {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary !== undefined) appendFileSync(summary, `${lines.join('\n')}\n`);
}

async function trigger(): Promise<void> {
  const targetCommit = validateCommit(requiredEnvironment('STAGING_TARGET_SHA'), 'Target commit');
  const baseUrl = validateStagingBaseUrl(requiredEnvironment('STAGING_BASE_URL'));
  const existing = await currentRelease(baseUrl);
  if (existing?.commit === targetCommit) {
    console.info('Target commit is already live; deploy hook was not called');
    appendOutput(['deploy_status=already_live', 'deploy_id=', `previous_release_sha=${existing.commit}`]);
    appendSummary(['## Render deploy', '', '- Deploy hook: skipped (target already live)', `- Target commit: \`${targetCommit}\``, '']);
    return;
  }

  const hook = buildDeployHookUrl(
    requiredEnvironment('RENDER_STAGING_DEPLOY_HOOK_URL'),
    requiredEnvironment('STAGING_RENDER_SERVICE_ID'),
    targetCommit,
  );
  const response = await fetchWithTimeout(hook, { method: 'POST', redirect: 'error' }, 30_000);
  if (![200, 202].includes(response.status)) throw new SafePipelineError(`Render rejected the deploy request with status ${response.status}`);

  let deployId = '';
  if (response.status === 200) {
    const body: unknown = await response.json();
    if (
      typeof body !== 'object'
      || body === null
      || !('deploy' in body)
      || typeof body.deploy !== 'object'
      || body.deploy === null
      || !('id' in body.deploy)
      || typeof body.deploy.id !== 'string'
      || !DEPLOY_ID.test(body.deploy.id)
    ) {
      throw new SafePipelineError('Render deploy response did not include a safe deploy ID');
    }
    deployId = body.deploy.id;
  }

  const deployStatus = response.status === 200 ? 'started' : 'queued';
  console.info(`Render deploy ${deployStatus} for the exact target commit`);
  appendOutput([
    `deploy_status=${deployStatus}`,
    `deploy_id=${deployId}`,
    `previous_release_sha=${existing?.commit ?? ''}`,
  ]);
  appendSummary([
    '## Render deploy',
    '',
    `- Target commit: \`${targetCommit}\``,
    `- Request status: ${deployStatus}`,
    `- Deploy ID: ${deployId === '' ? 'not returned' : `\`${deployId}\``}`,
    '',
  ]);
}

async function poll(): Promise<void> {
  const targetCommit = validateCommit(requiredEnvironment('STAGING_TARGET_SHA'), 'Target commit');
  const previousCommitValue = process.env.STAGING_PREVIOUS_SHA?.trim().toLowerCase();
  const previousCommit = previousCommitValue === undefined || ZERO_OR_EMPTY(previousCommitValue)
    ? undefined
    : validateCommit(previousCommitValue, 'Previous commit');
  const expectedBranch = requiredEnvironment('STAGING_EXPECTED_BRANCH');
  const expectedNodeVersion = `v${requiredEnvironment('STAGING_NODE_VERSION')}`;
  const baseUrl = validateStagingBaseUrl(requiredEnvironment('STAGING_BASE_URL'));
  const timeoutMs = Number.parseInt(process.env.STAGING_DEPLOY_TIMEOUT_MS ?? '1800000', 10);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 60_000 || timeoutMs > 3_600_000) {
    throw new SafePipelineError('Render polling timeout is outside the allowlist');
  }

  const startedAt = Date.now();
  let attempt = 0;
  while (Date.now() - startedAt < timeoutMs) {
    attempt += 1;
    const release = await currentRelease(baseUrl);
    if (release !== null && release.commit !== targetCommit && previousCommit !== undefined && release.commit !== previousCommit) {
      throw new SafePipelineError('A different commit became live during the staging rollout');
    }
    if (release?.commit === targetCommit) {
      validateExpectedRelease(release, targetCommit, expectedBranch, expectedNodeVersion);
      const [health, readiness] = await Promise.all([
        fetchWithTimeout(new URL('/health', baseUrl)).catch(() => null),
        fetchWithTimeout(new URL('/health/ready', baseUrl)).catch(() => null),
      ]);
      if (health?.status === 200 && readiness?.status === 200) {
        const durationSeconds = Math.round((Date.now() - startedAt) / 1_000);
        console.info(`Exact staging commit is healthy after ${durationSeconds}s`);
        appendSummary([
          '## Staging health',
          '',
          `- Commit live: \`${targetCommit}\``,
          `- Branch: \`${expectedBranch}\``,
          `- Node: \`${expectedNodeVersion}\``,
          '- `/health`: 200',
          '- `/health/ready`: 200',
          `- Poll duration: ${durationSeconds}s`,
          '',
        ]);
        return;
      }
    }

    if (attempt === 1 || attempt % 6 === 0) console.info(`Waiting for exact staging commit (attempt ${attempt})`);
    const intervalMs = Math.min(20_000, 8_000 + attempt * 1_000);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
  throw new SafePipelineError('Timed out waiting for the exact staging commit');
}

function ZERO_OR_EMPTY(value: string): boolean {
  return value.length === 0 || /^0{40}$/u.test(value);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'trigger') await trigger();
  else if (command === 'poll') await poll();
  else throw new SafePipelineError('Expected trigger or poll command');
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof SafePipelineError ? error.message : 'Staging deploy orchestration failed safely');
    process.exitCode = 1;
  });
}

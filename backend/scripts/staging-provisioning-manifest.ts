import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { EMPTY_TREE_SHA, resolveRequestedBase } from './classify-migrations.js';

export const AUTHENTICATED_FIXTURE_MANIFEST_PATH =
  'backend/provisioning/staging/authenticated-readonly-fixture.v1.json';

const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const REPOSITORY_ROOT = resolve(import.meta.dirname, '../..');
const manifestSchema = z.object({
  operationId: z.literal('authenticated-readonly-fixture-v1'),
  executionRevision: z.literal(2),
  environment: z.literal('staging'),
  type: z.literal('AUTHENTICATED_READONLY_FIXTURE'),
  enabled: z.literal(true),
  expectedRecords: z.object({
    player: z.literal(1),
    world: z.literal(1),
    campaign: z.literal(1),
    actor: z.literal(1),
    campaignMembership: z.literal(1),
    actorControl: z.literal(1),
    actorAttribute: z.literal(9),
    actorResource: z.literal(3),
    actorDerivedSnapshot: z.literal(1),
    contentDefinition: z.literal(7),
    contentVersion: z.literal(7),
    inventoryEntry: z.literal(3),
    equipmentSlot: z.literal(1),
    actorContent: z.literal(3),
    activeEffect: z.literal(1),
  }).strict(),
}).strict();

export type AuthenticatedFixtureManifest = z.infer<typeof manifestSchema>;

export interface ProvisioningManifestDetection {
  readonly base: string;
  readonly head: string;
  readonly fallback: 'none' | 'empty-tree';
  readonly changed: boolean;
  readonly manifest?: AuthenticatedFixtureManifest;
}

function git(arguments_: string[]): string {
  return execFileSync('git', arguments_, {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function verifyCommit(sha: string): void {
  git(['cat-file', '-e', `${sha}^{commit}`]);
}

export function parseAuthenticatedFixtureManifest(value: unknown): AuthenticatedFixtureManifest {
  return manifestSchema.parse(value);
}

export function parseProvisioningManifestChange(nameStatus: string): boolean {
  const entries = nameStatus.split(/\r?\n/u).filter(Boolean);
  if (entries.length === 0) return false;
  if (entries.length !== 1) throw new Error('Provisioning manifest range is ambiguous');
  const [status, path, renamedPath] = entries[0]?.split('\t') ?? [];
  if (
    path !== AUTHENTICATED_FIXTURE_MANIFEST_PATH
    || renamedPath !== undefined
    || (status !== 'A' && status !== 'M')
  ) {
    throw new Error('Provisioning manifest history change is not allowed');
  }
  return true;
}

export function detectProvisioningManifest(
  baseInput: string,
  headInput: string,
): ProvisioningManifestDetection {
  const head = headInput.trim().toLowerCase();
  if (!COMMIT_SHA.test(head)) throw new Error('head SHA must be a full commit SHA');
  const range = resolveRequestedBase(baseInput);
  verifyCommit(head);
  if (range.fallback === 'none') {
    verifyCommit(range.base);
    execFileSync('git', ['merge-base', '--is-ancestor', range.base, head], {
      cwd: REPOSITORY_ROOT,
      stdio: 'ignore',
    });
  }
  const nameStatus = git([
    'diff',
    '--name-status',
    '--no-renames',
    range.base,
    head,
    '--',
    AUTHENTICATED_FIXTURE_MANIFEST_PATH,
  ]);
  const changed = parseProvisioningManifestChange(nameStatus);
  if (!changed) {
    return {
      base: range.base,
      head,
      fallback: range.base === EMPTY_TREE_SHA ? 'empty-tree' : 'none',
      changed: false,
    };
  }
  const rawManifest = git(['show', `${head}:${AUTHENTICATED_FIXTURE_MANIFEST_PATH}`]);
  const manifest = parseAuthenticatedFixtureManifest(JSON.parse(rawManifest) as unknown);
  return {
    base: range.base,
    head,
    fallback: range.base === EMPTY_TREE_SHA ? 'empty-tree' : 'none',
    changed: true,
    manifest,
  };
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function appendGitHubMetadata(detection: ProvisioningManifestDetection): void {
  const output = process.env.GITHUB_OUTPUT;
  if (output !== undefined) {
    appendFileSync(output, [
      `changed=${String(detection.changed)}`,
      `base=${detection.base}`,
      `head=${detection.head}`,
      `fallback=${detection.fallback}`,
      `operation_id=${detection.manifest?.operationId ?? ''}`,
    ].join('\n') + '\n');
  }
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary !== undefined) {
    appendFileSync(summary, [
      '## Protected staging provisioning detection',
      '',
      `- Base: \`${detection.base}\``,
      `- Head: \`${detection.head}\``,
      `- Range fallback: \`${detection.fallback}\``,
      `- Manifest changed: **${String(detection.changed)}**`,
      ...(detection.manifest === undefined
        ? []
        : [
            `- Operation: \`${detection.manifest.operationId}\``,
            `- Manifest: \`${AUTHENTICATED_FIXTURE_MANIFEST_PATH}\``,
          ]),
      '',
    ].join('\n'));
  }
}

function main(): void {
  const base = argument('--base');
  const head = argument('--head');
  if (base === undefined || head === undefined) throw new Error('--base and --head are required');
  const detection = detectProvisioningManifest(base, head);
  process.stdout.write(`${JSON.stringify({
    changed: detection.changed,
    operationId: detection.manifest?.operationId ?? null,
  })}\n`);
  appendGitHubMetadata(detection);
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch {
    console.error('Protected staging provisioning manifest detection failed closed');
    process.exitCode = 1;
  }
}

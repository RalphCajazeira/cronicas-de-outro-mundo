import { Prisma } from '../../generated/prisma/client.js';
import { createAfterExpectedUnique } from '../../shared/database/create-after-expected-unique.js';
import { canonicalJson } from '../../shared/json/canonical-json.js';
import {
  CORE_V1_CONTENT_PROFILE_CANONICAL_JSON,
  CORE_V1_CONTENT_PROFILE_CODE,
  CORE_V1_CONTENT_PROFILE_HASH,
  CORE_V1_CONTENT_PROFILE_SCHEMA_VERSION,
  CORE_V1_CONTENT_PROFILE_SNAPSHOT,
} from './core-v1/core-v1.content-profile.manifest.js';
import { ensureCoreV1RulesetVersion, type RulesetRegistryClient } from './ruleset.registry.js';

export const CORE_CONTENT_PROFILE_VERSION_DRIFT = 'CORE_CONTENT_PROFILE_VERSION_DRIFT' as const;
export type ContentProfileDriftField = 'rulesetVersion' | 'code' | 'schemaVersion' | 'configHash' | 'configSnapshot';

export class CoreContentProfileVersionDriftError extends Error {
  readonly code = CORE_CONTENT_PROFILE_VERSION_DRIFT;

  constructor(public readonly fields: readonly ContentProfileDriftField[]) {
    super('Published core-v1 content profile does not match the official configuration');
    this.name = 'CoreContentProfileVersionDriftError';
  }
}

const contentProfileSelect = {
  id: true,
  rulesetVersionId: true,
  code: true,
  schemaVersion: true,
  configHash: true,
  configSnapshot: true,
} satisfies Prisma.ContentProfileVersionSelect;

export type CoreContentProfileVersion = Prisma.ContentProfileVersionGetPayload<{ select: typeof contentProfileSelect }>;
export type ContentProfileRegistryClient = RulesetRegistryClient & Pick<Prisma.TransactionClient, 'contentProfileVersion'>;

export function validateCoreV1ContentProfileVersion(
  version: CoreContentProfileVersion,
  rulesetVersionId: string,
): CoreContentProfileVersion {
  const drift: ContentProfileDriftField[] = [];
  if (version.rulesetVersionId !== rulesetVersionId) drift.push('rulesetVersion');
  if (version.code !== CORE_V1_CONTENT_PROFILE_CODE) drift.push('code');
  if (version.schemaVersion !== CORE_V1_CONTENT_PROFILE_SCHEMA_VERSION) drift.push('schemaVersion');
  if (version.configHash !== CORE_V1_CONTENT_PROFILE_HASH) drift.push('configHash');
  try {
    if (canonicalJson(version.configSnapshot) !== canonicalJson(CORE_V1_CONTENT_PROFILE_SNAPSHOT)) drift.push('configSnapshot');
  } catch {
    drift.push('configSnapshot');
  }
  if (drift.length > 0) throw new CoreContentProfileVersionDriftError(drift);
  return version;
}

export async function ensureCoreV1ContentProfileVersion(
  client: ContentProfileRegistryClient,
  resolvedRulesetVersion?: Awaited<ReturnType<typeof ensureCoreV1RulesetVersion>>,
): Promise<CoreContentProfileVersion> {
  const rulesetVersion = resolvedRulesetVersion ?? await ensureCoreV1RulesetVersion(client);
  let version = await client.contentProfileVersion.findUnique({
    where: { code: CORE_V1_CONTENT_PROFILE_CODE },
    select: contentProfileSelect,
  });
  version ??= await createAfterExpectedUnique(
    client,
    'ensure_core_content_profile_version',
    () => client.contentProfileVersion.create({
      data: {
        rulesetVersionId: rulesetVersion.id,
        code: CORE_V1_CONTENT_PROFILE_CODE,
        schemaVersion: CORE_V1_CONTENT_PROFILE_SCHEMA_VERSION,
        configHash: CORE_V1_CONTENT_PROFILE_HASH,
        configSnapshot: JSON.parse(CORE_V1_CONTENT_PROFILE_CANONICAL_JSON) as Prisma.InputJsonValue,
      },
      select: contentProfileSelect,
    }),
    () => client.contentProfileVersion.findUnique({
      where: { code: CORE_V1_CONTENT_PROFILE_CODE },
      select: contentProfileSelect,
    }),
    {
      modelName: 'ContentProfileVersion',
      fields: ['code'],
      index: 'ContentProfileVersion_code_key',
      allowModelOnly: true,
    },
  );
  return validateCoreV1ContentProfileVersion(version, rulesetVersion.id);
}

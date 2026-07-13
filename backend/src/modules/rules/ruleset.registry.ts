import { Prisma } from '../../generated/prisma/client.js';
import { createAfterExpectedUnique } from '../../shared/database/create-after-expected-unique.js';
import { canonicalJson } from '../../shared/json/canonical-json.js';
import {
  CORE_V1_CONFIG_HASH,
  CORE_V1_CONFIG_CANONICAL_JSON,
  CORE_V1_CONFIG_SNAPSHOT,
  CORE_V1_REVISION,
  CORE_V1_RULESET_CODE,
  CORE_V1_RULESET_NAME,
  CORE_V1_SCHEMA_VERSION,
  CORE_V1_VERSION_CODE,
} from './core-v1/core-v1.manifest.js';

export const CORE_RULESET_VERSION_DRIFT = 'CORE_RULESET_VERSION_DRIFT' as const;

export type CoreRulesetDriftField = 'rulesetCode' | 'revision' | 'schemaVersion' | 'configHash' | 'configSnapshot';

export class CoreRulesetVersionDriftError extends Error {
  readonly code = CORE_RULESET_VERSION_DRIFT;

  constructor(public readonly fields: readonly CoreRulesetDriftField[]) {
    super('Published core-v1 ruleset does not match the official configuration');
    this.name = 'CoreRulesetVersionDriftError';
  }
}

const versionSelect = {
  id: true,
  rulesetId: true,
  code: true,
  revision: true,
  schemaVersion: true,
  configHash: true,
  configSnapshot: true,
  ruleset: { select: { code: true } },
} satisfies Prisma.RulesetVersionSelect;

export type CoreRulesetVersion = Prisma.RulesetVersionGetPayload<{ select: typeof versionSelect }>;
export type RulesetRegistryClient = Pick<
  Prisma.TransactionClient,
  'ruleset' | 'rulesetVersion' | '$executeRawUnsafe'
>;

export function validateCoreV1RulesetVersion(version: CoreRulesetVersion): CoreRulesetVersion {
  const drift: CoreRulesetDriftField[] = [];
  if (version.ruleset.code !== CORE_V1_RULESET_CODE) drift.push('rulesetCode');
  if (version.revision !== CORE_V1_REVISION) drift.push('revision');
  if (version.schemaVersion !== CORE_V1_SCHEMA_VERSION) drift.push('schemaVersion');
  if (version.configHash !== CORE_V1_CONFIG_HASH) drift.push('configHash');
  try {
    if (canonicalJson(version.configSnapshot) !== canonicalJson(CORE_V1_CONFIG_SNAPSHOT)) drift.push('configSnapshot');
  } catch {
    drift.push('configSnapshot');
  }
  if (drift.length > 0) throw new CoreRulesetVersionDriftError(drift);
  return version;
}

export async function ensureCoreV1RulesetVersion(client: RulesetRegistryClient): Promise<CoreRulesetVersion> {
  let ruleset = await client.ruleset.findUnique({ where: { code: CORE_V1_RULESET_CODE }, select: { id: true } });
  ruleset ??= await createAfterExpectedUnique(
    client,
    'ensure_core_ruleset',
    () => client.ruleset.create({
      data: { code: CORE_V1_RULESET_CODE, name: CORE_V1_RULESET_NAME },
      select: { id: true },
    }),
    () => client.ruleset.findUnique({ where: { code: CORE_V1_RULESET_CODE }, select: { id: true } }),
    { modelName: 'Ruleset', fields: ['code'], index: 'Ruleset_code_key', allowModelOnly: true },
  );

  let version = await client.rulesetVersion.findUnique({ where: { code: CORE_V1_VERSION_CODE }, select: versionSelect });
  version ??= await createAfterExpectedUnique(
    client,
    'ensure_core_ruleset_version',
    () => client.rulesetVersion.create({
      data: {
        rulesetId: ruleset.id,
        code: CORE_V1_VERSION_CODE,
        revision: CORE_V1_REVISION,
        schemaVersion: CORE_V1_SCHEMA_VERSION,
        configHash: CORE_V1_CONFIG_HASH,
        configSnapshot: JSON.parse(CORE_V1_CONFIG_CANONICAL_JSON) as Prisma.InputJsonValue,
      },
      select: versionSelect,
    }),
    () => client.rulesetVersion.findUnique({ where: { code: CORE_V1_VERSION_CODE }, select: versionSelect }),
    { modelName: 'RulesetVersion', fields: ['code'], index: 'RulesetVersion_code_key', allowModelOnly: true },
  );

  if (version.rulesetId !== ruleset.id) throw new CoreRulesetVersionDriftError(['rulesetCode']);
  return validateCoreV1RulesetVersion(version);
}

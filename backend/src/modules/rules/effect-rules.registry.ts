import { Prisma } from '../../generated/prisma/client.js';
import { createAfterExpectedUnique } from '../../shared/database/create-after-expected-unique.js';
import { canonicalJson } from '../../shared/json/canonical-json.js';
import {
  CORE_V1_EFFECT_RULES_CANONICAL_JSON,
  CORE_V1_EFFECT_RULES_HASH,
  CORE_V1_EFFECT_RULES_SNAPSHOT,
} from './core-v1/core-v1.effects.manifest.js';
import {
  CORE_V1_EFFECT_RULES_CODE,
  CORE_V1_EFFECT_SCHEMA_VERSION,
} from './core-v1/core-v1.effects.config.js';
import { ensureCoreV1RulesetVersion, type RulesetRegistryClient } from './ruleset.registry.js';

export const CORE_EFFECT_RULES_VERSION_DRIFT = 'CORE_EFFECT_RULES_VERSION_DRIFT' as const;
export type EffectRulesDriftField = 'rulesetVersion' | 'code' | 'schemaVersion' | 'configHash' | 'configSnapshot';

export class CoreEffectRulesVersionDriftError extends Error {
  readonly code = CORE_EFFECT_RULES_VERSION_DRIFT;

  constructor(public readonly fields: readonly EffectRulesDriftField[]) {
    super('Published core-v1 effect rules do not match the official configuration');
    this.name = 'CoreEffectRulesVersionDriftError';
  }
}

const effectRulesSelect = {
  id: true, rulesetVersionId: true, code: true, schemaVersion: true, configHash: true, configSnapshot: true,
} satisfies Prisma.EffectRulesVersionSelect;

export type CoreEffectRulesVersion = Prisma.EffectRulesVersionGetPayload<{ select: typeof effectRulesSelect }>;
export type EffectRulesRegistryClient = RulesetRegistryClient & Pick<Prisma.TransactionClient, 'effectRulesVersion'>;

export function validateCoreV1EffectRulesVersion(
  version: CoreEffectRulesVersion,
  rulesetVersionId: string,
): CoreEffectRulesVersion {
  const drift: EffectRulesDriftField[] = [];
  if (version.rulesetVersionId !== rulesetVersionId) drift.push('rulesetVersion');
  if (version.code !== CORE_V1_EFFECT_RULES_CODE) drift.push('code');
  if (version.schemaVersion !== CORE_V1_EFFECT_SCHEMA_VERSION) drift.push('schemaVersion');
  if (version.configHash !== CORE_V1_EFFECT_RULES_HASH) drift.push('configHash');
  try {
    if (canonicalJson(version.configSnapshot) !== canonicalJson(CORE_V1_EFFECT_RULES_SNAPSHOT)) drift.push('configSnapshot');
  } catch {
    drift.push('configSnapshot');
  }
  if (drift.length > 0) throw new CoreEffectRulesVersionDriftError(drift);
  return version;
}

export async function ensureCoreV1EffectRulesVersion(
  client: EffectRulesRegistryClient,
): Promise<CoreEffectRulesVersion> {
  const rulesetVersion = await ensureCoreV1RulesetVersion(client);
  let version = await client.effectRulesVersion.findUnique({
    where: { code: CORE_V1_EFFECT_RULES_CODE }, select: effectRulesSelect,
  });
  version ??= await createAfterExpectedUnique(
    client,
    'ensure_core_effect_rules_version',
    () => client.effectRulesVersion.create({
      data: {
        rulesetVersionId: rulesetVersion.id,
        code: CORE_V1_EFFECT_RULES_CODE,
        schemaVersion: CORE_V1_EFFECT_SCHEMA_VERSION,
        configHash: CORE_V1_EFFECT_RULES_HASH,
        configSnapshot: JSON.parse(CORE_V1_EFFECT_RULES_CANONICAL_JSON) as Prisma.InputJsonValue,
      },
      select: effectRulesSelect,
    }),
    () => client.effectRulesVersion.findUnique({
      where: { code: CORE_V1_EFFECT_RULES_CODE }, select: effectRulesSelect,
    }),
    {
      modelName: 'EffectRulesVersion', fields: ['code'],
      index: 'EffectRulesVersion_code_key', allowModelOnly: true,
    },
  );
  return validateCoreV1EffectRulesVersion(version, rulesetVersion.id);
}

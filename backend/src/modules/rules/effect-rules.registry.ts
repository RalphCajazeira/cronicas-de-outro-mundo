import { createHash } from 'node:crypto';
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
import {
  ensureCoreV1RulesetVersion,
  type CoreRulesetVersion,
  type RulesetRegistryClient,
} from './ruleset.registry.js';

export const CORE_V1_2_EFFECT_RULES_CODE = 'core-v1.2-effects-v1' as const;
const coreV12EffectSnapshot = structuredClone(CORE_V1_EFFECT_RULES_SNAPSHOT) as { identity: { code: string } };
coreV12EffectSnapshot.identity.code = CORE_V1_2_EFFECT_RULES_CODE;
const CORE_V1_2_EFFECT_CANONICAL_JSON = canonicalJson(coreV12EffectSnapshot);
export const CORE_V1_2_EFFECT_HASH = createHash('sha256').update(CORE_V1_2_EFFECT_CANONICAL_JSON).digest('hex');

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
  resolvedRulesetVersion?: Awaited<ReturnType<typeof ensureCoreV1RulesetVersion>>,
): Promise<CoreEffectRulesVersion> {
  const rulesetVersion = resolvedRulesetVersion ?? await ensureCoreV1RulesetVersion(client);
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

export async function ensureCoreV12EffectRulesVersion(
  client: EffectRulesRegistryClient,
  rulesetVersion: CoreRulesetVersion,
): Promise<CoreEffectRulesVersion> {
  let version = await client.effectRulesVersion.findUnique({
    where: { code: CORE_V1_2_EFFECT_RULES_CODE }, select: effectRulesSelect,
  });
  version ??= await createAfterExpectedUnique(
    client,
    'ensure_core_v1_2_effects',
    () => client.effectRulesVersion.create({
      data: {
        rulesetVersionId: rulesetVersion.id,
        code: CORE_V1_2_EFFECT_RULES_CODE,
        schemaVersion: CORE_V1_EFFECT_SCHEMA_VERSION,
        configHash: CORE_V1_2_EFFECT_HASH,
        configSnapshot: JSON.parse(CORE_V1_2_EFFECT_CANONICAL_JSON) as Prisma.InputJsonValue,
      },
      select: effectRulesSelect,
    }),
    () => client.effectRulesVersion.findUnique({
      where: { code: CORE_V1_2_EFFECT_RULES_CODE }, select: effectRulesSelect,
    }),
    { modelName: 'EffectRulesVersion', fields: ['code'], index: 'EffectRulesVersion_code_key', allowModelOnly: true },
  );
  if (version.rulesetVersionId !== rulesetVersion.id || version.code !== CORE_V1_2_EFFECT_RULES_CODE
    || version.schemaVersion !== CORE_V1_EFFECT_SCHEMA_VERSION
    || version.configHash !== CORE_V1_2_EFFECT_HASH
    || canonicalJson(version.configSnapshot) !== CORE_V1_2_EFFECT_CANONICAL_JSON) {
    throw new CoreEffectRulesVersionDriftError(['rulesetVersion']);
  }
  return version;
}

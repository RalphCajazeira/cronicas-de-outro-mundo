import { createHash } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client.js';
import { createAfterExpectedUnique } from '../../shared/database/create-after-expected-unique.js';
import { canonicalJson } from '../../shared/json/canonical-json.js';
import {
  CORE_V1_INVENTORY_RULES_CANONICAL_JSON,
  CORE_V1_INVENTORY_RULES_HASH,
  CORE_V1_INVENTORY_RULES_SNAPSHOT,
} from './core-v1/core-v1.inventory.manifest.js';
import {
  CORE_V1_INVENTORY_RULES_CODE,
  CORE_V1_INVENTORY_SCHEMA_VERSION,
} from './core-v1/core-v1.inventory.config.js';
import {
  ensureCoreV1RulesetVersion,
  type CoreRulesetVersion,
  type RulesetRegistryClient,
} from './ruleset.registry.js';

export const CORE_V1_2_INVENTORY_RULES_CODE = 'core-v1.2-inventory-v1' as const;
const coreV12InventorySnapshot = structuredClone(CORE_V1_INVENTORY_RULES_SNAPSHOT) as { identity: { code: string } };
coreV12InventorySnapshot.identity.code = CORE_V1_2_INVENTORY_RULES_CODE;
const CORE_V1_2_INVENTORY_CANONICAL_JSON = canonicalJson(coreV12InventorySnapshot);
export const CORE_V1_2_INVENTORY_HASH = createHash('sha256').update(CORE_V1_2_INVENTORY_CANONICAL_JSON).digest('hex');

export const CORE_INVENTORY_RULES_VERSION_DRIFT = 'CORE_INVENTORY_RULES_VERSION_DRIFT' as const;
export type InventoryRulesDriftField = 'rulesetVersion' | 'code' | 'schemaVersion' | 'configHash' | 'configSnapshot';

export class CoreInventoryRulesVersionDriftError extends Error {
  readonly code = CORE_INVENTORY_RULES_VERSION_DRIFT;

  constructor(public readonly fields: readonly InventoryRulesDriftField[]) {
    super('Published core-v1 inventory rules do not match the official configuration');
    this.name = 'CoreInventoryRulesVersionDriftError';
  }
}

const inventoryRulesSelect = {
  id: true, rulesetVersionId: true, code: true, schemaVersion: true, configHash: true, configSnapshot: true,
} satisfies Prisma.InventoryRulesVersionSelect;

export type CoreInventoryRulesVersion = Prisma.InventoryRulesVersionGetPayload<{ select: typeof inventoryRulesSelect }>;
export type InventoryRulesRegistryClient = RulesetRegistryClient & Pick<Prisma.TransactionClient, 'inventoryRulesVersion'>;

export function validateCoreV1InventoryRulesVersion(
  version: CoreInventoryRulesVersion,
  rulesetVersionId: string,
): CoreInventoryRulesVersion {
  const drift: InventoryRulesDriftField[] = [];
  if (version.rulesetVersionId !== rulesetVersionId) drift.push('rulesetVersion');
  if (version.code !== CORE_V1_INVENTORY_RULES_CODE) drift.push('code');
  if (version.schemaVersion !== CORE_V1_INVENTORY_SCHEMA_VERSION) drift.push('schemaVersion');
  if (version.configHash !== CORE_V1_INVENTORY_RULES_HASH) drift.push('configHash');
  try {
    if (canonicalJson(version.configSnapshot) !== canonicalJson(CORE_V1_INVENTORY_RULES_SNAPSHOT)) drift.push('configSnapshot');
  } catch {
    drift.push('configSnapshot');
  }
  if (drift.length > 0) throw new CoreInventoryRulesVersionDriftError(drift);
  return version;
}

export async function ensureCoreV1InventoryRulesVersion(
  client: InventoryRulesRegistryClient,
  resolvedRulesetVersion?: Awaited<ReturnType<typeof ensureCoreV1RulesetVersion>>,
): Promise<CoreInventoryRulesVersion> {
  const rulesetVersion = resolvedRulesetVersion ?? await ensureCoreV1RulesetVersion(client);
  let version = await client.inventoryRulesVersion.findUnique({
    where: { code: CORE_V1_INVENTORY_RULES_CODE }, select: inventoryRulesSelect,
  });
  version ??= await createAfterExpectedUnique(
    client,
    'ensure_core_inventory_rules_version',
    () => client.inventoryRulesVersion.create({
      data: {
        rulesetVersionId: rulesetVersion.id,
        code: CORE_V1_INVENTORY_RULES_CODE,
        schemaVersion: CORE_V1_INVENTORY_SCHEMA_VERSION,
        configHash: CORE_V1_INVENTORY_RULES_HASH,
        configSnapshot: JSON.parse(CORE_V1_INVENTORY_RULES_CANONICAL_JSON) as Prisma.InputJsonValue,
      },
      select: inventoryRulesSelect,
    }),
    () => client.inventoryRulesVersion.findUnique({
      where: { code: CORE_V1_INVENTORY_RULES_CODE }, select: inventoryRulesSelect,
    }),
    {
      modelName: 'InventoryRulesVersion', fields: ['code'],
      index: 'InventoryRulesVersion_code_key', allowModelOnly: true,
    },
  );
  return validateCoreV1InventoryRulesVersion(version, rulesetVersion.id);
}

export async function ensureCoreV12InventoryRulesVersion(
  client: InventoryRulesRegistryClient,
  rulesetVersion: CoreRulesetVersion,
): Promise<CoreInventoryRulesVersion> {
  let version = await client.inventoryRulesVersion.findUnique({
    where: { code: CORE_V1_2_INVENTORY_RULES_CODE }, select: inventoryRulesSelect,
  });
  version ??= await createAfterExpectedUnique(
    client,
    'ensure_core_v1_2_inventory',
    () => client.inventoryRulesVersion.create({
      data: {
        rulesetVersionId: rulesetVersion.id,
        code: CORE_V1_2_INVENTORY_RULES_CODE,
        schemaVersion: CORE_V1_INVENTORY_SCHEMA_VERSION,
        configHash: CORE_V1_2_INVENTORY_HASH,
        configSnapshot: JSON.parse(CORE_V1_2_INVENTORY_CANONICAL_JSON) as Prisma.InputJsonValue,
      },
      select: inventoryRulesSelect,
    }),
    () => client.inventoryRulesVersion.findUnique({
      where: { code: CORE_V1_2_INVENTORY_RULES_CODE }, select: inventoryRulesSelect,
    }),
    { modelName: 'InventoryRulesVersion', fields: ['code'], index: 'InventoryRulesVersion_code_key', allowModelOnly: true },
  );
  if (version.rulesetVersionId !== rulesetVersion.id || version.code !== CORE_V1_2_INVENTORY_RULES_CODE
    || version.schemaVersion !== CORE_V1_INVENTORY_SCHEMA_VERSION
    || version.configHash !== CORE_V1_2_INVENTORY_HASH
    || canonicalJson(version.configSnapshot) !== CORE_V1_2_INVENTORY_CANONICAL_JSON) {
    throw new CoreInventoryRulesVersionDriftError(['rulesetVersion']);
  }
  return version;
}

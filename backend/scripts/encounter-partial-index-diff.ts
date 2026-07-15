export interface EncounterPartialIndexMetadata {
  readonly indexName: string;
  readonly tableName: string;
  readonly isUnique: boolean;
  readonly isValid: boolean;
  readonly accessMethod: string;
  readonly columnNames: readonly string[];
  readonly direction: string;
  readonly predicate: string;
  readonly indexDefinition: string;
}

const indexName = 'Encounter_one_open_per_campaign_key';
const predicate = '("lifecycleStatus" = ANY (ARRAY['
  + "'AWAITING_INTENT'::\"EncounterLifecycleStatus\", "
  + "'AWAITING_REACTION'::\"EncounterLifecycleStatus\", "
  + "'PROCESSING_PAUSED'::\"EncounterLifecycleStatus\", "
  + "'COMPLETION_PENDING'::\"EncounterLifecycleStatus\"]))";

export const EXPECTED_ENCOUNTER_PARTIAL_INDEX_METADATA: EncounterPartialIndexMetadata = {
  indexName,
  tableName: 'Encounter',
  isUnique: true,
  isValid: true,
  accessMethod: 'btree',
  columnNames: ['campaignId'],
  direction: 'ASC',
  predicate,
  indexDefinition: `CREATE UNIQUE INDEX "${indexName}" ON public."Encounter" USING btree ("campaignId") WHERE ${predicate}`,
};

function normalizedLines(value: string): readonly string[] {
  return value.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0);
}

function normalizedSql(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

export function assertOnlyExpectedEncounterPartialIndexDiff(
  diffSql: string,
  metadata: EncounterPartialIndexMetadata,
): void {
  const lines = normalizedLines(diffSql);
  const expectedDropStatements = new Set([
    `DROP INDEX "${indexName}";`,
    `DROP INDEX "public"."${indexName}";`,
  ]);
  if (lines.length !== 2 || lines[0] !== '-- DropIndex' || !expectedDropStatements.has(lines[1] ?? '')) {
    throw new Error('Integration schema has an unexpected Prisma diff');
  }

  const expected = EXPECTED_ENCOUNTER_PARTIAL_INDEX_METADATA;
  const metadataMatches = metadata.indexName === expected.indexName
    && metadata.tableName === expected.tableName
    && metadata.isUnique === expected.isUnique
    && metadata.isValid === expected.isValid
    && metadata.accessMethod === expected.accessMethod
    && metadata.columnNames.length === expected.columnNames.length
    && metadata.columnNames.every((column, index) => column === expected.columnNames[index])
    && metadata.direction === expected.direction
    && normalizedSql(metadata.predicate) === normalizedSql(expected.predicate)
    && normalizedSql(metadata.indexDefinition) === normalizedSql(expected.indexDefinition);
  if (!metadataMatches) throw new Error('Encounter partial index does not match the reviewed migration');
}

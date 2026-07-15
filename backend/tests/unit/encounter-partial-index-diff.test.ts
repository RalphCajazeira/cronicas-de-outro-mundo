import { describe, expect, it } from 'vitest';
import {
  assertOnlyExpectedEncounterPartialIndexDiff,
  EXPECTED_ENCOUNTER_PARTIAL_INDEX_METADATA,
} from '../../scripts/encounter-partial-index-diff.js';

const expectedDiff = `-- DropIndex
DROP INDEX "Encounter_one_open_per_campaign_key";
`;

describe('encounter partial-index Prisma diff', () => {
  it('accepts only the known SQL-only partial index diff', () => {
    expect(() => assertOnlyExpectedEncounterPartialIndexDiff(
      expectedDiff,
      EXPECTED_ENCOUNTER_PARTIAL_INDEX_METADATA,
    )).not.toThrow();
  });

  it('rejects a second drift statement', () => {
    const additionalDrift = `${expectedDiff}
-- DropIndex
DROP INDEX "Unexpected_index";
`;
    expect(() => assertOnlyExpectedEncounterPartialIndexDiff(
      additionalDrift,
      EXPECTED_ENCOUNTER_PARTIAL_INDEX_METADATA,
    )).toThrow(/unexpected Prisma diff/);
  });

  it('rejects a changed lifecycle predicate', () => {
    const changedPredicate = EXPECTED_ENCOUNTER_PARTIAL_INDEX_METADATA.predicate
      .replace("'COMPLETION_PENDING'", "'COMPLETED'");
    expect(() => assertOnlyExpectedEncounterPartialIndexDiff(expectedDiff, {
      ...EXPECTED_ENCOUNTER_PARTIAL_INDEX_METADATA,
      predicate: changedPredicate,
      indexDefinition: EXPECTED_ENCOUNTER_PARTIAL_INDEX_METADATA.indexDefinition
        .replace("'COMPLETION_PENDING'", "'COMPLETED'"),
    })).toThrow(/does not match the reviewed migration/);
  });
});

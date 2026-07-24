import { describe, expect, it } from 'vitest';
import { cleanSlateObjects } from '../../scripts/clean-slate.js';

describe('clean-slate allowlist', () => {
  it('covers the public objects created by the twelve committed migrations', () => {
    expect(cleanSlateObjects.tables).toHaveLength(28);
    expect(cleanSlateObjects.enums).toHaveLength(25);
    expect(cleanSlateObjects.functions).toContainEqual(['ruleset_version_block_update', '']);
    expect(cleanSlateObjects.functions).toContainEqual(['encounter_consequence_validate', 'uuid']);
  });

  it('does not rely on prefix discovery or destructive schema/database drops', () => {
    const source = JSON.stringify(cleanSlateObjects);
    expect(source).not.toMatch(/DROP SCHEMA|DROP DATABASE|CASCADE public/i);
  });
});

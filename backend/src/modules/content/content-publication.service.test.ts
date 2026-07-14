import { describe, expect, it } from 'vitest';
import { CORE_V1_CONTENT_PROFILE_HASH } from '../rules/core-v1/core-v1.content-profile.manifest.js';
import { activeSkillProfile, publishedContentFixture } from '../../../tests/support/content-fixture.js';
import { calculateContentHash, calculateEffectBindingHash, calculateInventorySpecHash, publicContentDto } from './content-publication.service.js';

function hashInput() {
  const profile = activeSkillProfile();
  return {
    schemaVersion: 1,
    contentType: 'skill',
    code: profile.code,
    name: profile.name,
    description: profile.description ?? null,
    profile,
    presentation: {},
    tags: ['wind'],
    metadata: {},
    ruleset: { code: 'core-v1', revision: 'RC1.1' },
    contentProfileVersion: { code: 'core-v1-content-v1', schemaVersion: 1, configHash: CORE_V1_CONTENT_PROFILE_HASH },
  };
}

describe('versioned content publication primitives', () => {
  it('has a fixed official content hash without IDs, timestamps or lifecycle status', () => {
    expect(calculateContentHash(hashInput())).toBe('bf1cade3d08e638f1bb157c38bdf03848cddd5d44e926d276238419260dd4b1b');
    expect(JSON.stringify(hashInput())).not.toMatch(/contentDefinitionId|contentVersionId|status|createdAt/);
    const lifecycleOnly = { ...hashInput(), status: 'archived' };
    expect(calculateContentHash(hashInput())).toBe(calculateContentHash(lifecycleOnly));
  });

  it('hashes the canonical inventory spec separately from public content', () => {
    const spec = {
      schemaVersion: 1 as const, rulesetCode: 'core-v1' as const, inventoryRulesCode: 'core-v1-inventory-v1' as const,
      unitWeight: 10, stacking: { mode: 'unique' as const }, equipmentSlots: ['main_hand' as const], handedness: 'one_handed' as const,
    };
    expect(calculateInventorySpecHash(spec)).toBe('49c5bb0da0c7f5522ad354e1d4564a83fc77c0225eadb273e1f193d023f39b4e');
    expect(calculateInventorySpecHash({ ...spec, unitWeight: 11 })).not.toBe(calculateInventorySpecHash(spec));
  });

  it('hashes exact status bindings independently and canonically', () => {
    expect(calculateEffectBindingHash([])).toBe('4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945');
    const apply = [{
      effectIndex: 1, bindingKind: 'apply_status' as const,
      target: { scope: 'campaign' as const, contentType: 'status_effect' as const, code: 'burning', versionNumber: 1 },
    }];
    expect(calculateEffectBindingHash(apply)).toMatch(/^[0-9a-f]{64}$/);
    expect(calculateEffectBindingHash(apply)).not.toBe(calculateEffectBindingHash([{ ...apply[0]!, target: { ...apply[0]!.target, versionNumber: 2 } }]));
    expect(calculateEffectBindingHash([{ ...apply[0]!, bindingKind: 'remove_status' }])).not.toBe(calculateEffectBindingHash(apply));
  });

  it.each(['name', 'description', 'profile', 'presentation', 'tags', 'metadata'] as const)(
    'changes the hash when versioned field %s changes',
    (field) => {
      const original = hashInput();
      const changed = structuredClone(original);
      if (field === 'name') changed.name = 'Outro Nome';
      else if (field === 'description') changed.description = 'Outra descrição';
      else if (field === 'profile') changed.profile = { ...changed.profile, lore: 'Novo lore' };
      else if (field === 'presentation') changed.presentation = { summary: 'Outro resumo' };
      else if (field === 'tags') changed.tags = ['other'];
      else changed.metadata = { category: 'other' };
      expect(calculateContentHash(changed)).not.toBe(calculateContentHash(original));
    },
  );

  it('returns a public DTO without internal IDs, hashes or snapshots', () => {
    const dto = publicContentDto(publishedContentFixture());
    expect(dto).toMatchObject({
      code: 'wind_breeze_step', contentType: 'skill', versionNumber: 1,
      ruleset: { code: 'core-v1', revision: 'RC1.1' },
      contentProfile: { code: 'core-v1-content-v1', schemaVersion: 1 },
    });
    expect(JSON.stringify(dto)).not.toMatch(/contentHash|configHash|Snapshot|[0-9a-f]{8}-[0-9a-f-]{27}/i);
  });
});

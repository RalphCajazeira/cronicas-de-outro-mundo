import { ActorStatus, ActorType } from '../../generated/prisma/client.js';
import { describe, expect, it } from 'vitest';
import { createActorsService } from './actors.service.js';
import type { ActorRecord, ActorRepository } from './actors.types.js';
import { actorMechanicalSheetFixture } from '../../../tests/support/actor-mechanics-fixture.js';
import { actorContentFixture } from '../../../tests/support/content-fixture.js';

const actor: ActorRecord = {
  id: '7e7b7cbe-5767-47de-a0b5-4b7bc9365c89', code: 'ralph', name: 'Ralph', actorType: ActorType.CHARACTER,
  species: null, className: 'Aventureiro', role: null, description: null, level: 1, xp: 0, gold: 0,
  status: ActorStatus.ACTIVE, appearance: { eyes: 'green' }, personality: { traits: ['calm'] }, metadata: {},
  mechanicalSheet: actorMechanicalSheetFixture(),
  inventorySummary: { entryCount: 0, equippedCount: 0, totalCarriedWeight: 0, encumbranceState: 'normal' },
  activeEffectSummary: { total: 0, statusCount: 0, modifierCount: 0, reactionGrantCount: 0 },
};
const scope = { playerRef: 'ralph', worldRef: 'elarion', campaignRef: 'main-campaign' };

function repository(found: ActorRecord | null = actor): ActorRepository {
  return { findByReference: () => Promise.resolve(found), listContent: () => Promise.resolve([]) };
}

describe('actors service', () => {
  it('returns a found actor as a normalized DTO', async () => {
    await expect(createActorsService(repository()).get(scope, 'ralph')).resolves.toEqual(expect.objectContaining({
      code: 'ralph', actorType: 'character', appearance: { eyes: 'green' }, personality: { traits: ['calm'] }, status: 'active',
      mechanicsStateVersion: 1, ruleset: { code: 'core-v1', revision: 'RC1.1' },
    }));
  });

  it('rejects a missing actor', async () => {
    await expect(createActorsService(repository(null)).get(scope, 'missing')).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });

  it('lists and normalizes content without its repository relation wrapper', async () => {
    const item = actorContentFixture();
    const contentRepository: ActorRepository = { findByReference: () => Promise.resolve(actor), listContent: () => Promise.resolve([item]) };
    const content = await createActorsService(contentRepository).listContent(scope, 'ralph');
    expect(content[0]).toMatchObject({ contentType: 'skill', state: 'learning', status: 'active' });
    expect(content[0]).not.toHaveProperty('contentDefinition');
  });
});

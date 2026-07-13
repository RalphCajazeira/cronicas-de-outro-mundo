import { ActorStatus, ActorType } from '../../generated/prisma/client.js';
import { describe, expect, it } from 'vitest';
import type { ActorRecord, ActorRepository } from '../actors/actors.types.js';
import { createCharactersService } from './characters.service.js';
import { actorMechanicalSheetFixture } from '../../../tests/support/actor-mechanics-fixture.js';
const scope = { playerRef: 'ralph', worldRef: 'elarion', campaignRef: 'main-campaign' };

function actor(actorType: ActorType): ActorRecord {
  return { id: '7e7b7cbe-5767-47de-a0b5-4b7bc9365c89', code: 'ralph', name: 'Ralph', actorType, species: null,
    className: null, role: null, description: null, level: 1, xp: 0, gold: 0,
    appearance: {}, personality: {}, metadata: {}, status: ActorStatus.ACTIVE,
    mechanicalSheet: actorMechanicalSheetFixture() };
}

function repository(actorType: ActorType): ActorRepository {
  return { findByReference: () => Promise.resolve(actor(actorType)), listContent: () => Promise.resolve([]) };
}

describe('characters service', () => {
  it('returns actors whose type is CHARACTER', async () => {
    await expect(createCharactersService(repository(ActorType.CHARACTER)).get(scope, 'ralph')).resolves.toMatchObject({ actorType: 'character' });
  });

  it('hides an actor whose type is not CHARACTER', async () => {
    await expect(createCharactersService(repository(ActorType.SPIRIT)).get(scope, 'lyra')).rejects.toMatchObject({ statusCode: 404, message: 'Character not found' });
  });

  it('checks the actor type before listing character content', async () => {
    await expect(createCharactersService(repository(ActorType.SPIRIT)).listContent(scope, 'lyra')).rejects.toMatchObject({ statusCode: 404 });
  });
});

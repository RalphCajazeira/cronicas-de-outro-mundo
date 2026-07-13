import {
  ActorContentState,
  ContentProfileMode,
  ContentStatus,
  ContentType,
  type Prisma,
} from '../../src/generated/prisma/client.js';
import type { ActorContentRecord } from '../../src/modules/actors/actors.types.js';
import type { PublishedContent } from '../../src/modules/content/content-publication.service.js';
import type { CoreV1ContentProfile } from '../../src/modules/rules/core-v1/index.js';

const definitionId = 'b41c2a1c-e2d2-4498-a7be-1f07cd85de1a';
const versionId = 'c51c2a1c-e2d2-4498-a7be-1f07cd85de1b';

export function activeSkillProfile(
  code = 'wind_breeze_step',
  name = 'Passo da Brisa',
  description = 'Movimento pelo vento.',
): CoreV1ContentProfile {
  return {
    schemaVersion: 1,
    rulesetCode: 'core-v1',
    profileMode: 'mechanical',
    contentKind: 'skill',
    code,
    name,
    description,
    presentation: {},
    tags: ['wind'],
    tier: 1,
    rarity: 'common',
    activation: { type: 'active' },
    cost: { type: 'sp', amount: 3 },
    actionProfile: 'normal',
    effects: [{ type: 'movement', from: 'near', to: 'engaged', maximumTransitions: 1 }],
  };
}

export function publishedContentFixture(overrides: Partial<PublishedContent> = {}): PublishedContent {
  const profile = activeSkillProfile();
  return {
    id: definitionId,
    worldId: 'e2dc20e8-51dc-47d2-a5be-b841d08fa610',
    campaignId: null,
    code: profile.code,
    contentType: ContentType.SKILL,
    status: ContentStatus.ACTIVE,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    versions: [{
      id: versionId,
      contentDefinitionId: definitionId,
      rulesetVersionId: 'd51c2a1c-e2d2-4498-a7be-1f07cd85de1c',
      contentProfileVersionId: 'e51c2a1c-e2d2-4498-a7be-1f07cd85de1d',
      inventoryRulesVersionId: null,
      versionNumber: 1,
      schemaVersion: 1,
      profileMode: ContentProfileMode.MECHANICAL,
      name: profile.name,
      description: profile.description ?? null,
      profile: profile as unknown as Prisma.JsonValue,
      presentation: {},
      tags: ['wind'],
      metadata: {},
      contentHash: 'a'.repeat(64),
      inventorySpec: null,
      inventorySpecHash: null,
      createdAt: new Date(0),
      rulesetVersion: { code: 'core-v1', revision: 'RC1.1' },
      contentProfileVersion: { code: 'core-v1-content-v1', schemaVersion: 1 },
    }],
    ...overrides,
  };
}

export function actorContentFixture(): ActorContentRecord {
  const content = publishedContentFixture();
  const version = content.versions[0];
  if (version === undefined) throw new Error('Fixture version is required');
  return {
    state: ActorContentState.LEARNING,
    rank: 1,
    progress: 10,
    mastery: 0,
    notes: 'Treino inicial com Lyra',
    metadata: {},
    contentDefinition: content,
    contentVersion: version,
  };
}

export function skillPublicationInput(code = 'quiet-step', name = 'Passo Silencioso') {
  const description = 'Movimento discreto.';
  const profile = activeSkillProfile(code, name, description);
  return {
    contentType: 'skill' as const,
    code,
    name,
    description,
    profile,
    presentation: {},
    tags: ['wind'],
    status: 'active' as const,
  };
}

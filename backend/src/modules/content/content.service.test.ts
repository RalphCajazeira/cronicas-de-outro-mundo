import { ContentStatus, ContentType, type ContentDefinition } from '../../generated/prisma/client.js';
import { describe, expect, it } from 'vitest';
import { createContentService } from './content.service.js';
import type { ContentRepository } from './content.types.js';

const item: ContentDefinition = {
  id: 'd4ddc885-2af0-4db5-bf06-124b9cd0c2c4', worldId: '67c4eb54-af18-4915-bbbc-e4914de30f96', campaignId: null,
  code: 'wind_breeze_step', name: 'Passo da Brisa', contentType: ContentType.SKILL, description: null,
  mechanics: { effect: 'mobility' }, requirements: {}, presentation: {}, tags: ['wind'], schemaVersion: 1,
  status: ContentStatus.ACTIVE, metadata: {}, createdAt: new Date(), updatedAt: new Date(),
};

describe('content service', () => {
  it('returns a found definition as a normalized DTO', async () => {
    const repository: ContentRepository = { findByReference: () => Promise.resolve(item) };
    const result = await createContentService(repository).get('wind_breeze_step');
    expect(result).toMatchObject({ code: 'wind_breeze_step', contentType: 'skill', status: 'active' });
    expect(result).not.toHaveProperty('id');
    expect(result).not.toHaveProperty('worldId');
  });

  it('rejects a missing definition', async () => {
    const repository: ContentRepository = { findByReference: () => Promise.resolve(null) };
    await expect(createContentService(repository).get('missing')).rejects.toMatchObject({ statusCode: 404, message: 'Content not found' });
  });
});

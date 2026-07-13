import { describe, expect, it } from 'vitest';
import { createContentService } from './content.service.js';
import type { ContentRepository } from './content.types.js';
import { publishedContentFixture } from '../../../tests/support/content-fixture.js';

const item = publishedContentFixture();
const input = { playerRef: 'ralph', worldRef: 'elarion', campaignRef: 'main-campaign', contentType: 'skill' as const };

describe('content service', () => {
  it('returns a found definition as a normalized DTO', async () => {
    const repository: ContentRepository = { findByReference: () => Promise.resolve(item) };
    const result = await createContentService(repository).get(input, 'wind_breeze_step');
    expect(result).toMatchObject({ code: 'wind_breeze_step', contentType: 'skill', status: 'active', versionNumber: 1 });
    expect(result).not.toHaveProperty('id');
    expect(result).not.toHaveProperty('worldId');
  });

  it('rejects a missing definition', async () => {
    const repository: ContentRepository = { findByReference: () => Promise.resolve(null) };
    await expect(createContentService(repository).get(input, 'missing')).rejects.toMatchObject({ statusCode: 404, message: 'Content not found' });
  });
});

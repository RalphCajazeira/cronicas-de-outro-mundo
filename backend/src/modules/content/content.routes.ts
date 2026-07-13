import { Router } from 'express';
import type { ContentRepository } from './content.types.js';
import { contentRefSchema, getContentSchema } from './content.schemas.js';
import { createContentService } from './content.service.js';

export function createContentRouter(repository: ContentRepository) {
  const service = createContentService(repository);
  return Router().get('/:contentRef', async (request, response, next) => {
    try {
      response.json(await service.get(getContentSchema.parse(request.query), contentRefSchema.parse(request.params.contentRef)));
    } catch (error) { next(error); }
  });
}

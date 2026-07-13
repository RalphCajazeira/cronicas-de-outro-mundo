import { NotFoundError } from '../../shared/errors/app-error.js';
import { publicContentDto } from './content-publication.service.js';
import type { ContentRepository } from './content.types.js';
import type { GetContentInput } from './content.schemas.js';

export function createContentService(repository: ContentRepository) {
  return { async get(input: GetContentInput, reference: string) {
    const item = await repository.findByReference(input, reference);
    if (item === null) throw new NotFoundError('Content');
    return publicContentDto(item);
  } };
}

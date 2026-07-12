import { NotFoundError } from '../../shared/errors/app-error.js';
import { normalizeEnum } from '../../shared/http/normalize-enum.js';
import type { ContentRepository } from './content.types.js';
import type { GetContentInput } from './content.schemas.js';

export function createContentService(repository: ContentRepository) {
  return { async get(input: GetContentInput, reference: string) {
    const item = await repository.findByReference(input, reference);
    if (item === null) throw new NotFoundError('Content');
    return { code: item.code, name: item.name, contentType: normalizeEnum(item.contentType), description: item.description,
      mechanics: item.mechanics, requirements: item.requirements, presentation: item.presentation, tags: item.tags,
      schemaVersion: item.schemaVersion, status: normalizeEnum(item.status), metadata: item.metadata };
  } };
}

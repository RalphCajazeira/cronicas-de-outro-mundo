import type { GetContentInput } from './content.schemas.js';
import type { PublishedContent } from './content-publication.service.js';

export interface ContentRepository { findByReference(input: GetContentInput, reference: string): Promise<PublishedContent | null>; }

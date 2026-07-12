import type { ContentDefinition } from '../../generated/prisma/client.js';
import type { GetContentInput } from './content.schemas.js';

export interface ContentRepository { findByReference(input: GetContentInput, reference: string): Promise<ContentDefinition | null>; }

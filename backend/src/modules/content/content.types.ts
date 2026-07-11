import type { ContentDefinition } from '../../generated/prisma/client.js';

export interface ContentRepository { findByReference(reference: string): Promise<ContentDefinition | null>; }

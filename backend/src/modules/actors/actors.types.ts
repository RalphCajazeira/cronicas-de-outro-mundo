import type { ActorStatus, ActorType, Prisma } from '../../generated/prisma/client.js';
import type { CampaignReference } from '../../shared/database/game-scope.js';
import type { ActorMechanicalSheet } from './actor-mechanics.service.js';

export interface ActorRecord {
  id: string; code: string; name: string; actorType: ActorType; species: string | null;
  className: string | null; role: string | null; description: string | null; level: number;
  xp: number; gold: number; appearance: Prisma.JsonValue; personality: Prisma.JsonValue;
  metadata: Prisma.JsonValue; status: ActorStatus; mechanicalSheet: ActorMechanicalSheet;
}

export interface ActorRepository {
  findByReference(scope: CampaignReference, reference: string): Promise<ActorRecord | null>;
  listContent(scope: CampaignReference, reference: string): Promise<ActorContentRecord[] | null>;
}

export interface ActorContentRecord {
  state: string; rank: number; progress: number; mastery: number; equipped: boolean;
  quantity: number; notes: string | null;
  contentDefinition: {
    code: string; name: string; contentType: string; description: string | null;
    mechanics: Prisma.JsonValue; requirements: Prisma.JsonValue; presentation: Prisma.JsonValue;
    tags: Prisma.JsonValue; schemaVersion: number; status: string;
  };
}

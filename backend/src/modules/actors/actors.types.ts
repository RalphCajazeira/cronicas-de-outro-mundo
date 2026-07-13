import type { ActorStatus, ActorType, Prisma } from '../../generated/prisma/client.js';
import type { CampaignReference } from '../../shared/database/game-scope.js';

export interface ActorRecord {
  id: string; code: string; name: string; actorType: ActorType; species: string | null;
  className: string | null; level: number; xp: number; gold: number; health: number;
  maxHealth: number; mana: number; maxMana: number; attributes: Prisma.JsonValue;
  resistances: Prisma.JsonValue; affinities: Prisma.JsonValue; status: ActorStatus;
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

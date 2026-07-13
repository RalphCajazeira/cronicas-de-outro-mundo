import type { ActorStatus, ActorType, ContentProfileMode, ContentStatus, ContentType, Prisma } from '../../generated/prisma/client.js';
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
  state: string; rank: number; progress: number; mastery: number;
  notes: string | null; metadata: Prisma.JsonValue;
  contentDefinition: {
    code: string; contentType: ContentType; status: ContentStatus;
  };
  contentVersion: {
    id: string; contentDefinitionId: string; rulesetVersionId: string; contentProfileVersionId: string;
    versionNumber: number; schemaVersion: number; profileMode: ContentProfileMode; name: string;
    description: string | null; profile: Prisma.JsonValue | null; presentation: Prisma.JsonValue;
    tags: Prisma.JsonValue; metadata: Prisma.JsonValue; contentHash: string; createdAt: Date;
    inventoryRulesVersionId: string | null; inventorySpec: Prisma.JsonValue | null; inventorySpecHash: string | null;
    rulesetVersion: { code: string; revision: string };
    contentProfileVersion: { code: string; schemaVersion: number };
  };
}

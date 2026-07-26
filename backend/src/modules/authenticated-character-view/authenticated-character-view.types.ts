import type { ActorMechanicalSheet } from '../actors/actor-mechanics.service.js';

export interface AuthenticatedCharacterSnapshot {
  readonly actor: {
    readonly id: string;
    readonly name: string;
    readonly species: string | null;
    readonly className: string | null;
    readonly role: string | null;
    readonly description: string | null;
    readonly level: number;
    readonly xp: number;
    readonly gold: number;
    readonly status: string;
    readonly campaignName: string;
    readonly worldName: string;
    readonly engineTick: bigint;
  };
  readonly storedAttributes: readonly {
    readonly code: string;
    readonly baseValue: number;
    readonly earnedValue: number;
    readonly xp: number;
  }[];
  readonly mechanicalSheet: ActorMechanicalSheet;
  readonly inventory: readonly {
    readonly name: string;
    readonly customName: string | null;
    readonly description: string | null;
    readonly contentType: string;
    readonly quantity: number;
    readonly entryKind: string;
    readonly lifecycle: string | null;
    readonly profile: unknown;
    readonly inventorySpec: unknown;
    readonly equippedSlots: readonly string[];
  }[];
  readonly abilities: readonly {
    readonly contentVersionId: string;
    readonly name: string;
    readonly description: string | null;
    readonly contentType: string;
    readonly state: string;
    readonly rank: number;
    readonly progress: number;
    readonly mastery: number;
    readonly versionNumber: number;
    readonly profile: unknown;
  }[];
  readonly statusEffects: readonly {
    readonly name: string;
    readonly description: string | null;
    readonly stacks: number;
    readonly durationType: string;
    readonly expiresAtTick: bigint | null;
    readonly remainingActions: number | null;
  }[];
}

export interface AuthenticatedCharacterViewRepository {
  loadAuthorizedCharacterSnapshot(
    userId: string,
    campaignId: string,
    actorId: string,
  ): Promise<AuthenticatedCharacterSnapshot | null>;
}

import type {
  ActorControlPermission,
  ActorResourceType,
  ActorStatus,
  ActorType,
  CampaignMembershipRole,
  CampaignMembershipStatus,
  CampaignStatus,
  GameSessionStatus,
  UserStatus,
} from '../../generated/prisma/client.js';

export interface AuthenticatedResourceRecord {
  readonly type: ActorResourceType;
  readonly current: number;
}

export interface AuthenticatedCharacterRecord {
  readonly id: string;
  readonly campaignId: string;
  readonly name: string;
  readonly level: number;
  readonly actorType: ActorType;
  readonly status: ActorStatus;
  readonly resources: readonly AuthenticatedResourceRecord[];
  readonly derivedSnapshot: {
    readonly maxHp: number;
    readonly maxMana: number;
    readonly maxSp: number;
  } | null;
}

export interface AuthenticatedActorControlRecord {
  readonly actorId: string;
  readonly userId: string;
  readonly permission: ActorControlPermission;
  readonly revokedAt: Date | null;
  readonly actor: AuthenticatedCharacterRecord;
}

export interface AuthenticatedCampaignMembershipRecord {
  readonly campaignId: string;
  readonly userId: string;
  readonly role: CampaignMembershipRole;
  readonly status: CampaignMembershipStatus;
  readonly revokedAt: Date | null;
  readonly campaign: {
    readonly id: string;
    readonly name: string;
    readonly status: CampaignStatus;
    readonly world: {
      readonly name: string;
    };
  };
}

export interface AuthenticatedGameAccessRecord {
  readonly id: string;
  readonly status: UserStatus;
  readonly suspendedAt: Date | null;
  readonly deletedAt: Date | null;
  readonly player: {
    readonly id: string;
    readonly displayName: string;
  } | null;
  readonly campaignMemberships: readonly AuthenticatedCampaignMembershipRecord[];
  readonly actorControls: readonly AuthenticatedActorControlRecord[];
  readonly gameSessions?: readonly {
    readonly id: string;
    readonly userId: string;
    readonly campaignId: string;
    readonly actorId: string;
    readonly status: GameSessionStatus;
    readonly stateVersion: number;
    readonly lastActiveAt: Date;
    readonly closedAt: Date | null;
  }[];
}

export interface AuthenticatedGameContextRepository {
  findGameAccessByUserId(userId: string): Promise<AuthenticatedGameAccessRecord | null>;
  findLatestObservation?(gameSessionId: string, campaignId: string, actorId: string): Promise<{
    readonly payload: unknown;
    readonly createdAt: Date;
  } | null>;
}

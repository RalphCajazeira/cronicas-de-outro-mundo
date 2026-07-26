import type {
  ActorControlPermission,
  CampaignMembershipRole,
  CampaignMembershipStatus,
  UserStatus,
} from '../../generated/prisma/client.js';

export interface CampaignMembershipRecord {
  readonly id: string;
  readonly campaignId: string;
  readonly userId: string;
  readonly role: CampaignMembershipRole;
  readonly status: CampaignMembershipStatus;
  readonly revokedAt: Date | null;
  readonly userStatus: UserStatus;
  readonly userSuspendedAt: Date | null;
  readonly userDeletedAt: Date | null;
}

export interface ActorControlRecord {
  readonly id: string;
  readonly actorId: string;
  readonly actorCampaignId: string;
  readonly userId: string;
  readonly permission: ActorControlPermission;
  readonly revokedAt: Date | null;
}

export interface ActorAccessRecord extends ActorControlRecord {
  readonly membership: CampaignMembershipRecord | null;
}

export interface AuthorizationRepository {
  findCampaignMembership(userId: string, campaignId: string): Promise<CampaignMembershipRecord | null>;
  findActorAccess(userId: string, campaignId: string, actorId: string): Promise<ActorAccessRecord | null>;
}

export interface RequireCampaignAccessInput {
  readonly userId: string;
  readonly campaignId: string;
  readonly allowedRoles?: readonly CampaignMembershipRole[];
}

export interface RequireActorAccessInput {
  readonly userId: string;
  readonly campaignId: string;
  readonly actorId: string;
  readonly requiredPermission: ActorControlPermission;
}

export interface AuthorizedCampaignAccess {
  readonly membershipId: string;
  readonly campaignId: string;
  readonly userId: string;
  readonly role: CampaignMembershipRole;
}

export interface AuthorizedActorAccess extends AuthorizedCampaignAccess {
  readonly actorControlId: string;
  readonly actorId: string;
  readonly permission: ActorControlPermission;
}

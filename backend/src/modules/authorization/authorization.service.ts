import {
  ActorControlPermission,
  CampaignMembershipRole,
  CampaignMembershipStatus,
  UserStatus,
} from '../../generated/prisma/client.js';
import { AuthorizationDeniedError, AuthorizationIntegrityError } from './authorization.errors.js';
import type {
  AuthorizationRepository,
  CampaignMembershipRecord,
  AuthorizedActorAccess,
  AuthorizedCampaignAccess,
  RequireActorAccessInput,
  RequireCampaignAccessInput,
} from './authorization.types.js';

function permits(
  actual: ActorControlPermission,
  required: ActorControlPermission,
): boolean {
  return actual === ActorControlPermission.CONTROL || required === ActorControlPermission.VIEW;
}

function authorizeMembership(
  membership: CampaignMembershipRecord | null,
  input: RequireCampaignAccessInput,
): AuthorizedCampaignAccess {
  if (membership === null) throw new AuthorizationDeniedError('campaign_membership_missing');
  if (membership.userId !== input.userId || membership.campaignId !== input.campaignId) {
    throw new AuthorizationIntegrityError('campaign_membership_scope_mismatch');
  }
  if (membership.userStatus === UserStatus.SUSPENDED || membership.userStatus === UserStatus.DELETED) {
    throw new AuthorizationDeniedError('user_not_active');
  }
  if (membership.userStatus !== UserStatus.ACTIVE
    || membership.userSuspendedAt !== null
    || membership.userDeletedAt !== null) {
    throw new AuthorizationIntegrityError('authorization_user_state_inconsistent');
  }
  if (membership.status !== CampaignMembershipStatus.ACTIVE || membership.revokedAt !== null) {
    throw new AuthorizationDeniedError('campaign_membership_inactive');
  }
  if (input.allowedRoles !== undefined && !input.allowedRoles.includes(membership.role)) {
    throw new AuthorizationDeniedError('campaign_role_not_allowed');
  }
  return {
    membershipId: membership.id,
    campaignId: membership.campaignId,
    userId: membership.userId,
    role: membership.role,
  };
}

export function createAuthorizationService(repository: AuthorizationRepository) {
  async function requireCampaignAccess(input: RequireCampaignAccessInput): Promise<AuthorizedCampaignAccess> {
    const membership = await repository.findCampaignMembership(input.userId, input.campaignId);
    return authorizeMembership(membership, input);
  }

  return {
    requireCampaignAccess,

    async requireActorAccess(input: RequireActorAccessInput): Promise<AuthorizedActorAccess> {
      const control = await repository.findActorAccess(input.userId, input.campaignId, input.actorId);
      if (control === null) throw new AuthorizationDeniedError('actor_access_denied');
      if (control.userId !== input.userId || control.actorId !== input.actorId) {
        throw new AuthorizationIntegrityError('actor_control_identity_mismatch');
      }
      if (control.actorCampaignId !== input.campaignId) {
        throw new AuthorizationIntegrityError('actor_control_campaign_mismatch');
      }
      if (control.revokedAt !== null || !permits(control.permission, input.requiredPermission)) {
        throw new AuthorizationDeniedError('actor_permission_not_allowed');
      }

      const campaignAccess = authorizeMembership(control.membership, {
        userId: input.userId,
        campaignId: input.campaignId,
      });
      if (input.requiredPermission === ActorControlPermission.CONTROL
        && campaignAccess.role === CampaignMembershipRole.OBSERVER) {
        throw new AuthorizationDeniedError('observer_cannot_control_actor');
      }

      return {
        ...campaignAccess,
        actorControlId: control.id,
        actorId: control.actorId,
        permission: control.permission,
      };
    },
  };
}

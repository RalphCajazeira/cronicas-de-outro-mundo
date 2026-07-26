import {
  ActorControlPermission,
  CampaignMembershipRole,
  CampaignMembershipStatus,
  UserStatus,
} from '../../generated/prisma/client.js';
import { describe, expect, it } from 'vitest';
import { createAuthorizationService } from './authorization.service.js';
import type {
  ActorAccessRecord,
  AuthorizationRepository,
  CampaignMembershipRecord,
} from './authorization.types.js';

const userId = '10000000-0000-0000-0000-000000000001';
const campaignId = '20000000-0000-0000-0000-000000000001';
const actorId = '30000000-0000-0000-0000-000000000001';

function membership(
  role: CampaignMembershipRole = CampaignMembershipRole.PLAYER,
  status: CampaignMembershipStatus = CampaignMembershipStatus.ACTIVE,
): CampaignMembershipRecord {
  return {
    id: '40000000-0000-0000-0000-000000000001',
    campaignId,
    userId,
    role,
    status,
    revokedAt: status === CampaignMembershipStatus.REVOKED ? new Date() : null,
    userStatus: UserStatus.ACTIVE,
    userSuspendedAt: null,
    userDeletedAt: null,
  };
}

function control(
  permission: ActorControlPermission = ActorControlPermission.CONTROL,
  actorCampaignId = campaignId,
  campaignMembership: CampaignMembershipRecord | null = membership(),
): ActorAccessRecord {
  return {
    id: '50000000-0000-0000-0000-000000000001',
    actorId,
    actorCampaignId,
    userId,
    permission,
    revokedAt: null,
    membership: campaignMembership,
  };
}

function repository(
  campaignMembership: CampaignMembershipRecord | null = membership(),
  actorAccess: ActorAccessRecord | null = control(),
): AuthorizationRepository {
  return {
    findCampaignMembership: () => Promise.resolve(campaignMembership),
    findActorAccess: () => Promise.resolve(actorAccess),
  };
}

describe('authorization service', () => {
  it('authorizes an active campaign member with an allowed role', async () => {
    await expect(createAuthorizationService(repository()).requireCampaignAccess({
      userId,
      campaignId,
      allowedRoles: [CampaignMembershipRole.PLAYER],
    })).resolves.toMatchObject({ userId, campaignId, role: CampaignMembershipRole.PLAYER });
  });

  it('fails closed for missing, revoked, wrong-role, and inconsistent memberships', async () => {
    await expect(createAuthorizationService(repository(null)).requireCampaignAccess({ userId, campaignId }))
      .rejects.toMatchObject({ statusCode: 403, auditCode: 'campaign_membership_missing' });
    await expect(createAuthorizationService(repository(membership(
      CampaignMembershipRole.PLAYER,
      CampaignMembershipStatus.REVOKED,
    ))).requireCampaignAccess({ userId, campaignId }))
      .rejects.toMatchObject({ statusCode: 403, auditCode: 'campaign_membership_inactive' });
    await expect(createAuthorizationService(repository()).requireCampaignAccess({
      userId,
      campaignId,
      allowedRoles: [CampaignMembershipRole.GM],
    })).rejects.toMatchObject({ statusCode: 403, auditCode: 'campaign_role_not_allowed' });
    await expect(createAuthorizationService(repository({ ...membership(), userId: 'other-user' }))
      .requireCampaignAccess({ userId, campaignId }))
      .rejects.toMatchObject({ statusCode: 500, code: 'AUTHORIZATION_INTEGRITY_ERROR' });
  });

  it('rejects suspended, deleted, and inconsistent user lifecycle state', async () => {
    await expect(createAuthorizationService(repository({
      ...membership(),
      userStatus: UserStatus.SUSPENDED,
      userSuspendedAt: new Date(),
    })).requireCampaignAccess({ userId, campaignId }))
      .rejects.toMatchObject({ statusCode: 403, auditCode: 'user_not_active' });
    await expect(createAuthorizationService(repository({
      ...membership(),
      userStatus: UserStatus.DELETED,
      userDeletedAt: new Date(),
    })).requireCampaignAccess({ userId, campaignId }))
      .rejects.toMatchObject({ statusCode: 403, auditCode: 'user_not_active' });
    await expect(createAuthorizationService(repository({
      ...membership(),
      userSuspendedAt: new Date(),
    })).requireCampaignAccess({ userId, campaignId }))
      .rejects.toMatchObject({ statusCode: 500, auditCode: 'authorization_user_state_inconsistent' });
  });

  it('allows CONTROL to satisfy VIEW and requires active campaign membership', async () => {
    await expect(createAuthorizationService(repository()).requireActorAccess({
      userId,
      campaignId,
      actorId,
      requiredPermission: ActorControlPermission.VIEW,
    })).resolves.toMatchObject({
      userId,
      campaignId,
      actorId,
      permission: ActorControlPermission.CONTROL,
    });
  });

  it('rejects missing, revoked, insufficient, and cross-campaign actor access', async () => {
    await expect(createAuthorizationService(repository(membership(), null)).requireActorAccess({
      userId,
      campaignId,
      actorId,
      requiredPermission: ActorControlPermission.VIEW,
    })).rejects.toMatchObject({ code: 'FORBIDDEN', auditCode: 'actor_access_denied' });
    await expect(createAuthorizationService(repository(membership(), {
      ...control(),
      revokedAt: new Date(),
    })).requireActorAccess({
      userId,
      campaignId,
      actorId,
      requiredPermission: ActorControlPermission.VIEW,
    })).rejects.toMatchObject({ auditCode: 'actor_permission_not_allowed' });
    await expect(createAuthorizationService(repository(membership(), control(ActorControlPermission.VIEW)))
      .requireActorAccess({
        userId,
        campaignId,
        actorId,
        requiredPermission: ActorControlPermission.CONTROL,
      })).rejects.toMatchObject({ auditCode: 'actor_permission_not_allowed' });
    await expect(createAuthorizationService(repository(
      membership(),
      control(ActorControlPermission.CONTROL, 'other-campaign'),
    )).requireActorAccess({
      userId,
      campaignId,
      actorId,
      requiredPermission: ActorControlPermission.CONTROL,
    })).rejects.toMatchObject({ code: 'AUTHORIZATION_INTEGRITY_ERROR' });
  });

  it('does not allow an observer to control an actor even with a conflicting grant', async () => {
    const observerMembership = membership(CampaignMembershipRole.OBSERVER);
    await expect(createAuthorizationService(repository(
      observerMembership,
      control(ActorControlPermission.CONTROL, campaignId, observerMembership),
    ))
      .requireActorAccess({
        userId,
        campaignId,
        actorId,
        requiredPermission: ActorControlPermission.CONTROL,
      })).rejects.toMatchObject({ statusCode: 403, auditCode: 'observer_cannot_control_actor' });
  });

  it('requires an active membership from the same scoped actor query', async () => {
    const revokedMembership = membership(
      CampaignMembershipRole.PLAYER,
      CampaignMembershipStatus.REVOKED,
    );
    await expect(createAuthorizationService(repository(
      revokedMembership,
      control(ActorControlPermission.CONTROL, campaignId, revokedMembership),
    )).requireActorAccess({
      userId,
      campaignId,
      actorId,
      requiredPermission: ActorControlPermission.VIEW,
    })).rejects.toMatchObject({ statusCode: 403, auditCode: 'campaign_membership_inactive' });
  });
});

import {
  ActorContentState,
  ActorControlPermission,
  ActorType,
  CampaignMembershipRole,
  CampaignMembershipStatus,
  ContentStatus,
  ContentType,
  Prisma,
} from '../../generated/prisma/client.js';
import { prisma } from '../../shared/database/prisma.js';
import { loadActorMechanicalSheet } from '../actors/actor-mechanics.service.js';
import type {
  AuthenticatedCharacterSnapshot,
  AuthenticatedCharacterViewRepository,
} from './authenticated-character-view.types.js';

const maximumPublicRowsPlusIntegritySentinel = 101;

export function createPrismaAuthenticatedCharacterViewRepository(
  client: typeof prisma,
): AuthenticatedCharacterViewRepository {
  return {
    loadAuthorizedCharacterSnapshot(userId, campaignId, actorId) {
      return client.$transaction(async (transaction): Promise<AuthenticatedCharacterSnapshot | null> => {
        const authorization = await transaction.user.findFirst({
          where: {
            id: userId,
            status: 'ACTIVE',
            suspendedAt: null,
            deletedAt: null,
            player: { isNot: null },
            campaignMemberships: {
              some: {
                campaignId,
                status: CampaignMembershipStatus.ACTIVE,
                revokedAt: null,
                role: {
                  in: [
                    CampaignMembershipRole.OWNER,
                    CampaignMembershipRole.GM,
                    CampaignMembershipRole.PLAYER,
                  ],
                },
              },
            },
            actorControls: {
              some: {
                actorId,
                revokedAt: null,
                permission: {
                  in: [
                    ActorControlPermission.VIEW,
                    ActorControlPermission.CONTROL,
                  ],
                },
                actor: {
                  campaignId,
                  actorType: ActorType.CHARACTER,
                },
              },
            },
          },
          select: { id: true },
        });
        if (authorization === null) return null;

        const actor = await transaction.actor.findFirst({
          where: {
            id: actorId,
            campaignId,
            actorType: ActorType.CHARACTER,
          },
          select: {
            id: true,
            name: true,
            species: true,
            className: true,
            role: true,
            description: true,
            level: true,
            xp: true,
            gold: true,
            status: true,
            campaign: {
              select: {
                name: true,
                engineTick: true,
                world: { select: { id: true, name: true } },
              },
            },
            attributes: {
              select: {
                code: true,
                baseValue: true,
                earnedValue: true,
                xp: true,
              },
              orderBy: { code: 'asc' },
            },
          },
        });
        if (actor === null) return null;
        const publicContentScope = {
          status: ContentStatus.ACTIVE,
          worldId: actor.campaign.world.id,
          OR: [{ campaignId: null }, { campaignId }],
        } satisfies Prisma.ContentDefinitionWhereInput;

        const mechanicalSheet = await loadActorMechanicalSheet(transaction, actorId);
        const inventory = await transaction.inventoryEntry.findMany({
          where: {
            actorId,
            contentVersion: {
              contentDefinition: publicContentScope,
            },
          },
          select: {
            customName: true,
            quantity: true,
            entryKind: true,
            instanceLifecycle: true,
            contentVersion: {
              select: {
                id: true,
                name: true,
                description: true,
                profile: true,
                inventorySpec: true,
                contentDefinition: { select: { contentType: true } },
              },
            },
            equipmentSlots: {
              select: { slotRef: true },
              orderBy: { slotRef: 'asc' },
            },
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: maximumPublicRowsPlusIntegritySentinel,
        });
        const abilities = await transaction.actorContent.findMany({
          where: {
            actorId,
            state: {
              in: [
                ActorContentState.LEARNING,
                ActorContentState.KNOWN,
                ActorContentState.MASTERED,
              ],
            },
            contentDefinition: {
              status: ContentStatus.ACTIVE,
              worldId: actor.campaign.world.id,
              OR: [{ campaignId: null }, { campaignId }],
              contentType: {
                in: [ContentType.SKILL, ContentType.SPELL, ContentType.TALENT],
              },
            },
          },
          select: {
            state: true,
            rank: true,
            progress: true,
            mastery: true,
            contentDefinition: { select: { contentType: true } },
            contentVersion: {
              select: {
                id: true,
                name: true,
                description: true,
                versionNumber: true,
                profile: true,
              },
            },
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: maximumPublicRowsPlusIntegritySentinel,
        });
        const statusEffects = await transaction.activeEffect.findMany({
          where: {
            targetActorId: actorId,
          },
          select: {
            stacks: true,
            durationType: true,
            expiresAtTick: true,
            remainingActions: true,
            effectContentVersion: {
              select: {
                name: true,
                description: true,
                contentDefinition: {
                  select: {
                    status: true,
                    worldId: true,
                    campaignId: true,
                  },
                },
              },
            },
            sourceContentVersion: {
              select: {
                id: true,
                name: true,
                description: true,
                contentDefinition: {
                  select: {
                    status: true,
                    worldId: true,
                    campaignId: true,
                  },
                },
              },
            },
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: 51,
        });

        if (inventory.length > 100 || abilities.length > 100 || statusEffects.length > 50) {
          throw new Error('Authenticated character projection exceeded its public integrity limit');
        }

        const publicAbilityVersionIds = new Set(
          abilities.map((ability) => ability.contentVersion.id),
        );
        return {
          actor: {
            id: actor.id,
            name: actor.name,
            species: actor.species,
            className: actor.className,
            role: actor.role,
            description: actor.description,
            level: actor.level,
            xp: actor.xp,
            gold: actor.gold,
            status: actor.status.toLowerCase(),
            campaignName: actor.campaign.name,
            worldName: actor.campaign.world.name,
            engineTick: actor.campaign.engineTick,
          },
          storedAttributes: actor.attributes.map((attribute) => ({
            code: attribute.code.toLowerCase(),
            baseValue: attribute.baseValue,
            earnedValue: attribute.earnedValue,
            xp: attribute.xp,
          })),
          mechanicalSheet,
          inventory: inventory.map((entry) => ({
            name: entry.contentVersion.name,
            customName: entry.customName,
            description: entry.contentVersion.description,
            contentType: entry.contentVersion.contentDefinition.contentType.toLowerCase(),
            quantity: entry.quantity,
            entryKind: entry.entryKind.toLowerCase(),
            lifecycle: entry.instanceLifecycle?.toLowerCase() ?? null,
            profile: entry.contentVersion.profile,
            inventorySpec: entry.contentVersion.inventorySpec,
            equippedSlots: entry.equipmentSlots.map((slot) => slot.slotRef.toLowerCase()),
          })),
          abilities: abilities.map((ability) => ({
            contentVersionId: ability.contentVersion.id,
            name: ability.contentVersion.name,
            description: ability.contentVersion.description,
            contentType: ability.contentDefinition.contentType.toLowerCase(),
            state: ability.state,
            rank: ability.rank,
            progress: ability.progress,
            mastery: ability.mastery,
            versionNumber: ability.contentVersion.versionNumber,
            profile: ability.contentVersion.profile,
          })),
          statusEffects: statusEffects.flatMap((effect) => {
            const explicitlyPublicEffect = effect.effectContentVersion !== null
              && effect.effectContentVersion.contentDefinition.status === ContentStatus.ACTIVE
              && effect.effectContentVersion.contentDefinition.worldId === actor.campaign.world.id
              && (effect.effectContentVersion.contentDefinition.campaignId === null
                || effect.effectContentVersion.contentDefinition.campaignId === campaignId)
              ? effect.effectContentVersion
              : null;
            const publicContent = explicitlyPublicEffect
              ?? (effect.sourceContentVersion.contentDefinition.status === ContentStatus.ACTIVE
                && effect.sourceContentVersion.contentDefinition.worldId === actor.campaign.world.id
                && (effect.sourceContentVersion.contentDefinition.campaignId === null
                  || effect.sourceContentVersion.contentDefinition.campaignId === campaignId)
                && publicAbilityVersionIds.has(effect.sourceContentVersion.id)
                ? effect.sourceContentVersion
                : null);
            return publicContent === null ? [] : [{
              name: publicContent.name,
              description: publicContent.description,
              stacks: effect.stacks,
              durationType: effect.durationType.toLowerCase(),
              expiresAtTick: effect.expiresAtTick,
              remainingActions: effect.remainingActions,
            }];
          }),
        };
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      });
    },
  };
}

export const prismaAuthenticatedCharacterViewRepository =
  createPrismaAuthenticatedCharacterViewRepository(prisma);

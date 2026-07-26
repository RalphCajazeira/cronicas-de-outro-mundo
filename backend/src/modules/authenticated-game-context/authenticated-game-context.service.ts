import { createHash } from 'node:crypto';
import {
  ActorControlPermission,
  ActorResourceType,
  ActorType,
  CampaignMembershipRole,
  CampaignMembershipStatus,
  UserStatus,
} from '../../generated/prisma/client.js';
import type { AppConfig } from '../../config/env.js';
import {
  authenticatedGameContextSchema,
  type AuthenticatedGameContextDto,
  type LoadAuthenticatedGameContextInput,
} from './authenticated-game-context.dto.js';
import { AuthenticatedGameContextAccessError } from './authenticated-game-context.errors.js';
import type {
  AuthenticatedActorControlRecord,
  AuthenticatedCampaignMembershipRecord,
  AuthenticatedGameContextRepository,
} from './authenticated-game-context.types.js';

const maximumCampaigns = 20;
const maximumActorControls = 100;

function selectionRef(kind: 'campaign' | 'character', userId: string, internalId: string): string {
  return `sel_${createHash('sha256')
    .update(`authenticated-${kind}-selection:v1`)
    .update('\0')
    .update(userId)
    .update('\0')
    .update(internalId)
    .digest('base64url')}`;
}

function normalizedCampaignStatus(status: AuthenticatedCampaignMembershipRecord['campaign']['status']) {
  return status.toLowerCase() as 'draft' | 'active' | 'paused' | 'completed' | 'archived';
}

function resourceMaximum(
  control: AuthenticatedActorControlRecord,
  type: ActorResourceType,
): number | null {
  const snapshot = control.actor.derivedSnapshot;
  if (snapshot === null) return null;
  if (type === ActorResourceType.HP) return snapshot.maxHp;
  if (type === ActorResourceType.MANA) return snapshot.maxMana;
  return snapshot.maxSp;
}

function publicResources(control: AuthenticatedActorControlRecord) {
  return control.actor.resources.map((resource) => ({
    code: resource.type.toLowerCase() as 'hp' | 'mana' | 'sp',
    current: resource.current,
    maximum: resourceMaximum(control, resource.type),
  }));
}

function banner(appEnvironment: AppConfig['APP_ENV']): string {
  return appEnvironment === 'staging'
    ? 'STAGING — CONTA SINTÉTICA'
    : `${appEnvironment.toUpperCase()} — CONTEXTO AUTENTICADO`;
}

export function createAuthenticatedGameContextService(
  repository: AuthenticatedGameContextRepository,
  config: Pick<AppConfig, 'APP_ENV' | 'NODE_ENV'>,
) {
  return {
    async load(
      userId: string,
      input: LoadAuthenticatedGameContextInput,
    ): Promise<AuthenticatedGameContextDto> {
      const access = await repository.findGameAccessByUserId(userId);
      if (access === null
        || access.id !== userId
        || access.status !== UserStatus.ACTIVE
        || access.suspendedAt !== null
        || access.deletedAt !== null
        || access.campaignMemberships.length > maximumCampaigns
        || access.actorControls.length > maximumActorControls) {
        throw new AuthenticatedGameContextAccessError('context_inconsistent');
      }

      const environment = {
        appEnvironment: config.APP_ENV,
        runtimeMode: config.NODE_ENV,
        syntheticAccount: config.APP_ENV === 'staging',
      } as const;

      if (access.player === null) {
        if (input.campaignSelectionRef !== undefined || input.characterSelectionRef !== undefined) {
          throw new AuthenticatedGameContextAccessError('resource_unavailable');
        }
        return authenticatedGameContextSchema.parse({
          authState: 'AUTHENTICATED_NO_PLAYER',
          player: null,
          narrativeContext: null,
          widgetContext: {
            banner: banner(config.APP_ENV),
            connectedPlayer: null,
            campaigns: [],
            activeContext: null,
            sessionState: 'NO_PLAYER',
            navigation: {
              canSelectCampaign: false,
              canSelectCharacter: false,
              canViewContext: false,
              canMutate: false,
            },
            cta: {
              kind: 'LINK_PLAYER',
              label: 'Aguardar vínculo do jogador',
            },
          },
          environment,
        });
      }

      const memberships = access.campaignMemberships.map((membership) => {
        if (membership.userId !== userId
          || membership.campaignId !== membership.campaign.id
          || membership.status !== CampaignMembershipStatus.ACTIVE
          || membership.revokedAt !== null) {
          throw new AuthenticatedGameContextAccessError('context_inconsistent');
        }
        return {
          record: membership,
          selectionRef: selectionRef('campaign', userId, membership.campaignId),
        };
      });
      const membershipByCampaign = new Map(memberships.map((membership) => [
        membership.record.campaignId,
        membership,
      ]));

      const controls = access.actorControls.flatMap((control) => {
        if (control.userId !== userId
          || control.actorId !== control.actor.id
          || control.revokedAt !== null
          || control.actor.actorType !== ActorType.CHARACTER
          || ![
            ActorControlPermission.VIEW,
            ActorControlPermission.CONTROL,
          ].includes(control.permission)) {
          throw new AuthenticatedGameContextAccessError('context_inconsistent');
        }
        const membership = membershipByCampaign.get(control.actor.campaignId);
        if (membership === undefined) return [];
        return [{
          record: control,
          campaignId: control.actor.campaignId,
          selectionRef: selectionRef('character', userId, control.actorId),
          effectiveViewOnly: membership.record.role === CampaignMembershipRole.OBSERVER
            || control.permission === ActorControlPermission.VIEW,
        }];
      });

      const campaignOptions = memberships.map((membership) => ({
        selectionRef: membership.selectionRef,
        displayName: membership.record.campaign.name,
        worldName: membership.record.campaign.world.name,
        status: normalizedCampaignStatus(membership.record.campaign.status),
        characters: controls
          .filter((control) => control.campaignId === membership.record.campaignId)
          .map((control) => ({
            selectionRef: control.selectionRef,
            displayName: control.record.actor.name,
            level: control.record.actor.level,
          })),
      }));

      if (memberships.length === 0) {
        if (input.campaignSelectionRef !== undefined || input.characterSelectionRef !== undefined) {
          throw new AuthenticatedGameContextAccessError('resource_unavailable');
        }
        return authenticatedGameContextSchema.parse({
          authState: 'AUTHENTICATED',
          player: { displayName: access.player.displayName },
          narrativeContext: null,
          widgetContext: {
            banner: banner(config.APP_ENV),
            connectedPlayer: access.player.displayName,
            campaigns: [],
            activeContext: null,
            sessionState: 'NO_CAMPAIGN',
            navigation: {
              canSelectCampaign: false,
              canSelectCharacter: false,
              canViewContext: false,
              canMutate: false,
            },
            cta: {
              kind: 'WAIT_FOR_CAMPAIGN',
              label: 'Nenhuma campanha autorizada',
            },
          },
          environment,
        });
      }

      const selectedMembership = input.campaignSelectionRef === undefined
        ? memberships.length === 1 ? memberships[0] : undefined
        : memberships.find((membership) => membership.selectionRef === input.campaignSelectionRef);
      if (input.campaignSelectionRef !== undefined && selectedMembership === undefined) {
        throw new AuthenticatedGameContextAccessError('resource_unavailable');
      }
      if (selectedMembership === undefined && input.characterSelectionRef !== undefined) {
        throw new AuthenticatedGameContextAccessError('selection_incomplete');
      }

      const selectedControls = selectedMembership === undefined
        ? []
        : controls.filter((control) => control.campaignId === selectedMembership.record.campaignId);
      const selectedControl = input.characterSelectionRef === undefined
        ? selectedControls.length === 1 ? selectedControls[0] : undefined
        : selectedControls.find((control) => control.selectionRef === input.characterSelectionRef);
      if (input.characterSelectionRef !== undefined && selectedControl === undefined) {
        throw new AuthenticatedGameContextAccessError('resource_unavailable');
      }

      const selectedCampaignOption = selectedMembership === undefined
        ? undefined
        : campaignOptions.find((campaign) => campaign.selectionRef === selectedMembership.selectionRef);
      if (selectedMembership !== undefined && selectedCampaignOption === undefined) {
        throw new AuthenticatedGameContextAccessError('context_inconsistent');
      }
      const resources = selectedControl === undefined ? [] : publicResources(selectedControl.record);
      const activeContext = selectedCampaignOption === undefined
        ? null
        : {
          campaign: {
            selectionRef: selectedCampaignOption.selectionRef,
            displayName: selectedCampaignOption.displayName,
            worldName: selectedCampaignOption.worldName,
            status: selectedCampaignOption.status,
          },
          character: selectedControl === undefined ? null : {
            selectionRef: selectedControl.selectionRef,
            displayName: selectedControl.record.actor.name,
            level: selectedControl.record.actor.level,
          },
          resources,
          readOnly: true as const,
        };
      const sessionState = selectedMembership === undefined
        ? 'CAMPAIGN_SELECTION_REQUIRED'
        : selectedControl === undefined && selectedControls.length > 0
          ? 'CHARACTER_SELECTION_REQUIRED'
          : 'READ_ONLY_READY';
      const cta = sessionState === 'CAMPAIGN_SELECTION_REQUIRED'
        ? { kind: 'SELECT_CAMPAIGN' as const, label: 'Selecionar campanha' }
        : sessionState === 'CHARACTER_SELECTION_REQUIRED'
          ? { kind: 'SELECT_CHARACTER' as const, label: 'Selecionar personagem' }
          : { kind: 'VIEW_CONTEXT' as const, label: 'Contexto somente leitura' };

      return authenticatedGameContextSchema.parse({
        authState: 'AUTHENTICATED',
        player: { displayName: access.player.displayName },
        narrativeContext: selectedCampaignOption === undefined ? null : {
          campaignName: selectedCampaignOption.displayName,
          characterName: selectedControl?.record.actor.name ?? null,
          publicLocation: null,
          continuitySummary: 'Nenhum checkpoint narrativo público persistido.',
          pendingDecision: null,
          criticalResources: resources,
          narrationClassification: 'NONE',
        },
        widgetContext: {
          banner: banner(config.APP_ENV),
          connectedPlayer: access.player.displayName,
          campaigns: campaignOptions,
          activeContext,
          sessionState,
          navigation: {
            canSelectCampaign: campaignOptions.length > 1,
            canSelectCharacter: selectedControls.length > 1,
            canViewContext: activeContext !== null,
            canMutate: false,
          },
          cta,
        },
        environment,
      });
    },
  };
}

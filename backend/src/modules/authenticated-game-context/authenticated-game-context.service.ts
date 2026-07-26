import {
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
import { authenticatedSelectionRef } from './authenticated-selection-ref.js';

const maximumCampaigns = 20;
const maximumActorControls = 100;

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
            gameSession: {
              status: 'NONE',
              stateVersion: 0,
              canContinue: false,
              selection: null,
            },
            sessionState: 'NO_PLAYER',
            navigation: {
              canSelectCampaign: false,
              canSelectCharacter: false,
              canViewContext: false,
              canMutate: false,
              canPersistSelection: false,
              canContinue: false,
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
          selectionRef: authenticatedSelectionRef('campaign', userId, membership.campaignId),
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
          selectionRef: authenticatedSelectionRef('character', userId, control.actorId),
          effectiveViewOnly: membership.record.role === CampaignMembershipRole.OBSERVER
            || control.permission === ActorControlPermission.VIEW,
        }];
      });

      const gameSessions = access.gameSessions ?? [];
      const latestSession = gameSessions[0];
      if (gameSessions.length > maximumCampaigns
        || (latestSession?.userId !== undefined && latestSession.userId !== userId)
        || (latestSession?.status !== undefined && latestSession.status !== GameSessionStatus.ACTIVE)
        || (latestSession?.closedAt !== undefined && latestSession.closedAt !== null)
        || (latestSession?.stateVersion !== undefined && latestSession.stateVersion < 1)) {
        throw new AuthenticatedGameContextAccessError('context_inconsistent');
      }
      const latestSessionMembership = latestSession === undefined
        ? undefined
        : memberships.find((entry) => entry.record.campaignId === latestSession.campaignId);
      const latestSessionControl = latestSession === undefined
        ? undefined
        : controls.find((entry) => (
          entry.record.actorId === latestSession.actorId
          && entry.campaignId === latestSession.campaignId
          && entry.record.actor.status === ActorStatus.ACTIVE
        ));
      const latestSessionUsable = latestSession !== undefined
        && latestSessionMembership !== undefined
        && latestSessionControl !== undefined
        && latestSessionMembership.record.campaign.status !== CampaignStatus.ARCHIVED;
      const gameSession = latestSession === undefined
        ? {
          status: 'NONE' as const,
          stateVersion: 0,
          canContinue: false,
          selection: null,
        }
        : latestSessionUsable
          ? {
            status: 'ACTIVE' as const,
            stateVersion: latestSession.stateVersion,
            canContinue: true,
            selection: {
              campaignSelectionRef: latestSessionMembership.selectionRef,
              characterSelectionRef: latestSessionControl.selectionRef,
            },
          }
          : {
            status: 'UNAVAILABLE' as const,
            stateVersion: latestSession.stateVersion,
            canContinue: false,
            selection: null,
          };

      const campaignOptions = memberships.map((membership) => ({
        selectionRef: membership.selectionRef,
        displayName: membership.record.campaign.name,
        worldName: membership.record.campaign.world.name,
        status: normalizedCampaignStatus(membership.record.campaign.status),
        sessionVersion: gameSessions.find(
          (session) => session.campaignId === membership.record.campaignId,
        )?.stateVersion ?? 0,
        characters: controls
          .filter((control) => control.campaignId === membership.record.campaignId)
          .map((control) => ({
            selectionRef: control.selectionRef,
            displayName: control.record.actor.name,
            level: control.record.actor.level,
            accessLabel: control.effectiveViewOnly ? 'Somente consulta' as const : 'Jogável' as const,
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
            gameSession,
            sessionState: 'NO_CAMPAIGN',
            navigation: {
              canSelectCampaign: false,
              canSelectCharacter: false,
              canViewContext: false,
              canMutate: false,
              canPersistSelection: false,
              canContinue: false,
            },
            cta: {
              kind: 'WAIT_FOR_CAMPAIGN',
              label: 'Nenhuma campanha autorizada',
            },
          },
          environment,
        });
      }

      const effectiveCampaignSelectionRef = input.campaignSelectionRef
        ?? (input.characterSelectionRef === undefined ? gameSession.selection?.campaignSelectionRef : undefined);
      const effectiveCharacterSelectionRef = input.characterSelectionRef
        ?? (input.campaignSelectionRef === undefined ? gameSession.selection?.characterSelectionRef : undefined);
      const selectedMembership = effectiveCampaignSelectionRef === undefined
        ? memberships.length === 1 ? memberships[0] : undefined
        : memberships.find((membership) => membership.selectionRef === effectiveCampaignSelectionRef);
      if (input.campaignSelectionRef !== undefined && selectedMembership === undefined) {
        throw new AuthenticatedGameContextAccessError('resource_unavailable');
      }
      if (selectedMembership === undefined && input.characterSelectionRef !== undefined) {
        throw new AuthenticatedGameContextAccessError('selection_incomplete');
      }

      const selectedControls = selectedMembership === undefined
        ? []
        : controls.filter((control) => control.campaignId === selectedMembership.record.campaignId);
      const selectedControl = effectiveCharacterSelectionRef === undefined
        ? selectedControls.length === 1 ? selectedControls[0] : undefined
        : selectedControls.find((control) => control.selectionRef === effectiveCharacterSelectionRef);
      if (effectiveCharacterSelectionRef !== undefined && selectedControl === undefined) {
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
            sessionVersion: selectedCampaignOption.sessionVersion,
          },
          character: selectedControl === undefined ? null : {
            selectionRef: selectedControl.selectionRef,
            displayName: selectedControl.record.actor.name,
            level: selectedControl.record.actor.level,
            accessLabel: selectedControl.effectiveViewOnly ? 'Somente consulta' : 'Jogável',
          },
          resources,
          readOnly: true as const,
        };
      const sessionState = selectedMembership === undefined
        ? 'CAMPAIGN_SELECTION_REQUIRED'
        : selectedControl === undefined && selectedControls.length > 0
          ? 'CHARACTER_SELECTION_REQUIRED'
          : 'READ_ONLY_READY';
      const canPersistSelection = selectedMembership !== undefined
        && selectedControl !== undefined
        && selectedMembership.record.campaign.status !== CampaignStatus.ARCHIVED;
      const hasPreviewSelection = input.campaignSelectionRef !== undefined
        && input.characterSelectionRef !== undefined
        && canPersistSelection;
      const cta = hasPreviewSelection
        ? { kind: 'CONFIRM_SELECTION' as const, label: 'Usar esta campanha e personagem' }
        : gameSession.canContinue
          ? { kind: 'CONTINUE' as const, label: 'Continuar' }
          : sessionState === 'CAMPAIGN_SELECTION_REQUIRED'
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
          gameSession,
          sessionState,
          navigation: {
            canSelectCampaign: campaignOptions.length > 1,
            canSelectCharacter: selectedControls.length > 1,
            canViewContext: activeContext !== null,
            canMutate: false,
            canPersistSelection,
            canContinue: gameSession.canContinue,
          },
          cta,
        },
        environment,
      });
    },
  };
}

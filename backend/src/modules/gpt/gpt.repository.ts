import { createHash } from 'node:crypto';
import {
  ActorContentState, ActorStatus, ActorType, CampaignStatus, ContentStatus, ContentType, Prisma,
} from '../../generated/prisma/client.js';
import { prisma } from '../../shared/database/prisma.js';
import { resolveBase, resolvePlayer, resolveScope, type DbClient } from '../../shared/database/game-scope.js';
import { ConflictError, NotFoundError } from '../../shared/errors/app-error.js';
import { normalizeEnum } from '../../shared/http/normalize-enum.js';
import { scopedActorKey } from '../actors/actors.repository.js';
import { createActorMechanicalState, loadActorMechanicalSheet } from '../actors/actor-mechanics.service.js';
import { findScopedContent } from '../content/content.repository.js';
import { mapInventoryHttpError } from '../inventory/inventory-http.errors.js';
import { loadActorInventorySummary, manageActorInventory } from '../inventory/inventory.service.js';
import {
  contentVersionPublicInclude,
  ContentEffectBindingResolutionError,
  publicContentDto,
  publicContentVersionDto,
  publishContentVersion,
  publishedContentInclude,
  type PublishedContent,
  type PublicContentVersion,
} from '../content/content-publication.service.js';
import { ensureCoreV1RulesetVersion } from '../rules/ruleset.registry.js';
import { ensureCoreV1EffectRulesVersion } from '../rules/effect-rules.registry.js';
import { getActorEffects, resolveActorEffectTransaction } from '../effects/effect-resolution.service.js';
import { loadActorActiveEffectSummary } from '../effects/effect-state.service.js';
import type {
  CreateEventInput, ListCampaignActorsInput, LoadGameInput, ManageActorContentInput, ManageActorInventoryInput,
  ListPlayerWorldsInput, ListWorldCampaignsInput, PatchActorInput, ResolveActorEffectInput, StartGameInput, UpsertActorInput, UpsertContentInput,
} from './gpt.schemas.js';
import type { ApiResult, GptRepository } from './gpt.types.js';
import {
  CAMPAIGN_STARTED_EVENT_MAX_BYTES, IDEMPOTENT_TRANSACTION_OPTIONS, canonicalJsonEqual, canonicalize, jsonByteSize, resolveDifficulty,
  type CampaignStartedPayload,
} from './gpt.start-game.js';
import { inspectIdempotencyRecord, isIdempotencyKeyConflict, isUniqueConflict } from './gpt.prisma-errors.js';
import { ACTIVE_ENCOUNTER_LIFECYCLES, activeEncounterSummary } from '../encounters/encounter.types.js';
import { assertActorsMutableOutsideEncounter } from '../encounters/encounter-authority-guard.js';
import { loadActorReadiness } from '../actors/actor-readiness.service.js';
import { EncounterError } from '../encounters/encounter.errors.js';
import { findEncounterRecord, validateLoadedEncounter } from '../encounters/encounter-state-loader.js';

const actorSelect = {
  id: true, code: true, name: true, actorType: true, species: true, className: true, role: true,
  description: true, level: true, xp: true, gold: true, metadata: true, status: true,
  appearance: true, personality: true,
} satisfies Prisma.ActorSelect;

const contentInclude = {
  contentDefinition: true,
  contentVersion: { include: contentVersionPublicInclude },
} satisfies Prisma.ActorContentInclude;

async function loadActiveEncounterSummary(client: DbClient, campaignId: string) {
  const records = await client.encounter.findMany({
    where: { campaignId, lifecycleStatus: { in: [...ACTIVE_ENCOUNTER_LIFECYCLES] } },
    select: { encounterRef: true, lifecycleStatus: true, stateVersion: true },
    orderBy: { encounterRef: 'asc' },
    take: 2,
  });
  const summary = activeEncounterSummary(records);
  if (summary === null) return null;
  try {
    const record = await findEncounterRecord(client, campaignId, summary.encounterRef);
    await validateLoadedEncounter(client, record);
    return activeEncounterSummary(records, 'validated');
  } catch (error) {
    if (error instanceof EncounterError && [
      'ENCOUNTER_MECHANICS_DRIFT', 'ENCOUNTER_RESOURCE_DRIFT', 'ENCOUNTER_INVENTORY_DRIFT',
      'ENCOUNTER_EFFECTS_DRIFT', 'ENCOUNTER_CAMPAIGN_TICK_DRIFT',
    ].includes(error.code)) {
      return activeEncounterSummary(records, 'authority_drift');
    }
    return summary;
  }
}

export function calculateGptRequestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function inputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

async function executeIdempotent(
  key: string,
  operation: string,
  request: unknown,
  work: (transaction: Prisma.TransactionClient) => Promise<ApiResult>,
): Promise<ApiResult> {
  const hash = calculateGptRequestHash(request);
  try {
    return await prisma.$transaction(async (transaction) => {
      await transaction.idempotencyRecord.create({ data: { key, operation, requestHash: hash } });
      const response = await work(transaction);
      await transaction.idempotencyRecord.update({ where: { key }, data: { response: inputJson(response) } });
      return response;
    }, IDEMPOTENT_TRANSACTION_OPTIONS);
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    if (!isIdempotencyKeyConflict(error)) throw new ConflictError('Resource already exists');
    const persisted = await prisma.idempotencyRecord.findUnique({ where: { key } });
    const inspection = inspectIdempotencyRecord(persisted, operation, hash);
    if (inspection.kind === 'conflict') {
      if (['operation', 'requestHash'].includes(inspection.reason)) throw new ConflictError('Idempotency key already used');
      throw new ConflictError('Idempotency request is not complete');
    }
    return inspection.response;
  }
}

async function actorDto(client: DbClient, actor: Record<string, unknown>) {
  const mechanicalSheet = await loadActorMechanicalSheet(client, actor.id as string);
  const inventorySummary = await loadActorInventorySummary(client, actor.id as string);
  const activeEffectSummary = await loadActorActiveEffectSummary(client, actor.id as string);
  return {
    code: actor.code, name: actor.name, actorType: normalizeEnum(actor.actorType as string), species: actor.species,
    className: actor.className, role: actor.role, description: actor.description, level: actor.level, xp: actor.xp,
    gold: actor.gold, metadata: actor.metadata, appearance: actor.appearance, personality: actor.personality,
    status: normalizeEnum(actor.status as string), ...mechanicalSheet, inventorySummary,
    activeEffectSummary,
  };
}

function actorContentDto(link: Record<string, unknown> & {
  contentDefinition: Record<string, unknown>;
  contentVersion: PublicContentVersion;
}) {
  return {
    ...publicContentVersionDto(link.contentDefinition as Pick<PublishedContent, 'code' | 'contentType' | 'status'>, link.contentVersion),
    state: normalizeEnum(link.state as string), rank: link.rank,
    progress: link.progress, mastery: link.mastery,
    notes: link.notes, linkMetadata: link.metadata,
  };
}

async function findActor(client: DbClient, campaignId: string, reference: string) {
  const actor = await client.actor.findUnique({ where: scopedActorKey(campaignId, reference), select: actorSelect });
  if (actor === null) throw new NotFoundError('Actor');
  return actor;
}

function actorUpdateData(input: UpsertActorInput | PatchActorInput): Prisma.ActorUpdateInput {
  const data: Prisma.ActorUpdateInput = {};
  if ('name' in input && input.name !== undefined) data.name = input.name;
  if ('species' in input && input.species !== undefined) data.species = input.species;
  if ('className' in input && input.className !== undefined) data.className = input.className;
  if (input.role !== undefined) data.role = input.role;
  if (input.description !== undefined) data.description = input.description;
  if (input.appearance !== undefined) data.appearance = inputJson(input.appearance);
  if (input.personality !== undefined) data.personality = inputJson(input.personality);
  if (input.metadata !== undefined) data.metadata = inputJson(input.metadata);
  return data;
}

function actorCreateData(
  campaignId: string,
  input: UpsertActorInput | StartGameInput['protagonist'],
): Prisma.ActorUncheckedCreateInput {
  const data: Prisma.ActorUncheckedCreateInput = {
    campaignId, code: input.code, name: input.name, actorType: input.actorType.toUpperCase() as ActorType,
    level: 'level' in input ? input.level ?? 1 : 1, xp: 0, gold: 0,
    appearance: inputJson(input.appearance ?? {}),
    personality: inputJson(input.personality ?? {}),
    metadata: inputJson({ ...(input.metadata ?? {}), ...('origin' in input && input.origin !== undefined ? { origin: input.origin } : {}) }),
    status: ActorStatus.ACTIVE,
  };
  if (input.species !== undefined) data.species = input.species;
  if (input.className !== undefined) data.className = input.className;
  if (input.role !== undefined) data.role = input.role;
  if (input.description !== undefined) data.description = input.description;
  return data;
}

function linkUpdateData(input: ManageActorContentInput): Prisma.ActorContentUpdateInput {
  const changes = input.changes;
  const data: Prisma.ActorContentUpdateInput = {};
  if (changes?.state !== undefined) data.state = changes.state.toUpperCase() as ActorContentState;
  if (changes?.rank !== undefined) data.rank = changes.rank;
  if (changes?.progress !== undefined) data.progress = changes.progress;
  if (changes?.mastery !== undefined) data.mastery = changes.mastery;
  if (changes?.notes !== undefined) data.notes = changes.notes;
  if (changes?.metadata !== undefined) data.metadata = inputJson(changes.metadata);
  return data;
}

async function loadGameState(client: DbClient, input: LoadGameInput) {
  const { player, world, campaign } = await resolveScope(client, input);
  const actors = await client.actor.findMany({ where: { campaignId: campaign.id }, select: actorSelect, orderBy: [{ role: 'asc' }, { name: 'asc' }, { code: 'asc' }], take: 50 });
  const links = await client.actorContent.findMany({ where: { actor: { campaignId: campaign.id } }, include: { ...contentInclude, actor: { select: { code: true } } }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: 100 });
  const events = await client.gameEvent.findMany({ where: { campaignId: campaign.id }, include: { actor: { select: { code: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: 20 });
  const activeEncounter = await loadActiveEncounterSummary(client, campaign.id);
  const protagonist = actors.find((actor) => actor.code === player.slug && actor.actorType === ActorType.CHARACTER) ?? null;
  const actorDtos = new Map<string, Record<string, unknown>>();
  for (const actor of actors) actorDtos.set(actor.id, await actorDto(client, actor));
  return {
    player: { ref: player.slug, displayName: player.displayName },
    world: { ref: world.code, name: world.name, description: world.description, metadata: world.metadata },
    campaign: { ref: campaign.code, name: campaign.name, status: normalizeEnum(campaign.status), currentTime: campaign.currentTime, metadata: campaign.metadata },
    protagonist: protagonist === null ? null : {
      ...(actorDtos.get(protagonist.id) ?? {}),
      readiness: await loadActorReadiness(client, protagonist.id),
    },
    mainActors: actors.filter((actor) => actor.id !== protagonist?.id).map((actor) => actorDtos.get(actor.id) ?? {}),
    linkedContent: links.map((link) => ({ actorRef: link.actor.code, ...actorContentDto(link) })),
    activeEncounter,
    recentEvents: events.map((event) => ({ actorRef: event.actor?.code ?? null, eventType: event.eventType, title: event.title, payload: event.payload, createdAt: event.createdAt.toISOString() })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertPersistedRequirements(
  version: PublicContentVersion,
  link: StartGameInput['initialContentPackages'][number]['protagonistLink'],
  linkedKnown: Set<string>,
  attributes: Record<string, unknown>,
) {
  const profile = isRecord(version.profile) ? version.profile : null;
  const requirements = profile !== null && isRecord(profile.requirements) ? profile.requirements : null;
  if (link === undefined || !['known', 'mastered'].includes(link.state) || requirements === null) return;
  const requiredContent = requirements.requiredContent;
  if (Array.isArray(requiredContent)) {
    for (const required of requiredContent) {
      if (!isRecord(required) || typeof required.contentKind !== 'string' || typeof required.code !== 'string'
        || !linkedKnown.has(`${required.contentKind}:${required.code}`)) {
        throw new ConflictError('Initial content requirements are not met');
      }
    }
  }
  const minimumAttributes = requirements.minimumPrimaryAttributes;
  if (isRecord(minimumAttributes)) {
    for (const [attribute, minimum] of Object.entries(minimumAttributes)) {
      if (typeof minimum !== 'number' || typeof attributes[attribute] !== 'number' || attributes[attribute] < minimum) {
        throw new ConflictError('Initial attribute requirements are not met');
      }
    }
  }
  if (typeof requirements.minimumLevel === 'number' && requirements.minimumLevel > 1) {
    throw new ConflictError('Initial level requirements are not met');
  }
}

function worldConfiguration(metadata: Prisma.JsonValue): unknown {
  return isRecord(metadata) ? metadata.worldConfig : undefined;
}

export const prismaGptRepository: GptRepository = {
  async loadGame(input: LoadGameInput) {
    return prisma.$transaction((transaction) => loadGameState(transaction, input), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  },

  async listPlayerWorlds(input: ListPlayerWorldsInput) {
    const player = await resolvePlayer(prisma, input);
    const worlds = await prisma.world.findMany({
      where: { playerId: player.id },
      select: { code: true, name: true, description: true },
      orderBy: { code: 'asc' },
    });
    return worlds.map((world) => ({ ref: world.code, name: world.name, description: world.description }));
  },

  async listWorldCampaigns(input: ListWorldCampaignsInput) {
    const { player, world } = await resolveBase(prisma, input);
    const campaigns = await prisma.campaign.findMany({
      where: { worldId: world.id },
      select: {
        code: true, name: true, status: true, currentTime: true,
        actors: { where: { code: player.slug, actorType: ActorType.CHARACTER }, select: { code: true }, take: 1 },
      },
      orderBy: { code: 'asc' },
    });
    return campaigns.map((campaign) => ({
      ref: campaign.code, name: campaign.name, status: normalizeEnum(campaign.status), currentTime: campaign.currentTime,
      hasProtagonist: campaign.actors.length > 0,
    }));
  },

  async startGame(input: StartGameInput) {
    return executeIdempotent(input.idempotencyKey, 'game.start', input, async (transaction) => {
      const officialRulesetVersion = await ensureCoreV1RulesetVersion(transaction);
      await ensureCoreV1EffectRulesVersion(transaction);
      const existingPlayer = await transaction.player.findUnique({ where: { slug: input.playerRef } });
      if (input.playerMode === 'create' && existingPlayer !== null) throw new ConflictError('Player already exists');
      if (input.playerMode === 'reuse' && existingPlayer === null) throw new NotFoundError('Player');
      if (existingPlayer !== null && input.playerDisplayName !== undefined && existingPlayer.displayName !== input.playerDisplayName) {
        throw new ConflictError('Player display name does not match');
      }
      const player = existingPlayer ?? await transaction.player.create({
        data: { slug: input.playerRef, displayName: input.playerDisplayName ?? '' },
      });

      const existingWorld = await transaction.world.findUnique({
        where: { playerId_code: { playerId: player.id, code: input.worldRef } },
        include: {
          defaultRulesetVersion: { select: { code: true, revision: true, configHash: true } },
        },
      });
      if (input.worldMode === 'create' && existingWorld !== null) throw new ConflictError('World already exists');
      if (input.worldMode === 'reuse' && existingWorld === null) throw new NotFoundError('World');
      if (existingWorld !== null) {
        if (existingWorld.defaultRulesetVersionId !== officialRulesetVersion.id
          || existingWorld.defaultRulesetVersion.code !== officialRulesetVersion.code
          || existingWorld.defaultRulesetVersion.revision !== officialRulesetVersion.revision
          || existingWorld.defaultRulesetVersion.configHash !== officialRulesetVersion.configHash) {
          throw new ConflictError('World ruleset is not compatible with core-v1');
        }
        if (input.worldName !== undefined && existingWorld.name !== input.worldName) throw new ConflictError('World name does not match');
        if (input.worldDescription !== undefined && existingWorld.description !== input.worldDescription) throw new ConflictError('World description does not match');
        if (input.worldConfiguration !== undefined && !canonicalJsonEqual(worldConfiguration(existingWorld.metadata), input.worldConfiguration)) {
          throw new ConflictError('World configuration does not match');
        }
      }
      const world = existingWorld ?? await transaction.world.create({
        data: {
          playerId: player.id, defaultRulesetVersionId: officialRulesetVersion.id,
          code: input.worldRef, name: input.worldName ?? '',
          ...(input.worldDescription === undefined ? {} : { description: input.worldDescription }),
          metadata: inputJson({ worldConfig: input.worldConfiguration }),
        },
      });

      const existingCampaign = await transaction.campaign.findUnique({
        where: { worldId_code: { worldId: world.id, code: input.campaignRef } },
      });
      if (existingCampaign !== null) throw new ConflictError('Campaign already exists');

      const effectiveProfile = resolveDifficulty(input.campaignConfiguration.difficulty.preset, input.campaignConfiguration.difficulty.overrides);
      const campaignConfig = {
        ...input.campaignConfiguration,
        difficulty: { ...input.campaignConfiguration.difficulty, overrides: input.campaignConfiguration.difficulty.overrides ?? {}, effectiveProfile },
      };
      const campaign = await transaction.campaign.create({
        data: {
          worldId: world.id, rulesetVersionId: world.defaultRulesetVersionId,
          code: input.campaignRef, name: input.campaignName,
          status: CampaignStatus.ACTIVE, metadata: inputJson({ campaignConfig }),
        },
      });
      const protagonist = await transaction.actor.create({ data: actorCreateData(campaign.id, input.protagonist), select: actorSelect });
      await createActorMechanicalState(transaction, {
        actorId: protagonist.id,
        primaryAttributes: input.protagonist.primaryAttributes,
      });

      type ResolvedInitialPackage = {
        definition: PublishedContent;
        link: StartGameInput['initialContentPackages'][number]['protagonistLink'];
        scope: 'world' | 'campaign';
      };
      const resolvedByIndex: Array<ResolvedInitialPackage | undefined> = Array.from(
        { length: input.initialContentPackages.length },
        () => undefined,
      );
      let pendingIndexes = input.initialContentPackages.map((_, index) => index);
      while (pendingIndexes.length > 0) {
        const deferred: number[] = [];
        let progress = false;
        for (const index of pendingIndexes) {
          const item = input.initialContentPackages[index];
          if (item === undefined) throw new ConflictError('Initial content package ordering is invalid');
          const definitionInput = item.definition;
          const type = definitionInput.contentType.toUpperCase() as ContentType;
          if (definitionInput.mode === 'reuse') {
            const definition = await transaction.contentDefinition.findFirst({
              where: { worldId: world.id, campaignId: null, contentType: type, code: definitionInput.code },
              include: publishedContentInclude,
            });
            if (definition === null) throw new NotFoundError('Content');
            const version = definition.versions[0];
            if (definition.status !== ContentStatus.ACTIVE || version === undefined) throw new ConflictError('Reused content is not an active publication');
            if (version.rulesetVersionId !== campaign.rulesetVersionId) throw new ConflictError('Reused content is not compatible with the Campaign ruleset');
            resolvedByIndex[index] = { definition, link: item.protagonistLink, scope: definitionInput.scope };
            progress = true;
            continue;
          }

          const campaignId = definitionInput.scope === 'campaign' ? campaign.id : null;
          const exact = await transaction.contentDefinition.findFirst({
            where: { worldId: world.id, campaignId, contentType: type, code: definitionInput.code },
          });
          if (exact !== null) throw new ConflictError('Content definition already exists');
          if (definitionInput.scope === 'campaign') {
            const global = await transaction.contentDefinition.findFirst({
              where: { worldId: world.id, campaignId: null, contentType: type, code: definitionInput.code },
            });
            if (global !== null && definitionInput.overridesWorldDefinition !== true) throw new ConflictError('Campaign content requires an explicit World override');
            if (global === null && definitionInput.overridesWorldDefinition === true) throw new ConflictError('World content to override was not found');
          }
          try {
            const definition = await publishContentVersion(transaction, {
              worldId: world.id, campaignId, code: definitionInput.code, contentType: type,
              name: definitionInput.name ?? '', description: definitionInput.description ?? null,
              profile: definitionInput.profile, inventorySpec: definitionInput.inventorySpec,
              presentation: definitionInput.presentation ?? {},
              tags: definitionInput.tags ?? [], status: ContentStatus.ACTIVE,
              metadata: definitionInput.metadata ?? {},
            });
            resolvedByIndex[index] = { definition, link: item.protagonistLink, scope: definitionInput.scope };
            progress = true;
          } catch (error) {
            if (!(error instanceof ContentEffectBindingResolutionError)) throw error;
            deferred.push(index);
          }
        }
        if (!progress) throw new ConflictError('Initial content effect dependencies are missing or cyclic');
        pendingIndexes = deferred;
      }
      const resolvedPackages = resolvedByIndex.map((item) => {
        if (item === undefined) throw new ConflictError('Initial content package was not resolved');
        return item;
      });

      const linkedKnown = new Set(resolvedPackages.filter((item) => ['known', 'mastered'].includes(item.link?.state ?? ''))
        .map((item) => `${normalizeEnum(item.definition.contentType)}:${item.definition.code}`));
      if (input.campaignConfiguration.classModel.mode === 'mechanical'
        && ['required', 'optional'].includes(input.campaignConfiguration.classModel.startingClass)) {
        const linkedClasses = resolvedPackages.filter((item) => item.definition.contentType === ContentType.CLASS && item.link !== undefined);
        if (linkedClasses.length === 1 && input.protagonist.className !== undefined && input.protagonist.className !== null
          && linkedClasses[0]?.definition.versions[0]?.name !== input.protagonist.className) {
          throw new ConflictError('Mechanical class name does not match the persisted class definition');
        }
      }
      const attributes = input.protagonist.primaryAttributes;
      for (const item of resolvedPackages) {
        if (item.link === undefined) continue;
        const version = item.definition.versions[0];
        if (version === undefined) throw new ConflictError('Content definition has no published version');
        assertPersistedRequirements(version, item.link, linkedKnown, attributes);
        await transaction.actorContent.create({
          data: {
            actorId: protagonist.id, contentDefinitionId: item.definition.id, contentVersionId: version.id,
            state: item.link.state.toUpperCase() as ActorContentState, rank: item.link.rank, progress: item.link.progress,
            mastery: item.link.mastery,
            ...(item.link.notes === undefined ? {} : { notes: item.link.notes }), metadata: inputJson(item.link.metadata ?? {}),
          },
        });
      }

      let expectedInventoryStateVersion = 1;
      const initialInventoryResults: Array<{ item: NonNullable<StartGameInput['initialInventory']>[number]; versionNumber: number }> = [];
      for (const inventoryItem of input.initialInventory ?? []) {
        const resolved = resolvedPackages.find((item) => item.scope === inventoryItem.scope
          && normalizeEnum(item.definition.contentType) === inventoryItem.contentType && item.definition.code === inventoryItem.code);
        const version = resolved?.definition.versions[0];
        if (resolved === undefined || version === undefined) throw new ConflictError('Initial inventory content was not resolved');
        const result = await manageActorInventory(transaction, protagonist.code, {
          playerRef: input.playerRef, worldRef: input.worldRef, campaignRef: input.campaignRef,
          operation: 'grant', idempotencyKey: `${input.idempotencyKey}:inventory:grant:${inventoryItem.code}`,
          expectedInventoryStateVersion,
          contentRef: {
            scope: inventoryItem.scope, contentType: inventoryItem.contentType,
            code: inventoryItem.code, versionNumber: version.versionNumber,
          },
          quantity: inventoryItem.quantity, entryRefs: inventoryItem.entryRefs,
          ...(inventoryItem.customName === undefined ? {} : { customName: inventoryItem.customName }),
        });
        expectedInventoryStateVersion = result.inventoryStateVersion;
        initialInventoryResults.push({ item: inventoryItem, versionNumber: version.versionNumber });
      }
      for (const { item } of initialInventoryResults) {
        if (item.equip === undefined) continue;
        if (item.entryRefs.length !== 1) throw new ConflictError('Initial equipped item must resolve to one entry ref');
        const result = await manageActorInventory(transaction, protagonist.code, {
          playerRef: input.playerRef, worldRef: input.worldRef, campaignRef: input.campaignRef,
          operation: 'equip', idempotencyKey: `${input.idempotencyKey}:inventory:equip:${item.entryRefs[0]}`,
          expectedInventoryStateVersion, entryRef: item.entryRefs[0],
          ...item.equip,
        });
        expectedInventoryStateVersion = result.inventoryStateVersion;
      }

      const effectiveWorldConfig = input.worldConfiguration ?? worldConfiguration(world.metadata);
      const worldConfigRecord = isRecord(effectiveWorldConfig) ? effectiveWorldConfig : {};
      const rawTechnologyGrade = isRecord(worldConfigRecord.technologyLevel) ? worldConfigRecord.technologyLevel.grade : null;
      const rawMagicGrade = isRecord(worldConfigRecord.magicLevel) ? worldConfigRecord.magicLevel.grade : null;
      const technologyGrade = typeof rawTechnologyGrade === 'string' ? rawTechnologyGrade : null;
      const magicGrade = typeof rawMagicGrade === 'string' ? rawMagicGrade : null;
      const eventPayload: CampaignStartedPayload = {
        schemaVersion: 1, technical: true,
        difficultyPreset: input.campaignConfiguration.difficulty.preset, difficultyProfile: effectiveProfile,
        worldConfigSummary: {
          schemaVersion: 1, genres: Array.isArray(worldConfigRecord.genres)
            ? worldConfigRecord.genres.filter((genre): genre is string => typeof genre === 'string') : [],
          technologyGrade, magicGrade,
        },
        campaignConfigSummary: {
          schemaVersion: 1, progressionPace: input.campaignConfiguration.progressionPace,
          narrativeTone: input.campaignConfiguration.narrativeTone, focus: input.campaignConfiguration.focus,
          playerFreedom: input.campaignConfiguration.playerFreedom, consequenceLevel: input.campaignConfiguration.consequenceLevel,
          classMode: input.campaignConfiguration.classModel.mode,
        },
        initialContent: resolvedPackages.map((item) => ({
          scope: item.scope, contentType: normalizeEnum(item.definition.contentType), code: item.definition.code,
          linkedToProtagonist: item.link !== undefined,
        })),
        initialPremise: input.initialPremise,
      };
      if (jsonByteSize(eventPayload) > CAMPAIGN_STARTED_EVENT_MAX_BYTES) throw new ConflictError('Campaign start event exceeds the safe size limit');

      await transaction.gameEvent.create({
        data: {
          campaignId: campaign.id, actorId: protagonist.id, eventType: 'campaign-started', title: 'Campanha iniciada',
          payload: inputJson(eventPayload),
        },
      });
      return loadGameState(transaction, { playerRef: input.playerRef, worldRef: input.worldRef, campaignRef: input.campaignRef });
    });
  },

  async listCampaignActors(input: ListCampaignActorsInput) {
    const { campaign } = await resolveScope(prisma, input);
    const actors = await prisma.actor.findMany({ where: { campaignId: campaign.id }, select: actorSelect, orderBy: [{ name: 'asc' }, { code: 'asc' }] });
    return Promise.all(actors.map((actor) => actorDto(prisma, actor)));
  },

  async upsertActor(input: UpsertActorInput) {
    return executeIdempotent(input.idempotencyKey, 'actors.upsert', input, async (transaction) => {
      const { campaign } = await resolveScope(transaction, input);
      const existing = await transaction.actor.findUnique({
        where: { campaignId_code: { campaignId: campaign.id, code: input.code } },
        select: actorSelect,
      });
      if (existing === null) {
        const actor = await transaction.actor.create({ data: actorCreateData(campaign.id, input), select: actorSelect });
        await createActorMechanicalState(transaction, { actorId: actor.id, primaryAttributes: input.primaryAttributes });
        return actorDto(transaction, actor);
      }
      await assertActorsMutableOutsideEncounter(transaction, campaign.id, [existing]);
      const existingSheet = await loadActorMechanicalSheet(transaction, existing.id);
      if (existing.actorType !== input.actorType.toUpperCase() || (input.level !== undefined && existing.level !== input.level)
        || !canonicalJsonEqual(existingSheet.primaryAttributes, input.primaryAttributes)) {
        throw new ConflictError('Actor mechanics cannot be changed by upsertActor');
      }
      const actor = await transaction.actor.update({ where: { id: existing.id }, data: actorUpdateData(input), select: actorSelect });
      return actorDto(transaction, actor);
    });
  },

  async patchActor(actorRef: string, input: PatchActorInput) {
    return executeIdempotent(input.idempotencyKey, 'actors.patch', { actorRef, ...input }, async (transaction) => {
      const { campaign } = await resolveScope(transaction, input);
      const actor = await findActor(transaction, campaign.id, actorRef);
      await assertActorsMutableOutsideEncounter(transaction, campaign.id, [actor]);
      const updated = await transaction.actor.update({ where: { id: actor.id }, data: actorUpdateData(input), select: actorSelect });
      return actorDto(transaction, updated);
    });
  },

  async upsertContent(input: UpsertContentInput) {
    return executeIdempotent(input.idempotencyKey, 'content.upsert', input, async (transaction) => {
      const { world } = await resolveBase(transaction, input);
      let campaignId: string | null = null;
      if (input.campaignRef !== null) {
        const campaign = await transaction.campaign.findUnique({ where: { worldId_code: { worldId: world.id, code: input.campaignRef } } });
        if (campaign === null) throw new NotFoundError('Campaign');
        campaignId = campaign.id;
      }
      const type = input.contentType.toUpperCase() as ContentType;
      const content = await publishContentVersion(transaction, {
        worldId: world.id, campaignId, contentType: type, code: input.code,
        name: input.name, description: input.description, profile: input.profile,
        inventorySpec: input.inventorySpec,
        presentation: input.presentation, tags: input.tags,
        status: input.status.toUpperCase() as ContentStatus, metadata: input.metadata ?? {},
      });
      return publicContentDto(content);
    });
  },

  async manageActorContent(actorRef: string, input: ManageActorContentInput) {
    const read = async (client: DbClient) => {
      const { world, campaign } = await resolveScope(client, input);
      const actor = await findActor(client, campaign.id, actorRef);
      if (input.operation === 'list') {
        const links = await client.actorContent.findMany({
          where: { actorId: actor.id }, include: contentInclude,
          orderBy: [{ contentVersion: { name: 'asc' } }, { contentDefinition: { contentType: 'asc' } }, { contentDefinition: { code: 'asc' } }],
        });
        return links.map(actorContentDto);
      }
      const type = (input.contentType ?? 'other').toUpperCase() as ContentType;
      let link = await client.actorContent.findFirst({
        where: {
          actorId: actor.id,
          contentDefinition: {
            worldId: world.id, campaignId: campaign.id, contentType: type, code: input.contentRef ?? '',
          },
        },
        include: contentInclude,
      });
      link ??= await client.actorContent.findFirst({
        where: {
          actorId: actor.id,
          contentDefinition: {
            worldId: world.id, campaignId: null, contentType: type, code: input.contentRef ?? '',
          },
        },
        include: contentInclude,
      });
      if (input.operation === 'get') {
        if (link === null) throw new NotFoundError('Actor content');
        return actorContentDto(link);
      }
      if (['update', 'remove'].includes(input.operation)) {
        if (link === null) throw new NotFoundError('Actor content');
        return { actor, definition: link.contentDefinition, link, campaignId: campaign.id };
      }
      const definition = await findScopedContent(client, {
        worldId: world.id, campaignId: campaign.id, rulesetVersionId: campaign.rulesetVersionId,
      }, input.contentRef ?? '', input.contentType ?? 'other');
      const existingLink = await client.actorContent.findUnique({
        where: { actorId_contentDefinitionId: { actorId: actor.id, contentDefinitionId: definition.id } },
        include: contentInclude,
      });
      return { actor, definition, link: existingLink, campaignId: campaign.id };
    };

    if (['get', 'list'].includes(input.operation)) return read(prisma);
    return executeIdempotent(input.idempotencyKey ?? '', `actorContent.${input.operation}`, { actorRef, ...input }, async (transaction) => {
      const resolved = await read(transaction);
      if (Array.isArray(resolved) || !('actor' in resolved)) throw new ConflictError();
      const { actor, definition, link, campaignId } = resolved;
      await assertActorsMutableOutsideEncounter(transaction, campaignId, [actor]);
      if (input.operation === 'remove') {
        if (link === null) throw new NotFoundError('Actor content');
        await transaction.actorContent.delete({ where: { id: link.id } });
        return { actorRef: actor.code, contentRef: definition.code, removed: true };
      }
      if (input.operation === 'update' && link === null) throw new NotFoundError('Actor content');
      const changes = linkUpdateData(input);
      if (input.operation === 'update') {
        if (link === null) throw new NotFoundError('Actor content');
        await transaction.actorContent.update({ where: { id: link.id }, data: changes });
        const updated = await transaction.actorContent.findUniqueOrThrow({ where: { id: link.id }, include: contentInclude });
        return actorContentDto(updated);
      }
      const defaultState = input.operation === 'learn' ? ActorContentState.LEARNING : ActorContentState.KNOWN;
      const currentVersion = 'versions' in definition ? definition.versions[0] : undefined;
      if (currentVersion === undefined) throw new ConflictError('Content definition has no published version');
      const createData: Prisma.ActorContentUncheckedCreateInput = {
        actorId: actor.id, contentDefinitionId: definition.id, contentVersionId: currentVersion.id,
        state: input.changes?.state?.toUpperCase() as ActorContentState | undefined ?? defaultState,
        rank: input.changes?.rank ?? (input.operation === 'grant' ? 1 : 0), progress: input.changes?.progress ?? 0,
        mastery: input.changes?.mastery ?? 0, metadata: inputJson(input.changes?.metadata ?? {}),
      };
      if (input.changes?.notes !== undefined) createData.notes = input.changes.notes;
      const updatedReference = await transaction.actorContent.upsert({
        where: { actorId_contentDefinitionId: { actorId: actor.id, contentDefinitionId: definition.id } },
        update: changes,
        create: createData,
        select: { id: true },
      });
      const updated = await transaction.actorContent.findUniqueOrThrow({ where: { id: updatedReference.id }, include: contentInclude });
      return actorContentDto(updated);
    });
  },

  async manageActorInventory(actorRef: string, input: ManageActorInventoryInput) {
    try {
      if (input.operation === 'get') return await manageActorInventory(prisma, actorRef, input);
      return await executeIdempotent(input.idempotencyKey ?? '', `actorInventory.${input.operation}`, { actorRef, ...input },
        (transaction) => manageActorInventory(transaction, actorRef, input));
    } catch (error) {
      const publicError = mapInventoryHttpError(error);
      if (publicError !== null) throw publicError;
      throw error;
    }
  },

  async createEvent(input: CreateEventInput) {
    return executeIdempotent(input.idempotencyKey, 'events.create', input, async (transaction) => {
      const { campaign } = await resolveScope(transaction, input);
      const actor = input.actorRef === undefined ? null : await findActor(transaction, campaign.id, input.actorRef);
      const event = await transaction.gameEvent.create({
        data: {
          campaignId: campaign.id, actorId: actor?.id ?? null, eventType: input.eventType, title: input.title,
          payload: inputJson(input.payload), idempotencyKey: input.idempotencyKey,
        },
      });
      return { campaignRef: campaign.code, actorRef: actor?.code ?? null, eventType: event.eventType, title: event.title, payload: event.payload, createdAt: event.createdAt.toISOString() };
    });
  },

  async resolveActorEffect(input: ResolveActorEffectInput) {
    if (input.operation === 'get') return prisma.$transaction((transaction) => getActorEffects(transaction, input));
    return executeIdempotent(input.idempotencyKey ?? '', `actorEffects.${input.operation}`, input, (transaction) => (
      resolveActorEffectTransaction(transaction, input, calculateGptRequestHash(input))
    ));
  },
};

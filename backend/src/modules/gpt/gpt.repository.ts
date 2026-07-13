import { createHash } from 'node:crypto';
import {
  ActorContentState, ActorStatus, ActorType, CampaignStatus, ContentStatus, ContentType, Prisma, type ContentDefinition,
} from '../../generated/prisma/client.js';
import { prisma } from '../../shared/database/prisma.js';
import { resolveBase, resolvePlayer, resolveScope, type DbClient } from '../../shared/database/game-scope.js';
import { ConflictError, NotFoundError } from '../../shared/errors/app-error.js';
import { normalizeEnum } from '../../shared/http/normalize-enum.js';
import { scopedActorKey } from '../actors/actors.repository.js';
import { findScopedContent } from '../content/content.repository.js';
import type {
  CreateEventInput, ListCampaignActorsInput, LoadGameInput, ManageActorContentInput,
  ListPlayerWorldsInput, ListWorldCampaignsInput, PatchActorInput, StartGameInput, UpsertActorInput, UpsertContentInput,
} from './gpt.schemas.js';
import type { ApiResult, GptRepository } from './gpt.types.js';
import {
  CAMPAIGN_STARTED_EVENT_MAX_BYTES, IDEMPOTENT_TRANSACTION_OPTIONS, canonicalJsonEqual, canonicalize, jsonByteSize, resolveDifficulty,
  type CampaignStartedPayload,
} from './gpt.start-game.js';
import { inspectIdempotencyRecord, isIdempotencyKeyConflict, isUniqueConflict } from './gpt.prisma-errors.js';

const actorSelect = {
  id: true, code: true, name: true, actorType: true, species: true, className: true, role: true,
  description: true, level: true, xp: true, gold: true, health: true, maxHealth: true, mana: true,
  maxMana: true, attributes: true, resistances: true, affinities: true, metadata: true, status: true,
  appearance: true, personality: true,
} satisfies Prisma.ActorSelect;

const contentInclude = { contentDefinition: true } satisfies Prisma.ActorContentInclude;

function requestHash(value: unknown): string {
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
  const hash = requestHash(request);
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

function actorDto(actor: Record<string, unknown>) {
  return {
    code: actor.code, name: actor.name, actorType: normalizeEnum(actor.actorType as string), species: actor.species,
    className: actor.className, role: actor.role, description: actor.description, level: actor.level, xp: actor.xp,
    gold: actor.gold, health: actor.health, maxHealth: actor.maxHealth, mana: actor.mana, maxMana: actor.maxMana,
    attributes: actor.attributes, resistances: actor.resistances, affinities: actor.affinities, metadata: actor.metadata,
    appearance: actor.appearance, personality: actor.personality,
    status: normalizeEnum(actor.status as string),
  };
}

function contentDto(content: Record<string, unknown>) {
  return {
    code: content.code, name: content.name, contentType: normalizeEnum(content.contentType as string),
    description: content.description, mechanics: content.mechanics, requirements: content.requirements,
    presentation: content.presentation, tags: content.tags, schemaVersion: content.schemaVersion,
    status: normalizeEnum(content.status as string), metadata: content.metadata,
  };
}

function actorContentDto(link: Record<string, unknown> & { contentDefinition: Record<string, unknown> }) {
  return {
    ...contentDto(link.contentDefinition), state: normalizeEnum(link.state as string), rank: link.rank,
    progress: link.progress, mastery: link.mastery, equipped: link.equipped, quantity: link.quantity,
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
  if ('name' in input) data.name = input.name;
  if ('actorType' in input) data.actorType = input.actorType.toUpperCase() as ActorType;
  if ('species' in input && input.species !== undefined) data.species = input.species;
  if ('className' in input && input.className !== undefined) data.className = input.className;
  if (input.role !== undefined) data.role = input.role;
  if (input.description !== undefined) data.description = input.description;
  if (input.level !== undefined) data.level = input.level;
  if (input.xp !== undefined) data.xp = input.xp;
  if (input.gold !== undefined) data.gold = input.gold;
  if (input.health !== undefined) data.health = input.health;
  if (input.maxHealth !== undefined) data.maxHealth = input.maxHealth;
  if (input.mana !== undefined) data.mana = input.mana;
  if (input.maxMana !== undefined) data.maxMana = input.maxMana;
  if (input.attributes !== undefined) data.attributes = inputJson(input.attributes);
  if (input.resistances !== undefined) data.resistances = inputJson(input.resistances);
  if (input.affinities !== undefined) data.affinities = inputJson(input.affinities);
  if (input.appearance !== undefined) data.appearance = inputJson(input.appearance);
  if (input.personality !== undefined) data.personality = inputJson(input.personality);
  if (input.metadata !== undefined) data.metadata = inputJson(input.metadata);
  if (input.status !== undefined) data.status = input.status.toUpperCase() as ActorStatus;
  return data;
}

function actorCreateData(
  campaignId: string,
  input: UpsertActorInput | StartGameInput['protagonist'],
): Prisma.ActorUncheckedCreateInput {
  const data: Prisma.ActorUncheckedCreateInput = {
    campaignId, code: input.code, name: input.name, actorType: input.actorType.toUpperCase() as ActorType,
    level: input.level ?? 1, xp: input.xp ?? 0, gold: input.gold ?? 0, health: input.health ?? 1,
    maxHealth: input.maxHealth ?? 1, mana: input.mana ?? 0, maxMana: input.maxMana ?? 0,
    attributes: inputJson(input.attributes ?? {}), resistances: inputJson(input.resistances ?? {}),
    affinities: inputJson(input.affinities ?? {}), appearance: inputJson(input.appearance ?? {}),
    personality: inputJson(input.personality ?? {}),
    metadata: inputJson({ ...(input.metadata ?? {}), ...('origin' in input && input.origin !== undefined ? { origin: input.origin } : {}) }),
    status: (input.status ?? 'active').toUpperCase() as ActorStatus,
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
  if (changes?.equipped !== undefined) data.equipped = changes.equipped;
  if (changes?.quantity !== undefined) data.quantity = changes.quantity;
  if (changes?.notes !== undefined) data.notes = changes.notes;
  if (changes?.metadata !== undefined) data.metadata = inputJson(changes.metadata);
  return data;
}

async function loadGameState(client: DbClient, input: LoadGameInput) {
  const { player, world, campaign } = await resolveScope(client, input);
  const [actors, links, events] = await Promise.all([
    client.actor.findMany({ where: { campaignId: campaign.id }, select: actorSelect, orderBy: [{ role: 'asc' }, { name: 'asc' }, { code: 'asc' }], take: 50 }),
    client.actorContent.findMany({ where: { actor: { campaignId: campaign.id } }, include: { ...contentInclude, actor: { select: { code: true } } }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: 100 }),
    client.gameEvent.findMany({ where: { campaignId: campaign.id }, include: { actor: { select: { code: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: 20 }),
  ]);
  const protagonist = actors.find((actor) => actor.code === player.slug && actor.actorType === ActorType.CHARACTER) ?? null;
  return {
    player: { ref: player.slug, displayName: player.displayName },
    world: { ref: world.code, name: world.name, description: world.description, metadata: world.metadata },
    campaign: { ref: campaign.code, name: campaign.name, status: normalizeEnum(campaign.status), currentTime: campaign.currentTime, metadata: campaign.metadata },
    protagonist: protagonist === null ? null : actorDto(protagonist),
    mainActors: actors.filter((actor) => actor.id !== protagonist?.id).map(actorDto),
    linkedContent: links.map((link) => ({ actorRef: link.actor.code, ...actorContentDto(link) })),
    recentEvents: events.map((event) => ({ actorRef: event.actor?.code ?? null, eventType: event.eventType, title: event.title, payload: event.payload, createdAt: event.createdAt.toISOString() })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertInitialEquipment(
  definition: { contentType: ContentType; mechanics: Prisma.JsonValue },
  link: StartGameInput['initialContentPackages'][number]['protagonistLink'],
) {
  if (link?.equipped !== true) return;
  const mechanics = isRecord(definition.mechanics) ? definition.mechanics : {};
  const behavior = mechanics.equipBehavior;
  const type = normalizeEnum(definition.contentType);
  const disallowed = type === 'race' || type === 'class'
    || (type === 'status_effect' && mechanics.permanence === 'permanent')
    || mechanics.passive === true || behavior === 'none';
  const allowed: Record<string, string[]> = {
    weapon: ['wieldable'], armor: ['wearable'], shield: ['wieldable', 'wearable'], item: ['readied', 'activatable'],
    spell: ['prepared', 'activatable'], talent: ['activatable'], skill: ['activatable'],
  };
  if (disallowed || typeof behavior !== 'string' || !(allowed[type]?.includes(behavior) ?? false)) throw new ConflictError('Initial equipment is incompatible with the content definition');
}

function assertPersistedRequirements(
  definition: { requirements: Prisma.JsonValue },
  link: StartGameInput['initialContentPackages'][number]['protagonistLink'],
  linkedKnown: Set<string>,
  attributes: Record<string, unknown>,
) {
  if (link === undefined || !['known', 'mastered'].includes(link.state) || !isRecord(definition.requirements)) return;
  const requiredContent = definition.requirements.requiredContent;
  if (Array.isArray(requiredContent)) {
    for (const required of requiredContent) {
      if (!isRecord(required) || typeof required.contentType !== 'string' || typeof required.code !== 'string'
        || !linkedKnown.has(`${required.contentType}:${required.code}`)) {
        throw new ConflictError('Initial content requirements are not met');
      }
    }
  }
  const minimumAttributes = definition.requirements.minimumAttributes;
  if (isRecord(minimumAttributes)) {
    for (const [attribute, minimum] of Object.entries(minimumAttributes)) {
      if (typeof minimum !== 'number' || typeof attributes[attribute] !== 'number' || attributes[attribute] < minimum) {
        throw new ConflictError('Initial attribute requirements are not met');
      }
    }
  }
}

function worldConfiguration(metadata: Prisma.JsonValue): unknown {
  return isRecord(metadata) ? metadata.worldConfig : undefined;
}

export const prismaGptRepository: GptRepository = {
  async loadGame(input: LoadGameInput) {
    return loadGameState(prisma, input);
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
      });
      if (input.worldMode === 'create' && existingWorld !== null) throw new ConflictError('World already exists');
      if (input.worldMode === 'reuse' && existingWorld === null) throw new NotFoundError('World');
      if (existingWorld !== null) {
        if (input.worldName !== undefined && existingWorld.name !== input.worldName) throw new ConflictError('World name does not match');
        if (input.worldDescription !== undefined && existingWorld.description !== input.worldDescription) throw new ConflictError('World description does not match');
        if (input.worldConfiguration !== undefined && !canonicalJsonEqual(worldConfiguration(existingWorld.metadata), input.worldConfiguration)) {
          throw new ConflictError('World configuration does not match');
        }
      }
      const world = existingWorld ?? await transaction.world.create({
        data: {
          playerId: player.id, code: input.worldRef, name: input.worldName ?? '',
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
          worldId: world.id, code: input.campaignRef, name: input.campaignName,
          status: CampaignStatus.ACTIVE, metadata: inputJson({ campaignConfig }),
        },
      });
      const protagonist = await transaction.actor.create({ data: actorCreateData(campaign.id, input.protagonist), select: actorSelect });

      const resolvedPackages: Array<{
        definition: ContentDefinition;
        link: StartGameInput['initialContentPackages'][number]['protagonistLink'];
        scope: 'world' | 'campaign';
      }> = [];
      for (const item of input.initialContentPackages) {
        const definitionInput = item.definition;
        const type = definitionInput.contentType.toUpperCase() as ContentType;
        if (definitionInput.mode === 'reuse') {
          const definition = await transaction.contentDefinition.findFirst({
            where: { worldId: world.id, campaignId: null, contentType: type, code: definitionInput.code },
          });
          if (definition === null) throw new NotFoundError('Content');
          resolvedPackages.push({ definition, link: item.protagonistLink, scope: definitionInput.scope });
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
        const definition = await transaction.contentDefinition.create({
          data: {
            worldId: world.id, campaignId, code: definitionInput.code, contentType: type,
            name: definitionInput.name ?? '', ...(definitionInput.description === undefined ? {} : { description: definitionInput.description }),
            mechanics: inputJson(definitionInput.mechanics ?? {}), requirements: inputJson(definitionInput.requirements ?? {}),
            presentation: inputJson(definitionInput.presentation ?? {}), tags: inputJson(definitionInput.tags ?? []),
            schemaVersion: definitionInput.schemaVersion ?? 1, status: ContentStatus.ACTIVE,
            metadata: inputJson(definitionInput.metadata ?? {}),
          },
        });
        resolvedPackages.push({ definition, link: item.protagonistLink, scope: definitionInput.scope });
      }

      const linkedKnown = new Set(resolvedPackages.filter((item) => ['known', 'mastered'].includes(item.link?.state ?? ''))
        .map((item) => `${normalizeEnum(item.definition.contentType)}:${item.definition.code}`));
      if (input.campaignConfiguration.classModel.mode === 'mechanical'
        && ['required', 'optional'].includes(input.campaignConfiguration.classModel.startingClass)) {
        const linkedClasses = resolvedPackages.filter((item) => item.definition.contentType === ContentType.CLASS && item.link !== undefined);
        if (linkedClasses.length === 1 && input.protagonist.className !== undefined && input.protagonist.className !== null
          && linkedClasses[0]?.definition.name !== input.protagonist.className) {
          throw new ConflictError('Mechanical class name does not match the persisted class definition');
        }
      }
      const attributes = isRecord(protagonist.attributes) ? protagonist.attributes : {};
      for (const item of resolvedPackages) {
        if (item.link === undefined) continue;
        assertInitialEquipment(item.definition, item.link);
        assertPersistedRequirements(item.definition, item.link, linkedKnown, attributes);
        await transaction.actorContent.create({
          data: {
            actorId: protagonist.id, contentDefinitionId: item.definition.id,
            state: item.link.state.toUpperCase() as ActorContentState, rank: item.link.rank, progress: item.link.progress,
            mastery: item.link.mastery, equipped: item.link.equipped, quantity: item.link.quantity,
            ...(item.link.notes === undefined ? {} : { notes: item.link.notes }), metadata: inputJson(item.link.metadata ?? {}),
          },
        });
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
          quantity: item.link?.quantity ?? 0, equipped: item.link?.equipped ?? false,
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
    return actors.map(actorDto);
  },

  async upsertActor(input: UpsertActorInput) {
    return executeIdempotent(input.idempotencyKey, 'actors.upsert', input, async (transaction) => {
      const { campaign } = await resolveScope(transaction, input);
      const actor = await transaction.actor.upsert({
        where: { campaignId_code: { campaignId: campaign.id, code: input.code } },
        update: actorUpdateData(input),
        create: actorCreateData(campaign.id, input),
        select: actorSelect,
      });
      return actorDto(actor);
    });
  },

  async patchActor(actorRef: string, input: PatchActorInput) {
    return executeIdempotent(input.idempotencyKey, 'actors.patch', { actorRef, ...input }, async (transaction) => {
      const { campaign } = await resolveScope(transaction, input);
      const actor = await findActor(transaction, campaign.id, actorRef);
      const updated = await transaction.actor.update({ where: { id: actor.id }, data: actorUpdateData(input), select: actorSelect });
      return actorDto(updated);
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
      const existing = await transaction.contentDefinition.findFirst({ where: { worldId: world.id, campaignId, contentType: type, code: input.code } });
      const data = {
        name: input.name, description: input.description, mechanics: inputJson(input.mechanics),
        requirements: inputJson(input.requirements), presentation: inputJson(input.presentation),
        tags: inputJson(input.tags), schemaVersion: input.schemaVersion, status: input.status.toUpperCase() as ContentStatus,
        metadata: inputJson(input.metadata ?? {}),
      };
      const content = existing === null
        ? await transaction.contentDefinition.create({ data: { worldId: world.id, campaignId, code: input.code, contentType: type, ...data } })
        : await transaction.contentDefinition.update({ where: { id: existing.id }, data });
      return contentDto(content);
    });
  },

  async manageActorContent(actorRef: string, input: ManageActorContentInput) {
    const read = async (client: DbClient) => {
      const { world, campaign } = await resolveScope(client, input);
      const actor = await findActor(client, campaign.id, actorRef);
      if (input.operation === 'list') {
        const links = await client.actorContent.findMany({
          where: { actorId: actor.id }, include: contentInclude,
          orderBy: [{ contentDefinition: { name: 'asc' } }, { contentDefinition: { contentType: 'asc' } }, { contentDefinition: { code: 'asc' } }],
        });
        return links.map(actorContentDto);
      }
      const definition = await findScopedContent(client, { worldId: world.id, campaignId: campaign.id }, input.contentRef ?? '', input.contentType ?? 'other');
      const link = await client.actorContent.findUnique({ where: { actorId_contentDefinitionId: { actorId: actor.id, contentDefinitionId: definition.id } }, include: contentInclude });
      if (input.operation === 'get') {
        if (link === null) throw new NotFoundError('Actor content');
        return actorContentDto(link);
      }
      return { actor, definition, link };
    };

    if (['get', 'list'].includes(input.operation)) return read(prisma);
    return executeIdempotent(input.idempotencyKey ?? '', `actorContent.${input.operation}`, { actorRef, ...input }, async (transaction) => {
      const resolved = await read(transaction);
      if (Array.isArray(resolved) || !('actor' in resolved)) throw new ConflictError();
      const { actor, definition, link } = resolved;
      if (input.operation === 'remove') {
        if (link === null) throw new NotFoundError('Actor content');
        await transaction.actorContent.delete({ where: { id: link.id } });
        return { actorRef: actor.code, contentRef: definition.code, removed: true };
      }
      if (['update', 'equip', 'unequip'].includes(input.operation) && link === null) throw new NotFoundError('Actor content');
      const changes = linkUpdateData(input);
      if (input.operation === 'equip') changes.equipped = true;
      if (input.operation === 'unequip') changes.equipped = false;
      const defaultState = input.operation === 'learn' ? ActorContentState.LEARNING : ActorContentState.KNOWN;
      const createData: Prisma.ActorContentUncheckedCreateInput = {
        actorId: actor.id, contentDefinitionId: definition.id,
        state: input.changes?.state?.toUpperCase() as ActorContentState | undefined ?? defaultState,
        rank: input.changes?.rank ?? (input.operation === 'grant' ? 1 : 0), progress: input.changes?.progress ?? 0,
        mastery: input.changes?.mastery ?? 0, equipped: input.changes?.equipped ?? false,
        quantity: input.changes?.quantity ?? 1, metadata: inputJson(input.changes?.metadata ?? {}),
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
};

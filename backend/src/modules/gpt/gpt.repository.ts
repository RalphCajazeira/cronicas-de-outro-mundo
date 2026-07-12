import { createHash } from 'node:crypto';
import {
  ActorContentState, ActorStatus, ActorType, CampaignStatus, ContentStatus, ContentType, Prisma,
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

const actorSelect = {
  id: true, code: true, name: true, actorType: true, species: true, className: true, role: true,
  description: true, level: true, xp: true, gold: true, health: true, maxHealth: true, mana: true,
  maxMana: true, attributes: true, resistances: true, affinities: true, metadata: true, status: true,
} satisfies Prisma.ActorSelect;

const contentInclude = { contentDefinition: true } satisfies Prisma.ActorContentInclude;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => {
      if (left < right) return -1;
      if (left > right) return 1;
      return 0;
    }).map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function inputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
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
    });
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    const persisted = await prisma.idempotencyRecord.findUnique({ where: { key } });
    if (persisted === null || persisted.operation !== operation || persisted.requestHash !== hash) throw new ConflictError('Idempotency key already used');
    return persisted.response as ApiResult;
  }
}

function actorDto(actor: Record<string, unknown>) {
  return {
    code: actor.code, name: actor.name, actorType: normalizeEnum(actor.actorType as string), species: actor.species,
    className: actor.className, role: actor.role, description: actor.description, level: actor.level, xp: actor.xp,
    gold: actor.gold, health: actor.health, maxHealth: actor.maxHealth, mana: actor.mana, maxMana: actor.maxMana,
    attributes: actor.attributes, resistances: actor.resistances, affinities: actor.affinities, metadata: actor.metadata,
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
    affinities: inputJson(input.affinities ?? {}), metadata: inputJson(input.metadata ?? {}),
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
      const player = await transaction.player.upsert({
        where: { slug: input.playerRef },
        update: { displayName: input.playerDisplayName },
        create: { slug: input.playerRef, displayName: input.playerDisplayName },
      });
      const world = await transaction.world.upsert({
        where: { playerId_code: { playerId: player.id, code: input.worldRef } },
        update: {
          name: input.worldName, metadata: inputJson(input.worldMetadata),
          ...(input.worldDescription === undefined ? {} : { description: input.worldDescription }),
        },
        create: {
          playerId: player.id, code: input.worldRef, name: input.worldName,
          metadata: inputJson(input.worldMetadata),
          ...(input.worldDescription === undefined ? {} : { description: input.worldDescription }),
        },
      });
      const existingCampaign = await transaction.campaign.findUnique({
        where: { worldId_code: { worldId: world.id, code: input.campaignRef } },
      });
      if (existingCampaign !== null) {
        const [actors, definitions, events] = await Promise.all([
          transaction.actor.count({ where: { campaignId: existingCampaign.id } }),
          transaction.contentDefinition.count({ where: { campaignId: existingCampaign.id } }),
          transaction.gameEvent.count({ where: { campaignId: existingCampaign.id } }),
        ]);
        if (actors + definitions + events > 0) throw new ConflictError('Campaign already contains state');
      }
      const campaign = existingCampaign === null
        ? await transaction.campaign.create({
          data: {
            worldId: world.id, code: input.campaignRef, name: input.campaignName,
            status: CampaignStatus.ACTIVE, metadata: inputJson(input.campaignMetadata),
          },
        })
        : await transaction.campaign.update({
          where: { id: existingCampaign.id },
          data: { name: input.campaignName, status: CampaignStatus.ACTIVE, currentTime: Prisma.DbNull, metadata: inputJson(input.campaignMetadata) },
        });
      await transaction.actor.create({ data: actorCreateData(campaign.id, input.protagonist) });
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

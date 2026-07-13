import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from './prisma.js';
import { NotFoundError } from '../errors/app-error.js';

export type DbClient = Prisma.TransactionClient | typeof prisma;

export interface PlayerReference {
  playerRef: string;
}

export interface WorldReference extends PlayerReference {
  worldRef: string;
}

export interface CampaignReference extends WorldReference {
  campaignRef: string;
}

export async function resolvePlayer(client: DbClient, refs: PlayerReference) {
  const player = await client.player.findUnique({ where: { slug: refs.playerRef } });
  if (player === null) throw new NotFoundError('Player');
  return player;
}

export async function resolveBase(client: DbClient, refs: WorldReference) {
  const player = await resolvePlayer(client, refs);
  const world = await client.world.findUnique({ where: { playerId_code: { playerId: player.id, code: refs.worldRef } } });
  if (world === null) throw new NotFoundError('World');
  return { player, world };
}

export async function resolveScope(client: DbClient, refs: CampaignReference) {
  const { player, world } = await resolveBase(client, refs);
  const campaign = await client.campaign.findUnique({ where: { worldId_code: { worldId: world.id, code: refs.campaignRef } } });
  if (campaign === null) throw new NotFoundError('Campaign');
  return { player, world, campaign };
}

import { z } from 'zod';

export const gameContextSchema = z.object({
  authState: z.enum(['DISCONNECTED', 'CONNECTED_FIXTURE']),
  player: z.object({
    displayName: z.string().min(1),
  }).strict().nullable(),
  resume: z.object({
    canContinue: z.boolean(),
    characterName: z.string().min(1),
    characterLevel: z.number().int().min(1),
    worldName: z.string().min(1),
    campaignName: z.string().min(1),
    campaignStatus: z.string().min(1),
    lastKnownStateLabel: z.string().min(1),
    activeSessionType: z.string().min(1),
    updatedAt: z.string().datetime(),
  }).strict().nullable(),
  capabilities: z.object({
    canStartNewGame: z.boolean(),
    canContinue: z.boolean(),
  }).strict(),
  environment: z.object({
    fixtureMode: z.boolean(),
    nonProduction: z.boolean(),
  }).strict(),
}).strict();

export type GameContext = z.infer<typeof gameContextSchema>;

export function parseGameContext(value: unknown): GameContext {
  return gameContextSchema.parse(value);
}

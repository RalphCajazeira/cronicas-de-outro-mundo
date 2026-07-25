import { z } from 'zod';

const playerSchema = z.object({
  displayName: z.string().min(1),
}).strict();

const resumeSchema = z.object({
  canContinue: z.boolean(),
  characterName: z.string().min(1),
  characterLevel: z.number().int().min(1),
  worldName: z.string().min(1),
  campaignName: z.string().min(1),
  campaignStatus: z.string().min(1),
  lastKnownStateLabel: z.string().min(1),
  activeSessionType: z.string().min(1),
  updatedAt: z.string().datetime(),
}).strict();

export const gameContextSchema = z.object({
  authState: z.enum(['DISCONNECTED', 'CONNECTED_FIXTURE']),
  player: playerSchema.nullable(),
  resume: resumeSchema.nullable(),
  capabilities: z.object({
    canStartNewGame: z.boolean(),
    canContinue: z.boolean(),
  }).strict(),
  environment: z.object({
    fixtureMode: z.boolean(),
    nonProduction: z.boolean(),
  }).strict(),
}).strict();

export type GameContextDto = z.infer<typeof gameContextSchema>;

export function disconnectedGameContext(fixtureMode: boolean, nonProduction: boolean): GameContextDto {
  return {
    authState: 'DISCONNECTED',
    player: null,
    resume: null,
    capabilities: {
      canStartNewGame: false,
      canContinue: false,
    },
    environment: {
      fixtureMode,
      nonProduction,
    },
  };
}

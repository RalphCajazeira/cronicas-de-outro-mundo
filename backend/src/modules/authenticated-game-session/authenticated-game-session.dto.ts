import { z } from 'zod';
import { authorizedSelectionRefSchema } from '../authenticated-game-context/authenticated-game-context.dto.js';

export const selectAuthenticatedGameContextInputSchema = z.object({
  campaignSelectionRef: authorizedSelectionRefSchema,
  characterSelectionRef: authorizedSelectionRefSchema,
  idempotencyKey: z.string().trim().min(8).max(200),
  baseSessionVersion: z.number().int().min(0).max(2_147_483_647),
}).strict();

const persistedSelectionSchema = z.object({
  campaignSelectionRef: authorizedSelectionRefSchema,
  characterSelectionRef: authorizedSelectionRefSchema,
}).strict();

export const authenticatedGameSessionSelectionResultSchema = z.object({
  status: z.enum(['SUCCESS', 'CONFLICT', 'SAFE_RETRY', 'REJECTED']),
  previousSessionVersion: z.number().int().min(0),
  sessionVersion: z.number().int().min(0),
  selection: persistedSelectionSchema.nullable(),
  canContinue: z.boolean(),
  recovery: z.enum(['NONE', 'RELOAD_REQUIRED', 'SAFE_RETRY', 'SELECT_AGAIN']),
  message: z.string().trim().min(1).max(200),
}).strict();

export type SelectAuthenticatedGameContextInput =
  z.infer<typeof selectAuthenticatedGameContextInputSchema>;
export type AuthenticatedGameSessionSelectionResult =
  z.infer<typeof authenticatedGameSessionSelectionResultSchema>;

import { z } from 'zod';
import { authorizedSelectionRefSchema } from '../authenticated-game-context/authenticated-game-context.dto.js';

const forbiddenMachineReferencePattern = /(?:^|[^\w-])(?:sel_|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:$|[^\w-])/iu;
const focusLengthLimit = 300;
const discoveredFactMaxLength = 240;
const discoveredFactLimit = 15;

export const selectAuthenticatedGameContextInputSchema = z.object({
  campaignSelectionRef: authorizedSelectionRefSchema,
  characterSelectionRef: authorizedSelectionRefSchema,
  idempotencyKey: z.string().trim().min(8).max(200),
  baseSessionVersion: z.number().int().min(0).max(2_147_483_647),
}).strict();

export const performAuthenticatedObservationInputSchema = z.object({
  focus: z.string()
    .trim()
    .transform((value) => (value.length === 0 ? undefined : value))
    .refine((value) => value === undefined || value.length <= focusLengthLimit, {
      message: 'Focus too long.',
    })
    .refine((value) => value === undefined || !forbiddenMachineReferencePattern.test(value), {
      message: 'Focus cannot contain machine references.',
    })
    .optional(),
  idempotencyKey: z.string().trim().min(8).max(200),
  baseSessionVersion: z.number().int().min(0).max(2_147_483_647),
}).strict();

export const observedActionSchema = z.object({
  type: z.literal('OBSERVE'),
  status: z.enum(['RESOLVED', 'CONFLICT', 'BLOCKED', 'REJECTED']),
  summary: z.string().trim().min(1).max(500),
  focus: z.string().max(focusLengthLimit).nullable(),
  occurredAt: z.string().datetime(),
}).strict();

export const observedActionReferenceSchema = observedActionSchema.extend({
  discoveredFacts: z.array(z.string().trim().min(1).max(discoveredFactMaxLength)).max(discoveredFactLimit),
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

export const authenticatedObservationResultSchema = z.object({
  action: observedActionSchema,
  continuity: z.object({
    sessionVersion: z.number().int().min(0),
    canContinue: z.boolean(),
  }).strict(),
  discoveredFacts: z.array(z.string().trim().min(1).max(discoveredFactMaxLength)).max(discoveredFactLimit),
}).strict();

export type SelectAuthenticatedGameContextInput =
  z.infer<typeof selectAuthenticatedGameContextInputSchema>;
export type AuthenticatedGameSessionSelectionResult =
  z.infer<typeof authenticatedGameSessionSelectionResultSchema>;
export type ObservedAction = z.infer<typeof observedActionSchema>;
export type AuthenticatedObservationActionReference = z.infer<typeof observedActionReferenceSchema>;
export type PerformAuthenticatedObservationInput =
  z.infer<typeof performAuthenticatedObservationInputSchema>;
export type AuthenticatedObservationResult =
  z.infer<typeof authenticatedObservationResultSchema>;

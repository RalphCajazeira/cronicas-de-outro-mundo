import { z } from 'zod';

export const codeSchema = z.string().trim().min(1).max(100).regex(
  /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/,
  'Reference must be a code',
).refine((value) => !z.string().uuid().safeParse(value).success, 'Reference must not be an internal UUID');

export const actorRefSchema = codeSchema;

export const gameScopeSchema = z.strictObject({
  playerRef: codeSchema,
  worldRef: codeSchema,
  campaignRef: codeSchema,
});

export type GameScopeInput = z.infer<typeof gameScopeSchema>;

import { z } from 'zod';

export const actorRefSchema = z.string().trim().min(1).max(100).refine(
  (value) => z.string().uuid().safeParse(value).success || /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(value),
  'Actor reference must be a UUID or code',
);

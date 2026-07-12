import { z } from 'zod';
import { actorRefSchema, gameScopeSchema } from '../actors/actors.schemas.js';

export const contentRefSchema = actorRefSchema;

export const contentTypeSchema = z.enum([
  'skill', 'spell', 'weapon', 'armor', 'shield', 'item', 'talent', 'material', 'class', 'race',
  'location', 'faction', 'quest_template', 'status_effect', 'recipe', 'creature_template', 'other',
]);

export const getContentSchema = gameScopeSchema.extend({ contentType: contentTypeSchema });

export type GetContentInput = z.infer<typeof getContentSchema>;

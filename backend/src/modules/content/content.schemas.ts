import { z } from 'zod';
import { actorRefSchema, gameScopeSchema } from '../actors/actors.schemas.js';
import { canonicalJson } from '../../shared/json/canonical-json.js';
import {
  validateCoreV1ContentProfile,
  type CoreV1ContentProfile,
} from '../rules/core-v1/index.js';
import { CANONICAL_CONTENT_TYPES, GENERIC_CONTENT_TYPES } from './content-publication.service.js';

export const contentRefSchema = actorRefSchema;

export const contentTypeSchema = z.enum([
  'skill', 'spell', 'weapon', 'armor', 'shield', 'clothing', 'item', 'consumable', 'talent', 'material', 'class', 'race',
  'location', 'faction', 'quest_template', 'status_effect', 'recipe', 'creature_template', 'other',
]);

export const contentPresentationSchema = z.strictObject({
  summary: z.string().trim().min(1).max(1_000).optional(),
  appearance: z.string().trim().min(1).max(2_000).optional(),
  sensory: z.string().trim().min(1).max(1_000).optional(),
});

export const contentTagsSchema = z.array(z.string().trim().min(1).max(100)).max(24).superRefine((tags, context) => {
  const seen = new Set<string>();
  tags.forEach((tag, index) => {
    if (seen.has(tag)) context.addIssue({ code: 'custom', path: [index], message: 'Duplicate tags are not allowed' });
    seen.add(tag);
  });
});

export const coreV1ContentProfileSchema: z.ZodType<CoreV1ContentProfile> = z.unknown().transform((value, context) => {
  const validation = validateCoreV1ContentProfile(value);
  if (validation.ok) return validation.value;
  validation.issues.forEach((issue) => {
    const path = issue.path === '$' ? [] : issue.path.split('.');
    context.addIssue({ code: 'custom', path, message: issue.message });
  });
  return z.NEVER;
});

export interface ContentPublicationShape {
  contentType: z.infer<typeof contentTypeSchema>;
  code: string;
  name: string;
  description: string;
  profile?: CoreV1ContentProfile | null | undefined;
  presentation: z.infer<typeof contentPresentationSchema>;
  tags: string[];
}

export function validateContentPublicationShape(value: ContentPublicationShape, context: z.RefinementCtx): void {
  const canonical = (CANONICAL_CONTENT_TYPES as readonly string[]).includes(value.contentType);
  const generic = (GENERIC_CONTENT_TYPES as readonly string[]).includes(value.contentType);
  if (canonical && (value.profile === undefined || value.profile === null)) {
    context.addIssue({ code: 'custom', path: ['profile'], message: 'Canonical content requires a core-v1 profile' });
    return;
  }
  if (generic && value.profile !== undefined && value.profile !== null) {
    context.addIssue({ code: 'custom', path: ['profile'], message: 'Generic narrative content cannot contain a mechanical profile' });
    return;
  }
  if (!canonical || value.profile === undefined || value.profile === null) return;
  const comparisons: Array<[boolean, (string | number)[], string]> = [
    [value.profile.contentKind === value.contentType, ['profile', 'contentKind'], 'Must match contentType'],
    [value.profile.code === value.code, ['profile', 'code'], 'Must match code'],
    [value.profile.name === value.name, ['profile', 'name'], 'Must match name'],
    [value.profile.description === undefined || value.profile.description === value.description, ['profile', 'description'], 'Must match description when present'],
    [value.profile.presentation === undefined || canonicalJson(value.profile.presentation) === canonicalJson(value.presentation), ['profile', 'presentation'], 'Must match presentation when present'],
    [value.profile.tags === undefined || canonicalJson(value.profile.tags) === canonicalJson(value.tags), ['profile', 'tags'], 'Must match tags when present'],
  ];
  comparisons.forEach(([matches, path, message]) => {
    if (!matches) context.addIssue({ code: 'custom', path, message });
  });
}

export const getContentSchema = gameScopeSchema.extend({ contentType: contentTypeSchema });

export type GetContentInput = z.infer<typeof getContentSchema>;

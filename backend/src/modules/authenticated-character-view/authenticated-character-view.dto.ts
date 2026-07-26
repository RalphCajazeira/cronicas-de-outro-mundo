import { z } from 'zod';
import { authorizedSelectionRefSchema } from '../authenticated-game-context/authenticated-game-context.dto.js';

export const authenticatedCharacterViewNameSchema = z.enum([
  'SUMMARY',
  'SHEET',
  'INVENTORY',
  'EQUIPMENT',
  'ABILITIES',
]);

export const authenticatedCharacterCursorSchema = z.string()
  .regex(/^cur_[A-Za-z0-9_-]{43}$/u);

const resourceSchema = z.object({
  code: z.enum(['hp', 'mana', 'sp']),
  current: z.number().int().min(0),
  maximum: z.number().int().min(1),
}).strict();

const identitySchema = z.object({
  name: z.string().trim().min(1).max(200),
  species: z.string().trim().min(1).max(100).nullable(),
  className: z.string().trim().min(1).max(100).nullable(),
  role: z.string().trim().min(1).max(100).nullable(),
  description: z.string().trim().min(1).max(500).nullable(),
  level: z.number().int().min(1),
  status: z.string().trim().min(1).max(50),
  campaignName: z.string().trim().min(1).max(200),
  worldName: z.string().trim().min(1).max(200),
}).strict();

const unavailableSchema = z.object({
  code: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(120),
  reason: z.literal('NOT_PERSISTED_IN_CURRENT_VERSION'),
}).strict();

const statusEffectSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(300).nullable(),
  stacks: z.number().int().min(1),
  duration: z.string().trim().min(1).max(100),
}).strict();

export const characterSummaryViewSchema = z.object({
  identity: identitySchema,
  resources: z.array(resourceSchema).max(3),
  activeStatusCount: z.number().int().min(0),
  continuitySummary: z.string().trim().min(1).max(500),
  availableViews: z.array(authenticatedCharacterViewNameSchema).length(5),
}).strict();

const attributeSchema = z.object({
  code: z.string().trim().min(1).max(50),
  label: z.string().trim().min(1).max(80),
  base: z.number().int(),
  progression: z.number().int(),
  effective: z.number().int(),
  xp: z.number().int().min(0),
}).strict();

const secondarySchema = z.object({
  code: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(120),
  value: z.number().int(),
  unit: z.enum(['POINTS', 'BASIS_POINTS']),
}).strict();

export const characterSheetViewSchema = z.object({
  identity: identitySchema,
  attributes: z.array(attributeSchema).max(20),
  resources: z.array(resourceSchema).max(3),
  progression: z.object({
    level: z.number().int().min(1),
    xp: z.number().int().min(0),
  }).strict(),
  secondaryAttributes: z.array(secondarySchema).max(30),
  activeStatusEffects: z.array(statusEffectSchema).max(50),
  ruleset: z.object({
    code: z.string().trim().min(1).max(100),
    revision: z.string().trim().min(1).max(100),
  }).strict(),
  unavailable: z.array(unavailableSchema).max(20),
}).strict();

const inventoryItemSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(300).nullable(),
  category: z.string().trim().min(1).max(80),
  quantity: z.number().int().min(1),
  unitWeight: z.number().min(0),
  totalWeight: z.number().min(0),
  stackable: z.boolean(),
  equipable: z.boolean(),
  consumable: z.boolean(),
  equipped: z.boolean(),
  equippedSlots: z.array(z.string().trim().min(1).max(50)).max(10),
  state: z.string().trim().min(1).max(50),
}).strict();

const pageSchema = z.object({
  nextCursor: authenticatedCharacterCursorSchema.nullable(),
  itemCount: z.number().int().min(0),
  pageSize: z.number().int().min(1).max(20),
}).strict();

export const inventoryViewSchema = z.object({
  currency: z.object({
    code: z.literal('gold'),
    label: z.literal('Ouro'),
    amount: z.number().int().min(0),
  }).strict(),
  weight: z.object({
    carried: z.number().min(0),
    capacity: z.number().int().min(0),
    state: z.string().trim().min(1).max(50),
  }).strict(),
  items: z.array(inventoryItemSchema).max(20),
  page: pageSchema,
  unavailable: z.array(unavailableSchema).max(20),
}).strict();

const publicModifierSchema = z.object({
  label: z.string().trim().min(1).max(120),
  amount: z.number().int(),
}).strict();

const publicActionSchema = z.object({
  activation: z.string().trim().min(1).max(80),
  actionProfile: z.string().trim().min(1).max(100).nullable(),
  cost: z.string().trim().min(1).max(160),
  targeting: z.string().trim().min(1).max(160),
  effects: z.array(z.string().trim().min(1).max(200)).max(20),
}).strict();

const equipmentItemSchema = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(300).nullable(),
  bonuses: z.array(publicModifierSchema).max(30),
  requirements: z.array(z.string().trim().min(1).max(160)).max(30),
  action: publicActionSchema.nullable(),
}).strict();

export const equipmentViewSchema = z.object({
  slots: z.array(z.object({
    code: z.string().trim().min(1).max(50),
    label: z.string().trim().min(1).max(80),
    item: equipmentItemSchema.nullable(),
  }).strict()).length(10),
  readOnlyNotice: z.literal('Equipamento somente para consulta.'),
  unavailable: z.array(unavailableSchema).max(20),
}).strict();

const abilitySchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(300).nullable(),
  category: z.enum(['SKILL', 'SPELL', 'TALENT', 'PASSIVE']),
  state: z.enum(['LEARNING', 'KNOWN', 'MASTERED']),
  rank: z.number().int().min(0),
  progress: z.number().int().min(0),
  mastery: z.number().int().min(0),
  version: z.number().int().min(1),
  action: publicActionSchema,
  bonuses: z.array(publicModifierSchema).max(30),
}).strict();

export const abilitiesViewSchema = z.object({
  abilities: z.array(abilitySchema).max(20),
  page: pageSchema,
  unavailable: z.array(unavailableSchema).max(20),
}).strict();

export const loadAuthenticatedCharacterViewInputSchema = z.object({
  view: authenticatedCharacterViewNameSchema,
  campaignSelectionRef: authorizedSelectionRefSchema.optional(),
  characterSelectionRef: authorizedSelectionRefSchema.optional(),
  cursor: authenticatedCharacterCursorSchema.optional(),
}).strict();

const outputBase = {
  readOnly: z.literal(true),
} as const;

export const authenticatedCharacterViewSchema = z.discriminatedUnion('view', [
  z.object({ ...outputBase, view: z.literal('SUMMARY'), data: characterSummaryViewSchema }).strict(),
  z.object({ ...outputBase, view: z.literal('SHEET'), data: characterSheetViewSchema }).strict(),
  z.object({ ...outputBase, view: z.literal('INVENTORY'), data: inventoryViewSchema }).strict(),
  z.object({ ...outputBase, view: z.literal('EQUIPMENT'), data: equipmentViewSchema }).strict(),
  z.object({ ...outputBase, view: z.literal('ABILITIES'), data: abilitiesViewSchema }).strict(),
]);

// The MCP SDK currently requires a top-level object schema when it derives JSON
// Schema for a tool. The service still validates the stronger discriminated union.
export const authenticatedCharacterViewToolOutputSchema = z.object({
  view: authenticatedCharacterViewNameSchema,
  readOnly: z.literal(true),
  data: z.union([
    characterSummaryViewSchema,
    characterSheetViewSchema,
    inventoryViewSchema,
    equipmentViewSchema,
    abilitiesViewSchema,
  ]),
}).strict();

export type AuthenticatedCharacterViewName = z.infer<typeof authenticatedCharacterViewNameSchema>;
export type LoadAuthenticatedCharacterViewInput = z.infer<typeof loadAuthenticatedCharacterViewInputSchema>;
export type AuthenticatedCharacterViewDto = z.infer<typeof authenticatedCharacterViewSchema>;
export type CharacterSummaryView = z.infer<typeof characterSummaryViewSchema>;
export type CharacterSheetView = z.infer<typeof characterSheetViewSchema>;
export type InventoryView = z.infer<typeof inventoryViewSchema>;
export type EquipmentView = z.infer<typeof equipmentViewSchema>;
export type AbilitiesView = z.infer<typeof abilitiesViewSchema>;

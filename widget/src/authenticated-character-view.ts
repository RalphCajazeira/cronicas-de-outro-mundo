import { z } from 'zod';

export const authenticatedViewNameSchema = z.enum([
  'SUMMARY',
  'SHEET',
  'INVENTORY',
  'EQUIPMENT',
  'ABILITIES',
]);

const identitySchema = z.object({
  name: z.string().min(1).max(200),
  species: z.string().min(1).max(100).nullable(),
  className: z.string().min(1).max(100).nullable(),
  role: z.string().min(1).max(100).nullable(),
  description: z.string().min(1).max(500).nullable(),
  level: z.number().int().min(1),
  status: z.string().min(1).max(50),
  campaignName: z.string().min(1).max(200),
  worldName: z.string().min(1).max(200),
}).strict();

const resourceSchema = z.object({
  code: z.enum(['hp', 'mana', 'sp']),
  current: z.number().int().min(0),
  maximum: z.number().int().min(1),
}).strict();

const unavailableSchema = z.object({
  code: z.string().min(1).max(80),
  label: z.string().min(1).max(120),
  reason: z.literal('NOT_PERSISTED_IN_CURRENT_VERSION'),
}).strict();

const modifierSchema = z.object({
  label: z.string().min(1).max(120),
  amount: z.number().int(),
}).strict();

const actionSchema = z.object({
  activation: z.string().min(1).max(80),
  actionProfile: z.string().min(1).max(100).nullable(),
  cost: z.string().min(1).max(160),
  targeting: z.string().min(1).max(160),
  effects: z.array(z.string().min(1).max(200)).max(20),
}).strict();

const pageSchema = z.object({
  nextCursor: z.string().regex(/^cur_[A-Za-z0-9_-]{43}$/u).nullable(),
  itemCount: z.number().int().min(0),
  pageSize: z.number().int().min(1).max(20),
}).strict();

const summarySchema = z.object({
  identity: identitySchema,
  resources: z.array(resourceSchema).max(3),
  activeStatusCount: z.number().int().min(0),
  continuitySummary: z.string().min(1).max(500),
  availableViews: z.array(authenticatedViewNameSchema).length(5),
}).strict();

const sheetSchema = z.object({
  identity: identitySchema,
  attributes: z.array(z.object({
    code: z.string().min(1).max(50),
    label: z.string().min(1).max(80),
    base: z.number().int(),
    progression: z.number().int(),
    effective: z.number().int(),
    xp: z.number().int().min(0),
  }).strict()).max(20),
  resources: z.array(resourceSchema).max(3),
  progression: z.object({
    level: z.number().int().min(1),
    xp: z.number().int().min(0),
  }).strict(),
  secondaryAttributes: z.array(z.object({
    code: z.string().min(1).max(80),
    label: z.string().min(1).max(120),
    value: z.number().int(),
    unit: z.enum(['POINTS', 'BASIS_POINTS']),
  }).strict()).max(30),
  activeStatusEffects: z.array(z.object({
    name: z.string().min(1).max(200),
    description: z.string().min(1).max(300).nullable(),
    stacks: z.number().int().min(1),
    duration: z.string().min(1).max(100),
  }).strict()).max(50),
  ruleset: z.object({
    code: z.string().min(1).max(100),
    revision: z.string().min(1).max(100),
  }).strict(),
  unavailable: z.array(unavailableSchema).max(20),
}).strict();

const inventorySchema = z.object({
  currency: z.object({
    code: z.literal('gold'),
    label: z.literal('Ouro'),
    amount: z.number().int().min(0),
  }).strict(),
  weight: z.object({
    carried: z.number().min(0),
    capacity: z.number().int().min(0),
    state: z.string().min(1).max(50),
  }).strict(),
  items: z.array(z.object({
    name: z.string().min(1).max(200),
    description: z.string().min(1).max(300).nullable(),
    category: z.string().min(1).max(80),
    quantity: z.number().int().min(1),
    unitWeight: z.number().min(0),
    totalWeight: z.number().min(0),
    stackable: z.boolean(),
    equipable: z.boolean(),
    consumable: z.boolean(),
    equipped: z.boolean(),
    equippedSlots: z.array(z.string().min(1).max(50)).max(10),
    state: z.string().min(1).max(50),
  }).strict()).max(20),
  page: pageSchema,
  unavailable: z.array(unavailableSchema).max(20),
}).strict();

const equipmentItemSchema = z.object({
  name: z.string().min(1).max(200),
  category: z.string().min(1).max(80),
  description: z.string().min(1).max(300).nullable(),
  bonuses: z.array(modifierSchema).max(30),
  requirements: z.array(z.string().min(1).max(160)).max(30),
  action: actionSchema.nullable(),
}).strict();

const equipmentSchema = z.object({
  slots: z.array(z.object({
    code: z.string().min(1).max(50),
    label: z.string().min(1).max(80),
    item: equipmentItemSchema.nullable(),
  }).strict()).length(10),
  readOnlyNotice: z.literal('Equipamento somente para consulta.'),
  unavailable: z.array(unavailableSchema).max(20),
}).strict();

const abilitiesSchema = z.object({
  abilities: z.array(z.object({
    name: z.string().min(1).max(200),
    description: z.string().min(1).max(300).nullable(),
    category: z.enum(['SKILL', 'SPELL', 'TALENT', 'PASSIVE']),
    state: z.enum(['LEARNING', 'KNOWN', 'MASTERED']),
    rank: z.number().int().min(0),
    progress: z.number().int().min(0),
    mastery: z.number().int().min(0),
    version: z.number().int().min(1),
    action: actionSchema,
    bonuses: z.array(modifierSchema).max(30),
  }).strict()).max(20),
  page: pageSchema,
  unavailable: z.array(unavailableSchema).max(20),
}).strict();

export const authenticatedCharacterViewSchema = z.discriminatedUnion('view', [
  z.object({ view: z.literal('SUMMARY'), readOnly: z.literal(true), data: summarySchema }).strict(),
  z.object({ view: z.literal('SHEET'), readOnly: z.literal(true), data: sheetSchema }).strict(),
  z.object({ view: z.literal('INVENTORY'), readOnly: z.literal(true), data: inventorySchema }).strict(),
  z.object({ view: z.literal('EQUIPMENT'), readOnly: z.literal(true), data: equipmentSchema }).strict(),
  z.object({ view: z.literal('ABILITIES'), readOnly: z.literal(true), data: abilitiesSchema }).strict(),
]);

export type AuthenticatedViewName = z.infer<typeof authenticatedViewNameSchema>;
export type AuthenticatedCharacterView = z.infer<typeof authenticatedCharacterViewSchema>;

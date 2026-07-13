import { describe, expect, it } from 'vitest';
import { getContentSchema } from '../content/content.schemas.js';
import {
  createEventSchema, listCampaignActorsSchema, loadGameSchema, manageActorContentSchema, patchActorSchema,
  startGameSchema, upsertActorSchema, upsertContentSchema,
} from './gpt.schemas.js';

describe('GPT API schemas', () => {
  const scope = { playerRef: 'ralph', worldRef: 'mundo-cardinal', campaignRef: 'harem-perfeito' };

  it('requires explicit scope and accepts normalized enums', () => {
    const actor = upsertActorSchema.parse({ ...scope, idempotencyKey: 'actor-schema-001', code: 'lyra', name: 'Lyra', actorType: 'spirit', status: 'active' });
    expect(actor).toMatchObject({ ...scope, actorType: 'spirit', status: 'active' });
    expect(upsertActorSchema.safeParse({ idempotencyKey: 'actor-schema-002', code: 'lyra', name: 'Lyra', actorType: 'spirit' }).success).toBe(false);
  });

  it('rejects every scoped operation when any scope ref is absent', () => {
    const scopedInputs = [
      [loadGameSchema, scope],
      [listCampaignActorsSchema, scope],
      [getContentSchema, { ...scope, contentType: 'skill' }],
      [startGameSchema, { ...scope, idempotencyKey: 'start-scope-001', playerDisplayName: 'Ralph', worldName: 'Mundo', campaignName: 'Campanha', protagonist: { code: 'ralph', name: 'Ralph', actorType: 'character' } }],
      [upsertActorSchema, { ...scope, idempotencyKey: 'actor-scope-001', code: 'lyra', name: 'Lyra', actorType: 'spirit' }],
      [patchActorSchema, { ...scope, idempotencyKey: 'patch-scope-001', health: 10 }],
      [upsertContentSchema, { ...scope, idempotencyKey: 'content-scope-001', contentType: 'skill', code: 'step', name: 'Step', description: 'Movement.', mechanics: {}, requirements: {}, presentation: {}, tags: [], schemaVersion: 1, status: 'active' }],
      [manageActorContentSchema, { ...scope, operation: 'list' }],
      [createEventSchema, { ...scope, eventType: 'scene', title: 'Scene', payload: {}, idempotencyKey: 'event-scope-001' }],
    ] as const;

    for (const [schema, input] of scopedInputs) {
      expect(schema.safeParse(input).success).toBe(true);
      expect(schema.safeParse({ ...input, playerRef: undefined }).success).toBe(false);
      expect(schema.safeParse({ ...input, worldRef: undefined }).success).toBe(false);
      expect(schema.safeParse({ ...input, campaignRef: undefined }).success).toBe(false);
    }
    expect(getContentSchema.safeParse(scope).success).toBe(false);
  });

  it('accepts a complete new-game scope and requires protagonist code to match the player', () => {
    const input = {
      ...scope, idempotencyKey: 'start-game-schema-001', playerDisplayName: 'Ralph', worldName: 'Elarion', campaignName: 'Campanha Principal',
      protagonist: { code: 'ralph', name: 'Ralph', actorType: 'character', health: 20, maxHealth: 20, mana: 10, maxMana: 10 },
    };
    expect(startGameSchema.parse(input)).toMatchObject(scope);
    expect(startGameSchema.safeParse({ ...input, protagonist: { ...input.protagonist, code: 'other' } }).success).toBe(false);
  });

  it('allows only approved actor patch fields', () => {
    expect(patchActorSchema.safeParse({ ...scope, idempotencyKey: 'actor-patch-001', health: 10, metadata: { mood: 'calm' } }).success).toBe(true);
    expect(patchActorSchema.safeParse({ ...scope, idempotencyKey: 'actor-patch-002', id: 'forbidden' }).success).toBe(false);
    expect(patchActorSchema.safeParse({ ...scope, idempotencyKey: 'actor-patch-003', campaignId: 'forbidden' }).success).toBe(false);
  });

  it('requires a complete explicit content definition', () => {
    const base = { ...scope, idempotencyKey: 'content-schema-001', contentType: 'skill', code: 'quiet-step', name: 'Passo Silencioso', description: 'Movimento discreto.', mechanics: {}, requirements: {}, presentation: {}, tags: [], schemaVersion: 1, status: 'active' };
    expect(upsertContentSchema.safeParse(base).success).toBe(true);
    const { mechanics: _mechanics, ...incomplete } = base;
    void _mechanics;
    expect(upsertContentSchema.safeParse(incomplete).success).toBe(false);
  });

  it('requires idempotency only for actor-content writes', () => {
    expect(manageActorContentSchema.safeParse({ ...scope, operation: 'list' }).success).toBe(true);
    expect(manageActorContentSchema.safeParse({ ...scope, operation: 'get', contentRef: 'quiet-step', contentType: 'skill' }).success).toBe(true);
    expect(manageActorContentSchema.safeParse({ ...scope, operation: 'learn', contentRef: 'quiet-step', contentType: 'skill' }).success).toBe(false);
    expect(manageActorContentSchema.safeParse({ ...scope, operation: 'learn', contentRef: 'quiet-step', contentType: 'skill', idempotencyKey: 'learn-schema-001' }).success).toBe(true);
  });
});

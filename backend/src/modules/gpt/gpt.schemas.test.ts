import { describe, expect, it } from 'vitest';
import { manageActorContentSchema, patchActorSchema, startGameSchema, upsertActorSchema, upsertContentSchema } from './gpt.schemas.js';

describe('GPT API schemas', () => {
  it('applies stable scope defaults and accepts normalized enums', () => {
    const actor = upsertActorSchema.parse({ idempotencyKey: 'actor-schema-001', code: 'lyra', name: 'Lyra', actorType: 'spirit', status: 'active' });
    expect(actor).toMatchObject({ playerRef: 'ralph', worldRef: 'elarion', campaignRef: 'main-campaign', actorType: 'spirit', status: 'active' });
  });

  it('accepts a complete new-game scope and requires protagonist code to match the player', () => {
    const input = {
      idempotencyKey: 'start-game-schema-001', playerDisplayName: 'Ralph', worldName: 'Elarion', campaignName: 'Campanha Principal',
      protagonist: { code: 'ralph', name: 'Ralph', actorType: 'character', health: 20, maxHealth: 20, mana: 10, maxMana: 10 },
    };
    expect(startGameSchema.parse(input)).toMatchObject({ playerRef: 'ralph', worldRef: 'elarion', campaignRef: 'main-campaign' });
    expect(startGameSchema.safeParse({ ...input, protagonist: { ...input.protagonist, code: 'other' } }).success).toBe(false);
  });

  it('allows only approved actor patch fields', () => {
    expect(patchActorSchema.safeParse({ idempotencyKey: 'actor-patch-001', health: 10, metadata: { mood: 'calm' } }).success).toBe(true);
    expect(patchActorSchema.safeParse({ idempotencyKey: 'actor-patch-002', id: 'forbidden' }).success).toBe(false);
    expect(patchActorSchema.safeParse({ idempotencyKey: 'actor-patch-003', campaignId: 'forbidden' }).success).toBe(false);
  });

  it('requires a complete explicit content definition', () => {
    const base = { idempotencyKey: 'content-schema-001', contentType: 'skill', code: 'quiet-step', name: 'Passo Silencioso', description: 'Movimento discreto.', mechanics: {}, requirements: {}, presentation: {}, tags: [], schemaVersion: 1, status: 'active' };
    expect(upsertContentSchema.safeParse(base).success).toBe(true);
    const { mechanics: _mechanics, ...incomplete } = base;
    void _mechanics;
    expect(upsertContentSchema.safeParse(incomplete).success).toBe(false);
  });

  it('requires idempotency only for actor-content writes', () => {
    expect(manageActorContentSchema.safeParse({ operation: 'list' }).success).toBe(true);
    expect(manageActorContentSchema.safeParse({ operation: 'get', contentRef: 'quiet-step', contentType: 'skill' }).success).toBe(true);
    expect(manageActorContentSchema.safeParse({ operation: 'learn', contentRef: 'quiet-step', contentType: 'skill' }).success).toBe(false);
    expect(manageActorContentSchema.safeParse({ operation: 'learn', contentRef: 'quiet-step', contentType: 'skill', idempotencyKey: 'learn-schema-001' }).success).toBe(true);
  });
});

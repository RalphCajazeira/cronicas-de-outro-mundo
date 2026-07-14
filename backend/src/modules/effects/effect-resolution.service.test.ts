import { describe, expect, it } from 'vitest';
import { calculateEffectResolutionResultHash, createDeterministicEffectRef } from './effect-resolution.primitives.js';

describe('effect resolution public primitives', () => {
  const content = { scope: 'campaign' as const, contentType: 'spell' as const, code: 'arcane-mark', versionNumber: 1 };

  it('creates stable public effect refs without UUIDs or persistence IDs', () => {
    const ref = createDeterministicEffectRef('lyra', content, 0);
    expect(ref).toMatch(/^fx_[0-9a-f]{32}$/);
    expect(createDeterministicEffectRef('lyra', { ...content }, 0)).toBe(ref);
    expect(createDeterministicEffectRef('lyra', content, 1)).not.toBe(ref);
    expect(ref).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27}/i);
  });

  it('hashes canonical public results independent of object key order', () => {
    const left = { operation: 'execute_content', source: { actorRef: 'ralph', resources: ['mana'] } };
    const right = { source: { resources: ['mana'], actorRef: 'ralph' }, operation: 'execute_content' };
    expect(calculateEffectResolutionResultHash(left)).toBe(calculateEffectResolutionResultHash(right));
    expect(calculateEffectResolutionResultHash({ ...left, operation: 'use_consumable' })).not.toBe(calculateEffectResolutionResultHash(left));
  });
});

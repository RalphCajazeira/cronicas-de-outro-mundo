import { describe, expect, it } from 'vitest';
import { actorRefSchema } from './actors.schemas.js';

describe('actor reference schema', () => {
  it('accepts a code', () => expect(actorRefSchema.parse('wind_breeze-step')).toBe('wind_breeze-step'));
  it('accepts a UUID', () => expect(actorRefSchema.parse('7e7b7cbe-5767-47de-a0b5-4b7bc9365c89')).toBe('7e7b7cbe-5767-47de-a0b5-4b7bc9365c89'));
  it.each(['not valid', 'UPPERCASE', '', '../ralph'])('rejects an invalid reference %s', (reference) => {
    expect(actorRefSchema.safeParse(reference).success).toBe(false);
  });
});

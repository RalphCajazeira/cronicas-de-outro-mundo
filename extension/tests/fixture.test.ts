import { describe, expect, it } from 'vitest';
import { DEMO_CHARACTER } from '../src/shared/fixture.js';

describe('local demo fixture', () => {
  it('contains only the bounded local visual data required by the shell', () => {
    expect(DEMO_CHARACTER.accountName).toBe('OAuth Readonly Test');
    expect(DEMO_CHARACTER.resources).toHaveLength(3);
    expect(DEMO_CHARACTER.inventory).toHaveLength(3);
    expect(DEMO_CHARACTER.abilities).toHaveLength(3);
    expect('token' in DEMO_CHARACTER).toBe(false);
  });
});

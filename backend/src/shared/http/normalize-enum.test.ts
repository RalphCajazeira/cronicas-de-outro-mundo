import { expect, it } from 'vitest';
import { normalizeEnum } from './normalize-enum.js';

it('normalizes database enums to lowercase', () => expect(normalizeEnum('LEARNING')).toBe('learning'));

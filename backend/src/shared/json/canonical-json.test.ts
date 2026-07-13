import { describe, expect, it } from 'vitest';
import { canonicalJson, canonicalizeJson } from './canonical-json.js';

describe('canonical JSON', () => {
  it('sorts object keys recursively without mutating input and preserves array order', () => {
    const input = { z: 1, nested: { second: 2, first: 1 }, array: [{ b: 2, a: 1 }, 'last'] };
    const before = structuredClone(input);

    expect(canonicalizeJson(input)).toEqual({ array: [{ a: 1, b: 2 }, 'last'], nested: { first: 1, second: 2 }, z: 1 });
    expect(canonicalJson(input)).toBe('{"array":[{"a":1,"b":2},"last"],"nested":{"first":1,"second":2},"z":1}');
    expect(input).toEqual(before);
  });

  it.each([
    undefined,
    () => undefined,
    Symbol('invalid'),
    1n,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1.5,
  ])('rejects unsupported value %s', (value) => {
    expect(() => canonicalJson({ value })).toThrow(TypeError);
  });

  it('rejects cycles, sparse arrays and objects with unexpected prototypes', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const sparse = new Array<unknown>(1);
    const symbolKey = { [Symbol('invalid')]: 1 };

    expect(() => canonicalJson(cyclic)).toThrow(/cycles/);
    expect(() => canonicalJson(sparse)).toThrow(TypeError);
    expect(() => canonicalJson(new Date(0))).toThrow(/plain objects/);
    expect(() => canonicalJson(new (class Unexpected { value = 1; })())).toThrow(/plain objects/);
    expect(() => canonicalJson(symbolKey)).toThrow(/symbol keys/);
  });

  it('accepts strings, booleans, safe integers, null and null-prototype records', () => {
    const record = Object.assign(Object.create(null) as Record<string, unknown>, { value: null, enabled: true, count: -2 });
    expect(canonicalJson(record)).toBe('{"count":-2,"enabled":true,"value":null}');
  });
});

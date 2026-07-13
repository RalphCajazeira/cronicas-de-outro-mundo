export type CanonicalJsonValue =
  | null
  | string
  | boolean
  | number
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

function canonicalize(value: unknown, ancestors: WeakSet<object>): CanonicalJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || !Number.isFinite(value)) {
      throw new TypeError('Canonical JSON accepts only finite safe integers');
    }
    return value;
  }
  if (typeof value !== 'object') throw new TypeError('Value is not valid canonical JSON');
  if (ancestors.has(value)) throw new TypeError('Canonical JSON does not accept cycles');

  const prototype = Object.getPrototypeOf(value) as object | null;
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Canonical JSON accepts only plain objects');
  }
  if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError('Canonical JSON does not accept symbol keys');

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) throw new TypeError('Canonical JSON does not accept sparse arrays');
      return value.map((item) => canonicalize(item, ancestors));
    }
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key], ancestors)]),
    );
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalizeJson(value: unknown): CanonicalJsonValue {
  return canonicalize(value, new WeakSet<object>());
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value));
}

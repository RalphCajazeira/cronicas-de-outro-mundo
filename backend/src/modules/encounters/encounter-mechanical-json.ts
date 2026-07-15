import { canonicalJson } from '../../shared/json/canonical-json.js';

function jsonSafeMechanicalValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString(10);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length || value.some((entry) => entry === undefined)) {
      throw new TypeError('Encounter mechanical arrays must be dense and cannot contain undefined');
    }
    return value.map(jsonSafeMechanicalValue);
  }
  if (value !== null && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) return value;
    return Object.fromEntries(Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, jsonSafeMechanicalValue(entry)]));
  }
  return value;
}

export function canonicalEncounterMechanicalJson(value: unknown): string {
  return canonicalJson(jsonSafeMechanicalValue(value));
}

import { canonicalJson, canonicalizeJson } from '../../shared/json/canonical-json.js';

export const START_GAME_MAX_BYTES = 80 * 1024;
export const METADATA_MAX_BYTES = 4 * 1024;
export const METADATA_TOTAL_MAX_BYTES = 20 * 1024;
export const PROFILE_MAX_BYTES = 2 * 1024;
export const CAMPAIGN_STARTED_EVENT_MAX_BYTES = 8 * 1024;
export const IDEMPOTENT_TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 30_000 } as const;

export const difficultyPresets = {
  story: { errorTolerance: 5, opponentCunning: 1, resourceAvailability: 5, lethality: 1, failureSeverity: 1, narrativeSafetyNet: 5 },
  easy: { errorTolerance: 4, opponentCunning: 2, resourceAvailability: 4, lethality: 2, failureSeverity: 2, narrativeSafetyNet: 4 },
  standard: { errorTolerance: 3, opponentCunning: 3, resourceAvailability: 3, lethality: 3, failureSeverity: 3, narrativeSafetyNet: 3 },
  hard: { errorTolerance: 2, opponentCunning: 4, resourceAvailability: 2, lethality: 4, failureSeverity: 4, narrativeSafetyNet: 2 },
  brutal: { errorTolerance: 1, opponentCunning: 5, resourceAvailability: 1, lethality: 5, failureSeverity: 5, narrativeSafetyNet: 1 },
} as const;

export type DifficultyDimension = keyof typeof difficultyPresets.standard;
export type DifficultyPreset = keyof typeof difficultyPresets | 'custom';
export type DifficultyProfile = Record<DifficultyDimension, number>;

export function jsonByteSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function jsonDepth(value: unknown, seen = new WeakSet<object>()): number {
  if (value === null || typeof value !== 'object') return 0;
  if (seen.has(value)) return 0;
  seen.add(value);
  const children: unknown[] = Array.isArray(value) ? value as unknown[] : Object.values(value as Record<string, unknown>);
  const depth = 1 + children.reduce<number>((maximum, child) => Math.max(maximum, jsonDepth(child, seen)), 0);
  seen.delete(value);
  return depth;
}

export function jsonKeyCount(value: unknown, seen = new WeakSet<object>()): number {
  if (value === null || typeof value !== 'object') return 0;
  if (seen.has(value)) return 0;
  seen.add(value);
  const count = Array.isArray(value)
    ? (value as unknown[]).reduce<number>((total, child) => total + jsonKeyCount(child, seen), 0)
    : Object.entries(value as Record<string, unknown>).reduce<number>((total, [, child]) => total + 1 + jsonKeyCount(child, seen), 0);
  seen.delete(value);
  return count;
}

export function hasDangerousJsonKey(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  const entries = Array.isArray(value) ? (value as unknown[]).map((item) => ['', item]) : Object.entries(value as Record<string, unknown>);
  const dangerous = entries.some(([key, child]) => ['__proto__', 'prototype', 'constructor'].includes(String(key)) || hasDangerousJsonKey(child, seen));
  seen.delete(value);
  return dangerous;
}

export function canonicalize(value: unknown): unknown {
  return canonicalizeJson(value);
}

export function canonicalJsonEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function resolveDifficulty(
  preset: DifficultyPreset,
  overrides: { [Key in DifficultyDimension]?: number | undefined } | undefined,
): DifficultyProfile {
  const base = preset === 'custom' ? {} : difficultyPresets[preset];
  return { ...base, ...overrides } as DifficultyProfile;
}

export interface CampaignStartedPayload {
  schemaVersion: 1;
  technical: true;
  difficultyPreset: DifficultyPreset;
  difficultyProfile: DifficultyProfile;
  worldConfigSummary: {
    schemaVersion: 1;
    genres: string[];
    technologyGrade: string | null;
    magicGrade: string | null;
  };
  campaignConfigSummary: {
    schemaVersion: 1;
    progressionPace: string;
    narrativeTone: string[];
    focus: string[];
    playerFreedom: string;
    consequenceLevel: string;
    classMode: string;
  };
  initialContent: Array<{
    scope: 'world' | 'campaign';
    contentType: string;
    code: string;
    quantity: number;
    equipped: boolean;
  }>;
  initialPremise: string;
}

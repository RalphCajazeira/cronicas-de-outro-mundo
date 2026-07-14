import { createHash } from 'node:crypto';
import { canonicalJson } from '../../shared/json/canonical-json.js';
import type { CoreV1EffectContentVersionReference } from '../rules/core-v1/index.js';

function sha(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function createDeterministicEffectRef(targetActorRef: string, sourceContent: CoreV1EffectContentVersionReference, index: number) {
  return `fx_${sha({ targetActorRef, sourceContent, effectIndex: index }).slice(0, 32)}`;
}

export function calculateEffectResolutionResultHash(value: unknown): string {
  return sha(value);
}

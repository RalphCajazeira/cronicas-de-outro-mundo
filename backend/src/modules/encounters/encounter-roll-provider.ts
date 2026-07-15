import { createHash } from 'node:crypto';
import { canonicalJson } from '../../shared/json/canonical-json.js';
import type { EncounterRollProvider, CoreV1InjectedRolls } from '../rules/core-v1/index.js';
import { cryptographicRollProvider, type RollProvider } from '../effects/roll-provider.js';
import { EncounterError } from './encounter.errors.js';

export interface ConsumedEncounterRoll {
  readonly rollRef: string;
  readonly kind: 'tie_break' | 'hit' | 'critical' | 'concentration';
  readonly ordinal: number;
  readonly actionRef?: string;
  readonly sourceActorRef: string;
  readonly targetActorRef?: string;
  readonly targetOrdinal?: number;
  readonly inputHash: string;
  readonly resultSnapshot: { readonly rollBps: number };
  readonly resultHash: string;
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export class RecordingEncounterRollProvider implements EncounterRollProvider {
  readonly consumed: ConsumedEncounterRoll[] = [];
  readonly #source: RollProvider;
  readonly #executionRef: string;

  constructor(source: RollProvider = cryptographicRollProvider, executionRef = 'standalone') {
    this.#source = source;
    this.#executionRef = hash({ executionRef });
  }

  #consume(
    kind: ConsumedEncounterRoll['kind'],
    request: Omit<ConsumedEncounterRoll, 'kind' | 'ordinal' | 'inputHash' | 'resultSnapshot' | 'resultHash' | 'rollRef'>
      & { readonly encounterRef: string },
  ): number {
    const rollBps = this.#source.nextBps(kind === 'tie_break' ? 'hit' : kind);
    if (!Number.isSafeInteger(rollBps) || rollBps < 1 || rollBps > 10_000) {
      throw new EncounterError('ENCOUNTER_ROLL_INVALID');
    }
    const ordinal = this.consumed.length;
    const { encounterRef, ...persistedRequest } = request;
    const actionIdentity = hash({ actionRef: persistedRequest.actionRef ?? null });
    const rollRef = `${this.#executionRef}-${actionIdentity}-${kind}-${ordinal}`;
    const inputHash = hash({ encounterRef, kind, ordinal, ...persistedRequest });
    const resultSnapshot = { rollBps };
    this.consumed.push({
      ...persistedRequest, kind, ordinal, rollRef, inputHash, resultSnapshot,
      resultHash: hash(resultSnapshot),
    });
    return rollBps;
  }

  tieBreak(request: { readonly encounterRef: string; readonly actorRef: string }): number {
    return this.#consume('tie_break', { encounterRef: request.encounterRef, sourceActorRef: request.actorRef });
  }

  effectRolls(request: {
    readonly encounterRef: string;
    readonly actionRef: string;
    readonly sourceActorRef: string;
    readonly targetActorRef: string;
    readonly targetOrdinal: number;
  }): CoreV1InjectedRolls {
    let hit: number | undefined;
    let critical: number | undefined;
    const common = {
      encounterRef: request.encounterRef,
      actionRef: request.actionRef,
      sourceActorRef: request.sourceActorRef,
      targetActorRef: request.targetActorRef,
      targetOrdinal: request.targetOrdinal,
    };
    return Object.defineProperties({}, {
      hitRollBps: { enumerable: true, get: () => (hit ??= this.#consume('hit', common)) },
      criticalRollBps: { enumerable: true, get: () => (critical ??= this.#consume('critical', common)) },
    }) as CoreV1InjectedRolls;
  }
}

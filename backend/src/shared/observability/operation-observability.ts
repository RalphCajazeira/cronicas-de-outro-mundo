import { AsyncLocalStorage } from 'node:async_hooks';

export interface OperationStageTelemetry {
  readonly name: string;
  readonly calls: number;
  readonly durationMs: number;
  readonly queryCount: number;
  readonly databaseDurationMs: number;
}

export interface OperationTelemetrySnapshot {
  readonly operation: string;
  readonly outcome: 'commit' | 'error' | 'pending';
  readonly timeout: boolean;
  readonly queryCount: number;
  readonly databaseDurationMs: number;
  readonly largestQueryDurationMs: number;
  readonly largestQueryStage: string;
  readonly stages: readonly OperationStageTelemetry[];
}

interface MutableStageTelemetry {
  calls: number;
  durationMs: number;
  queryCount: number;
  databaseDurationMs: number;
}

export interface OperationTelemetryContext {
  operation: string;
  outcome: OperationTelemetrySnapshot['outcome'];
  timeout: boolean;
  queryCount: number;
  databaseDurationMs: number;
  largestQueryDurationMs: number;
  largestQueryStage: string;
  readonly stages: Map<string, MutableStageTelemetry>;
}

interface StoredOperationContext {
  readonly telemetry: OperationTelemetryContext;
  readonly stage: string;
}

const storage = new AsyncLocalStorage<StoredOperationContext>();

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function stageTelemetry(context: OperationTelemetryContext, name: string): MutableStageTelemetry {
  const current = context.stages.get(name);
  if (current !== undefined) return current;
  const created = { calls: 0, durationMs: 0, queryCount: 0, databaseDurationMs: 0 };
  context.stages.set(name, created);
  return created;
}

export function createOperationTelemetryContext(): OperationTelemetryContext {
  return {
    operation: 'unassigned',
    outcome: 'pending',
    timeout: false,
    queryCount: 0,
    databaseDurationMs: 0,
    largestQueryDurationMs: 0,
    largestQueryStage: 'unassigned',
    stages: new Map(),
  };
}

export function runWithOperationTelemetry<T>(context: OperationTelemetryContext, work: () => T): T {
  return storage.run({ telemetry: context, stage: 'unassigned' }, work);
}

export async function observeOperation<T>(operation: string, work: () => Promise<T>): Promise<T> {
  const current = storage.getStore();
  if (current === undefined) {
    const context = createOperationTelemetryContext();
    context.operation = operation;
    return runWithOperationTelemetry(context, () => observeOperation(operation, work));
  }
  current.telemetry.operation = operation;
  try {
    const value = await work();
    current.telemetry.outcome = 'commit';
    return value;
  } catch (error) {
    current.telemetry.outcome = 'error';
    throw error;
  }
}

export async function observeOperationStage<T>(name: string, work: () => Promise<T>): Promise<T> {
  const current = storage.getStore();
  if (current === undefined) return work();
  const startedAt = performance.now();
  try {
    return await storage.run({ telemetry: current.telemetry, stage: name }, work);
  } finally {
    const stage = stageTelemetry(current.telemetry, name);
    stage.calls += 1;
    stage.durationMs += performance.now() - startedAt;
  }
}

export function observeOperationStageSync<T>(name: string, work: () => T): T {
  const current = storage.getStore();
  if (current === undefined) return work();
  const startedAt = performance.now();
  try {
    return storage.run({ telemetry: current.telemetry, stage: name }, work);
  } finally {
    const stage = stageTelemetry(current.telemetry, name);
    stage.calls += 1;
    stage.durationMs += performance.now() - startedAt;
  }
}

export function recordDatabaseQuery(durationMs: number): void {
  const current = storage.getStore();
  if (current === undefined) return;
  current.telemetry.queryCount += 1;
  current.telemetry.databaseDurationMs += durationMs;
  const stage = stageTelemetry(current.telemetry, current.stage);
  stage.queryCount += 1;
  stage.databaseDurationMs += durationMs;
  if (durationMs > current.telemetry.largestQueryDurationMs) {
    current.telemetry.largestQueryDurationMs = durationMs;
    current.telemetry.largestQueryStage = current.stage;
  }
}

export function markOperationTimeout(): void {
  const current = storage.getStore();
  if (current !== undefined) current.telemetry.timeout = true;
}

export function operationTelemetrySnapshot(context: OperationTelemetryContext): OperationTelemetrySnapshot | undefined {
  if (context.operation === 'unassigned' && context.queryCount === 0) return undefined;
  return {
    operation: context.operation,
    outcome: context.outcome,
    timeout: context.timeout,
    queryCount: context.queryCount,
    databaseDurationMs: rounded(context.databaseDurationMs),
    largestQueryDurationMs: rounded(context.largestQueryDurationMs),
    largestQueryStage: context.largestQueryStage,
    stages: [...context.stages.entries()].map(([name, stage]) => ({
      name,
      calls: stage.calls,
      durationMs: rounded(stage.durationMs),
      queryCount: stage.queryCount,
      databaseDurationMs: rounded(stage.databaseDurationMs),
    })),
  };
}

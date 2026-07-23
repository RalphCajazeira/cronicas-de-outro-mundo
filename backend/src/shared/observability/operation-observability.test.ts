import { describe, expect, it } from 'vitest';
import {
  createOperationTelemetryContext,
  markOperationTimeout,
  observeOperation,
  observeOperationStage,
  observeOperationStageSync,
  operationTelemetrySnapshot,
  recordDatabaseQuery,
  runWithOperationTelemetry,
} from './operation-observability.js';

describe('operation observability', () => {
  it('records only bounded operation, stage, query and timeout metrics', async () => {
    const context = createOperationTelemetryContext();
    await runWithOperationTelemetry(context, () => observeOperation('startGame', () => observeOperationStage('content_publication', async () => {
      recordDatabaseQuery(12.345);
      markOperationTimeout();
      await Promise.resolve();
    })));
    const snapshot = operationTelemetrySnapshot(context);
    expect(snapshot).toMatchObject({
      operation: 'startGame', outcome: 'commit', timeout: true,
      queryCount: 1, databaseDurationMs: 12.35,
      largestQueryStage: 'content_publication',
    });
    expect(snapshot?.stages).toEqual([expect.objectContaining({ name: 'content_publication', calls: 1, queryCount: 1 })]);
    expect(JSON.stringify(snapshot)).not.toMatch(/payload|password|secret|postgres|sql/i);
  });

  it('counts synchronous capsule assembly without logging its payload', async () => {
    const context = createOperationTelemetryContext();
    await runWithOperationTelemetry(context, () => observeOperation('manageEncounter', () => {
      expect(observeOperationStageSync('encounter_capsule_assembly', () => 42)).toBe(42);
      return Promise.resolve();
    }));
    expect(operationTelemetrySnapshot(context)?.stages).toContainEqual(expect.objectContaining({
      name: 'encounter_capsule_assembly', calls: 1, queryCount: 0,
    }));
  });
});

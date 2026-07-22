import { describe, expect, it } from 'vitest';
import { AppError } from '../../shared/errors/app-error.js';
import { mapGptOperationError } from './gpt-operation.errors.js';

describe('GPT operation public errors', () => {
  it.each([
    [{ code: 'P2028', message: 'Transaction expired after timeout postgresql://private' }, 'startGame', 'OPERATION_TIMEOUT'],
    [{ code: 'P2024', message: 'Connection pool details are private' }, 'loadGame', 'DATABASE_TIMEOUT'],
    [{ code: 'P1001', message: 'Cannot reach private database host' }, 'loadGame', 'TEMPORARY_UNAVAILABLE'],
  ] as const)('maps known transient failures without exposing internal details', (internal, operation, expectedCode) => {
    const mapped = mapGptOperationError(internal, operation);
    expect(mapped).toMatchObject({
      statusCode: 503,
      code: expectedCode,
      retryable: true,
      recoveryAction: 'retry_same_request',
    });
    expect(JSON.stringify(mapped)).not.toMatch(/postgres|private|host/i);
  });

  it('preserves domain errors and leaves unexpected failures for the closed generic handler', () => {
    const domain = new AppError(409, 'CONFLICT', 'Safe conflict');
    const unexpected = new Error('private SQL details');
    expect(mapGptOperationError(domain, 'startGame')).toBe(domain);
    expect(mapGptOperationError(unexpected, 'loadGame')).toBe(unexpected);
  });
});

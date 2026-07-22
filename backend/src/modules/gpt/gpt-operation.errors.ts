import { AppError } from '../../shared/errors/app-error.js';
import { markOperationTimeout } from '../../shared/observability/operation-observability.js';

export type GptMeasuredOperation = 'startGame' | 'loadGame';

function internalCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function internalMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
    ? error.message
    : '';
}

export function mapGptOperationError(error: unknown, operation: GptMeasuredOperation): unknown {
  if (error instanceof AppError) return error;
  const code = internalCode(error);
  const message = internalMessage(error);
  if (code === 'P2028' && /timeout|timed out|expired|closed/i.test(message)) {
    markOperationTimeout();
    return new AppError(503, 'OPERATION_TIMEOUT', `${operation} operation timed out`, {
      retryable: true,
      recoveryAction: 'retry_same_request',
      auditCode: 'GPT_OPERATION_TIMEOUT',
    });
  }
  if (['P1002', 'P1008', 'P2024', '57014', 'ETIMEDOUT'].includes(code ?? '')) {
    markOperationTimeout();
    return new AppError(503, 'DATABASE_TIMEOUT', `${operation} database operation timed out`, {
      retryable: true,
      recoveryAction: 'retry_same_request',
      auditCode: 'GPT_DATABASE_TIMEOUT',
    });
  }
  if (['P1001', 'P1017', '57P01', '08006', '08001', 'ECONNREFUSED', 'ECONNRESET'].includes(code ?? '')) {
    return new AppError(503, 'TEMPORARY_UNAVAILABLE', `${operation} is temporarily unavailable`, {
      retryable: true,
      recoveryAction: 'retry_same_request',
      auditCode: 'GPT_DATABASE_UNAVAILABLE',
    });
  }
  return error;
}

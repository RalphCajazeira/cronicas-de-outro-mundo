import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../errors/app-error.js';
import { setAuditError } from './request-audit.js';

const validationRetryInstruction = 'Correct only the listed fields according to the OpenAPI contract and retry once. Do not invent missing values.';

function validationIssue(issue: ZodError['issues'][number]) {
  const path = issue.path.map(String).join('.') || '$';
  let message = 'Value does not match the OpenAPI contract';
  if (issue.code === 'custom') message = issue.message;
  else if (issue.code === 'invalid_type') message = `Expected ${issue.expected}`;
  else if (issue.code === 'invalid_value') message = `Expected one of: ${issue.values.map(String).join(', ')}`;
  else if (issue.code === 'too_small') message = `Expected at least ${String(issue.minimum)}`;
  else if (issue.code === 'too_big') message = `Expected at most ${String(issue.maximum)}`;
  else if (issue.code === 'unrecognized_keys') message = `Remove unsupported fields: ${issue.keys.join(', ')}`;
  return { code: issue.code, message: message.slice(0, 200), path };
}

export const notFoundHandler: RequestHandler = (_request, response) => {
  response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
};

export const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
  void _next;
  if (error instanceof ZodError) {
    const issues = error.issues.slice(0, 20).map(validationIssue);
    setAuditError(response, {
      type: 'validation',
      code: 'INVALID_INPUT',
      issues,
    });
    response.status(400).json({
      error: {
        code: 'INVALID_INPUT',
        message: 'Invalid request input',
        retryable: true,
        retryInstruction: validationRetryInstruction,
        issues,
      },
    });
    return;
  }
  if (error instanceof AppError) {
    setAuditError(response, { type: 'application', code: error.code });
    response.status(error.statusCode).json({ error: { code: error.code, message: error.message } });
    return;
  }
  setAuditError(response, { type: 'internal', code: 'INTERNAL_ERROR' });
  response.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
};

import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../errors/app-error.js';
import { setAuditError } from './request-audit.js';

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

function internalErrorDiagnostic(error: unknown) {
  if (!(error instanceof Error)) return { type: 'internal' as const, code: 'INTERNAL_ERROR' };
  const errorName = /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(error.name) ? error.name : 'Error';
  const stackFrames = (error.stack?.split(/\r?\n/).slice(1) ?? []).flatMap((line) => {
    const match = line.trim().match(
      /^at (?:(?<functionName>[^(\r\n]{1,120}) \()?[^()\r\n]*[/\\](?<fileName>[A-Za-z0-9_.-]+\.(?:ts|js|mjs|cjs)):(?<line>\d+):(?<column>\d+)\)?$/,
    );
    if (match?.groups === undefined) return [];
    const functionName = match.groups.functionName?.trim();
    const safeFunctionName = functionName !== undefined && /^[A-Za-z0-9_.$<> -]{1,120}$/.test(functionName)
      ? `${functionName} `
      : '';
    return [`at ${safeFunctionName}(${match.groups.fileName}:${match.groups.line}:${match.groups.column})`];
  }).slice(0, 8);
  return {
    type: 'internal' as const,
    code: 'INTERNAL_ERROR',
    errorName,
    ...(stackFrames.length === 0 ? {} : { stackFrames }),
  };
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
        retryable: false,
        recoveryAction: 'correct_request',
        issues,
      },
    });
    return;
  }
  if (error instanceof AppError) {
    const issues = error.issues?.slice(0, 20).map((issue) => ({
      path: issue.path.slice(0, 200),
      code: issue.code.slice(0, 100),
      message: issue.message.slice(0, 200),
    }));
    setAuditError(response, {
      type: 'application',
      code: error.auditCode ?? error.code,
      ...(error.auditCategories === undefined
        ? {}
        : { mismatchCategories: [...error.auditCategories].slice(0, 8) }),
      ...(issues === undefined ? {} : { issues }),
    });
    response.status(error.statusCode).json({ error: {
      code: error.code,
      message: error.message,
      ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
      ...(error.recoveryAction === undefined ? {} : { recoveryAction: error.recoveryAction }),
      ...(issues === undefined ? {} : { issues }),
    } });
    return;
  }
  setAuditError(response, internalErrorDiagnostic(error));
  response.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
};

export class AppError extends Error {
  readonly retryable: boolean | undefined;
  readonly recoveryAction: string | undefined;
  readonly auditCode: string | undefined;

  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    options?: { readonly retryable?: boolean; readonly recoveryAction?: string; readonly auditCode?: string },
  ) {
    super(message);
    this.retryable = options?.retryable;
    this.recoveryAction = options?.recoveryAction;
    this.auditCode = options?.auditCode;
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) { super(404, 'NOT_FOUND', `${resource} not found`); }
}

export class ConflictError extends AppError {
  constructor(message = 'Request conflicts with persisted state') { super(409, 'CONFLICT', message); }
}

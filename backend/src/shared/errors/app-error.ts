export interface PublicErrorIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export class AppError extends Error {
  readonly retryable: boolean | undefined;
  readonly recoveryAction: string | undefined;
  readonly auditCode: string | undefined;
  readonly issues: readonly PublicErrorIssue[] | undefined;

  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    options?: {
      readonly retryable?: boolean;
      readonly recoveryAction?: string;
      readonly auditCode?: string;
      readonly issues?: readonly PublicErrorIssue[];
    },
  ) {
    super(message);
    this.retryable = options?.retryable;
    this.recoveryAction = options?.recoveryAction;
    this.auditCode = options?.auditCode;
    this.issues = options?.issues;
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) { super(404, 'NOT_FOUND', `${resource} not found`); }
}

export class ConflictError extends AppError {
  constructor(message = 'Request conflicts with persisted state') { super(409, 'CONFLICT', message); }
}

import { AppError } from '../../shared/errors/app-error.js';

export class AuthorizationDeniedError extends AppError {
  constructor(reasonCode: string) {
    super(403, 'FORBIDDEN', 'Access is not allowed', {
      retryable: false,
      auditCode: reasonCode,
      auditCategories: ['authorization'],
    });
  }
}

export class AuthorizationIntegrityError extends AppError {
  constructor(reasonCode: string) {
    super(500, 'AUTHORIZATION_INTEGRITY_ERROR', 'Authorization state is inconsistent', {
      retryable: false,
      auditCode: reasonCode,
      auditCategories: ['authorization', 'integrity'],
    });
  }
}

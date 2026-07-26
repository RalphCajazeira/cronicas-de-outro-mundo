import { AppError } from '../../shared/errors/app-error.js';

export class InvalidExternalPrincipalError extends AppError {
  constructor() {
    super(401, 'EXTERNAL_PRINCIPAL_INVALID', 'External principal is invalid', {
      retryable: false,
      auditCode: 'external_principal_invalid',
      auditCategories: ['identity'],
    });
  }
}

export class ExternalIdentityNotFoundError extends AppError {
  constructor() {
    super(401, 'EXTERNAL_IDENTITY_NOT_FOUND', 'External identity is not linked', {
      retryable: false,
      auditCode: 'external_identity_not_found',
      auditCategories: ['identity'],
    });
  }
}

export class ExternalIdentityConflictError extends AppError {
  constructor() {
    super(500, 'EXTERNAL_IDENTITY_CONFLICT', 'External identity state is ambiguous', {
      retryable: false,
      auditCode: 'external_identity_conflict',
      auditCategories: ['identity', 'integrity'],
    });
  }
}

export class UserSuspendedError extends AppError {
  constructor() {
    super(403, 'USER_SUSPENDED', 'User is suspended', {
      retryable: false,
      auditCode: 'user_suspended',
      auditCategories: ['identity', 'authorization'],
    });
  }
}

export class UserUnavailableError extends AppError {
  constructor() {
    super(403, 'USER_UNAVAILABLE', 'User is unavailable', {
      retryable: false,
      auditCode: 'user_unavailable',
      auditCategories: ['identity', 'authorization'],
    });
  }
}

export class UserIdentityIntegrityError extends AppError {
  constructor() {
    super(500, 'USER_IDENTITY_INTEGRITY_ERROR', 'User identity state is inconsistent', {
      retryable: false,
      auditCode: 'user_identity_integrity_error',
      auditCategories: ['identity', 'integrity'],
    });
  }
}

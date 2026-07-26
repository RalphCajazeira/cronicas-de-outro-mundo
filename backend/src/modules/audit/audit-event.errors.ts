import { AppError } from '../../shared/errors/app-error.js';

export class AuditEventRejectedError extends AppError {
  constructor() {
    super(500, 'AUDIT_EVENT_REJECTED', 'Audit event contains unsafe data', {
      retryable: false,
      auditCode: 'audit_event_rejected',
      auditCategories: ['audit', 'integrity'],
    });
  }
}

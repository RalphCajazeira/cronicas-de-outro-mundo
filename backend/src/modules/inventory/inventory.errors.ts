import { ConflictError } from '../../shared/errors/app-error.js';
import type { ValidationIssue } from '../rules/core-v1/core-v1.types.js';

export class InventoryOperationRejectedError extends ConflictError {
  constructor(readonly domainIssues: readonly ValidationIssue[] = []) {
    super('Inventory operation is invalid for the current state');
  }
}

export class InventoryStateVersionRejectedError extends ConflictError {
  constructor() {
    super('Inventory state version conflict');
  }
}

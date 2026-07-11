export class AppError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) {
    super(message);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) { super(404, 'NOT_FOUND', `${resource} not found`); }
}

export class ConflictError extends AppError {
  constructor(message = 'Request conflicts with persisted state') { super(409, 'CONFLICT', message); }
}

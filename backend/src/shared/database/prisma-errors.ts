import { Prisma } from '../../generated/prisma/client.js';

function property(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  return (value as Record<string, unknown>)[key];
}

export function isUniqueConflict(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export interface ExpectedUniqueConflict {
  modelName: string;
  fields: readonly string[];
  index: string;
  allowModelOnly?: boolean;
}

export function isExpectedUniqueConflict(error: unknown, expected: ExpectedUniqueConflict): boolean {
  if (!isUniqueConflict(error)) return false;
  const metadata = error.meta;
  if (metadata === undefined || metadata === null || typeof metadata !== 'object') return false;
  const modelName = property(metadata, 'modelName');
  if (modelName !== undefined && modelName !== expected.modelName) return false;

  const matchesFields = (value: unknown) => Array.isArray(value)
    && value.length === expected.fields.length
    && value.every((field, index) => field === expected.fields[index]);
  const target = property(metadata, 'target');
  if (target !== undefined) return matchesFields(target);

  const driverAdapterError = property(metadata, 'driverAdapterError');
  const cause = property(driverAdapterError, 'cause');
  if (property(cause, 'kind') !== 'UniqueConstraintViolation') return false;
  const constraint = property(cause, 'constraint');
  const fields = property(constraint, 'fields');
  if (fields !== undefined) return matchesFields(fields);
  const index = property(constraint, 'index');
  if (index !== undefined) return index === expected.index;
  return expected.allowModelOnly === true && modelName === expected.modelName;
}

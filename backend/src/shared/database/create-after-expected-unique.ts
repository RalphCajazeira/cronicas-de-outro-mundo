import { isExpectedUniqueConflict, type ExpectedUniqueConflict } from './prisma-errors.js';

export interface SavepointClient {
  $executeRawUnsafe(query: string): Promise<unknown>;
}

export async function createAfterExpectedUnique<T>(
  client: SavepointClient,
  savepoint: string,
  create: () => Promise<T>,
  reread: () => Promise<T | null>,
  expected: ExpectedUniqueConflict,
): Promise<T> {
  await client.$executeRawUnsafe(`SAVEPOINT ${savepoint}`);
  try {
    const created = await create();
    await client.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
    return created;
  } catch (error) {
    await client.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
    if (!isExpectedUniqueConflict(error, expected)) throw error;
    const persisted = await reread();
    if (persisted === null) throw error;
    return persisted;
  }
}

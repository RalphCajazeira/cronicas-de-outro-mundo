import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PrismaClient } from '../../generated/prisma/client.js';
import { recordDatabaseQuery } from '../observability/operation-observability.js';

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString.length === 0) {
  throw new Error('Invalid application configuration');
}

const pool = new pg.Pool({
  connectionString,
  max: 5,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 10_000,
});
const adapter = new PrismaPg(pool, { disposeExternalPool: true });
export const prisma = new PrismaClient({
  adapter,
  log: [{ emit: 'event', level: 'query' }],
});
prisma.$on('query', (event) => recordDatabaseQuery(event.duration));

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}

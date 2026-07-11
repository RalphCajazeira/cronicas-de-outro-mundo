import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url().optional(),
  RPG_API_KEY: z.string().min(1),
});

export type AppConfig = z.infer<typeof envSchema>;

export function parseConfig(environment: NodeJS.ProcessEnv): AppConfig {
  const result = envSchema.safeParse(environment);
  if (!result.success) throw new Error('Invalid application configuration');
  return result.data;
}

import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().trim().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url().optional(),
  RPG_API_KEY: z.string().min(1),
  PUBLIC_BASE_URL: z.string().url().optional(),
}).superRefine((value, context) => {
  if (value.NODE_ENV === 'production' && value.PUBLIC_BASE_URL === undefined) {
    context.addIssue({ code: 'custom', path: ['PUBLIC_BASE_URL'], message: 'Required in production' });
  }
});

export type AppConfig = z.infer<typeof envSchema>;

export function parseConfig(environment: NodeJS.ProcessEnv): AppConfig {
  const result = envSchema.safeParse(environment);
  if (!result.success) throw new Error('Invalid application configuration');
  return result.data;
}

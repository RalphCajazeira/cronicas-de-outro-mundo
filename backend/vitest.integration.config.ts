import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.integration.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    disableConsoleIntercept: process.env.REPORT_ENCOUNTER_BUDGETS === '1',
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});

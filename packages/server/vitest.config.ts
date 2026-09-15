import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // The suite shares one Postgres database; run files serially so migrations
    // and per-file tenant fixtures never race each other.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});

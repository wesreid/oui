import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts'],
    // Each generate() builds a TypeScript program over the fixture app and
    // starts a Vite server for its app catalogs: seconds, more on a busy runner.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});

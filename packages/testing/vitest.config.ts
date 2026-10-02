import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // The fixture app imports its design system by package name, as an app does.
    alias: { '@kit/ds': fileURLToPath(new URL('./__tests__/fixtures/ds.ts', import.meta.url)) },
  },
  test: {
    environment: 'jsdom',
    include: ['__tests__/**/*.test.ts', '__tests__/**/*.test.tsx'],
    testTimeout: 60_000,
  },
});

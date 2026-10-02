import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The tests render the fixtures' JSX as the apps compile it (`jsx: react-jsx`).
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'jsdom',
    include: ['__tests__/**/*.test.ts', '__tests__/**/*.test.tsx'],
    setupFiles: ['__tests__/support/dom.ts'],
    testTimeout: 60_000,
  },
});

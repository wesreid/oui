import { defineConfig } from 'vitest/config';

/**
 * The live behavioural evals (`evals/*.live-eval.ts`): they call the real model,
 * so they are run on purpose (`pnpm eval:live`), never by `pnpm test`.
 */
export default defineConfig({
  test: {
    include: ['evals/**/*.live-eval.ts'],
    testTimeout: 180_000,
  },
});

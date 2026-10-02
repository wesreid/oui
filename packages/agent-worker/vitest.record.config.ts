import { defineConfig } from 'vitest/config';

/**
 * Re-records the fixture turn's model responses from a live model
 * (`evals/*.record.ts`). Run on purpose (`pnpm record:fixture-turn`), never by
 * `pnpm test`; the acceptance test replays what it writes.
 */
export default defineConfig({
  test: {
    include: ['evals/**/*.record.ts'],
    testTimeout: 180_000,
  },
});

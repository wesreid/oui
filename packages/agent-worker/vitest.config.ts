import { defineConfig } from 'vitest/config';

/**
 * A turn through the real `ai` loop imports the worker first, which takes more
 * than vitest's default 5 seconds on a loaded machine: tests that assert nothing
 * about time timed out in a release's verify job and in the commit hook.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
  },
});

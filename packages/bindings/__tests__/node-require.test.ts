/**
 * The built package, required from CommonJS.
 *
 * studio-api compiles to CommonJS and names the PA's tools from this
 * package's constants (the generated navigation tool's name, from
 * `NAVIGATE_ACTION_ID`), so its server and its agent worker load it with
 * require(). Node (22.12 and later) loads an ES module that way, but only when
 * an export condition require() reads names it: `default`, beside `import`.
 * Each entry point is required by name, from inside the package, as a
 * dependent resolves it. `test` depends on `build` (turbo.json), so `dist` is
 * the one about to be published.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageDir = resolve(__dirname, '..');

describe('the built package, required from CommonJS', () => {
  it.each(['@ouispec/bindings', '@ouispec/bindings/oui'])(
    'require(%s) loads it, every export defined',
    name => {
      const out = execFileSync(
        process.execPath,
        [
          '-e',
          `const m = require(${JSON.stringify(name)}); ` +
            `const missing = Object.entries(m).filter(([, v]) => v === undefined).map(([k]) => k); ` +
            `console.log(JSON.stringify({ exports: Object.keys(m).length, missing }));`,
        ],
        { encoding: 'utf8', cwd: packageDir, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const { exports, missing } = JSON.parse(out.trim().split('\n').pop()!) as {
        exports: number;
        missing: string[];
      };
      expect(exports).toBeGreaterThan(0);
      expect(missing).toEqual([]);
    },
  );
});

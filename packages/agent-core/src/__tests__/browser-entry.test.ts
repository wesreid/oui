/**
 * A bundler that honours the `browser` condition (Vite, webpack, esbuild)
 * resolves `@ouispec/agent-core` to `dist/browser.js`, not `dist/index.js`.
 * A module added to the main entry and not to this one is missing from every
 * browser build: agent-react 0.8.0's composer imports the attachment limits,
 * which 0.8.1's browser entry did not export, so a host's production build
 * failed while its tests and typecheck, which resolve the main entry, passed.
 *
 * The browser entry is the main entry less the schema loader, which reads
 * files with node:fs.
 */
import { describe, expect, it } from 'vitest';
import * as browser from '../browser.js';
import * as main from '../index.js';
import * as schema from '../schema/index.js';

describe('the browser entry', () => {
  it('exports everything the main entry does, except the Node-only schema loader', () => {
    const nodeOnly = new Set(Object.keys(schema));
    const expected = Object.keys(main).filter(name => !nodeOnly.has(name)).sort();
    expect(Object.keys(browser).sort()).toEqual(expected);
  });

  it('exports the attachment helpers a browser composer imports', () => {
    expect(browser).toHaveProperty('DEFAULT_ATTACHMENT_LIMITS');
    expect(browser).toHaveProperty('attachmentKindOf');
    expect(browser).toHaveProperty('attachmentRefusal');
  });
});

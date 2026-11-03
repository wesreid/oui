/**
 * What the package's root gives a product to hold its pages to the worker's
 * limits in a test. 0.23.0's changelog named these and its root did not export
 * them: an edit that matched nothing, under tests that imported the module
 * directly. So this one imports the root, and reads a real page through it.
 */
import { describe, expect, it } from 'vitest';

import { boardPage } from '../../evals/support/board-page.js';
import {
  DEFAULT_INDEX_CHARS,
  DEFAULT_PAGE_STATE_CHARS,
  indexText,
  observationSchemas,
  observationsText,
  pageFromIndex,
  pageStateFit,
  type PageStateFit,
} from '../index.js';
import type { OUIIndexSnapshot } from 'oui-spec/spec';

describe('the package root, on a long form', () => {
  it('fits its page state and reads its index with the limits the worker gives the model', async () => {
    const snapshot = (await boardPage()).snapshot() as OUIIndexSnapshot;
    const page = pageFromIndex(snapshot.index);
    const options = { schemas: observationSchemas(page) };

    const fit: PageStateFit = pageStateFit(snapshot.observations, DEFAULT_PAGE_STATE_CHARS, options);
    expect(fit.outcome).toBe('fitted');
    expect(fit.omitted).toEqual([]);
    expect(fit.chars).toBeGreaterThan(DEFAULT_PAGE_STATE_CHARS);

    const text = observationsText(snapshot.observations, DEFAULT_PAGE_STATE_CHARS, options);
    expect(text.length).toBeLessThanOrEqual(DEFAULT_PAGE_STATE_CHARS + 1_000);
    expect(text).toContain('board.line.language');

    expect(indexText(page, Infinity).length).toBeLessThanOrEqual(DEFAULT_INDEX_CHARS);
  });
});

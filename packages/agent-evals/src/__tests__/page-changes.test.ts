/**
 * A declared surface's runs that each change part of its state (`changes`), as the person's page changes it (a
 * product's editor eval, recorded live): an action could only replace an observation whole (`state`), so a scenario
 * whose edits each touch one part of a room (a point marked, a callout anchored, the camera set) could not show what
 * the edits made without fixing their order. Every model then read the page again to check its work, and hedged that
 * the room's warning "may be stale".
 *
 * - `changes` merges into each observation: an object field by field, a list of identified items item by item, any
 *   other value replaced, a field given null taken away; so runs compose in any order.
 * - `state` replaces as before, and a page that uses neither is the page it was.
 */
import { describe, expect, it } from 'vitest';
import { OUI_READ_ACTION, OUI_RUNTIME_SURFACE, type OUIActionResult } from 'oui-spec/spec';
import type { AgentEvalPage, AgentEvalPageAction } from '@ouispec/contract';
import { createFixturePage, type EvalPage } from '../page.js';

const SURFACE = 'room:shot';
const INPUT = { type: 'object', properties: { item: { type: 'string' }, value: { type: 'string' } } };

/** A screen shot's room: its shot and its callout shown, the callout's warning, and three edits. */
function shotPage(actions: Partial<Record<string, Partial<AgentEvalPageAction>>> = {}): AgentEvalPage {
  const declared: AgentEvalPageAction[] = [
    {
      id: 'mark',
      description: 'Mark a found region as a point',
      input: INPUT,
      changes: { state: { shown: [{ id: 'shot', facts: { Points: 'History' } }] } },
    },
    {
      id: 'anchor',
      description: 'Point the callout at a point',
      input: INPUT,
      changes: { state: { shown: [{ id: 'overlay', facts: { 'Points at': 'History' } }], issues: [] } },
    },
    {
      id: 'frame',
      description: 'Frame a point with the camera',
      input: INPUT,
      changes: { state: { shown: [{ id: 'shot', facts: { Camera: 'push in on History' } }] } },
    },
  ].map((a) => ({ ...a, ...(actions[a.id] ?? {}) }) as AgentEvalPageAction);
  return {
    at: '/storyboards/sb-1',
    surfaces: [
      {
        id: SURFACE,
        name: 'Shot',
        description: 'A screen shot of the Storyboard',
        routes: ['/storyboards/:id'],
        state: {
          state: {
            saved: 'saved',
            shown: [
              { id: 'shot', title: 'Feature 2 · screen', facts: { Points: 'none', Camera: 'still, on the whole screen' } },
              { id: 'overlay', title: 'Callout · Undo anything', facts: { 'Points at': 'nothing' } },
            ],
            issues: [{ path: 'graphics[3].anchor', code: 'overlay-unanchored' }],
          },
        },
        actions: declared,
      },
    ],
  };
}

let requests = 0;
async function execute(page: EvalPage, surfaceId: string, actionId: string, params: Record<string, unknown>): Promise<OUIActionResult> {
  const requestId = `c${++requests}`;
  await page.channel.dispatch('eval-room', { requestId, surfaceId, actionId, params, timestamp: 0 });
  return (await page.channel.awaitResult(requestId, { userId: 'u-1', timeoutMs: 1_000 }))!;
}
const act = (page: EvalPage, actionId: string, params: Record<string, unknown> = {}) => execute(page, SURFACE, actionId, params);
const stateOf = async (page: EvalPage) =>
  ((await execute(page, OUI_RUNTIME_SURFACE, OUI_READ_ACTION, { surface: SURFACE, observation: 'state' })).data as { value: Record<string, unknown> }).value;

async function withPage<T>(fixture: AgentEvalPage, run: (page: EvalPage) => Promise<T>): Promise<T> {
  const page = createFixturePage(fixture);
  try {
    return await run(page);
  } finally {
    page.close();
  }
}

const EDITED = {
  saved: 'saved',
  shown: [
    { id: 'shot', title: 'Feature 2 · screen', facts: { Points: 'History', Camera: 'push in on History' } },
    { id: 'overlay', title: 'Callout · Undo anything', facts: { 'Points at': 'History' } },
  ],
  issues: [],
};

describe('runs that each change part of a surface’s state', () => {
  it('show what every run made, whatever order they ran in', async () => {
    for (const order of [
      ['mark', 'anchor', 'frame'],
      ['frame', 'anchor', 'mark'],
      ['anchor', 'mark', 'frame'],
    ]) {
      await withPage(shotPage(), async (page) => {
        for (const id of order) expect((await act(page, id)).success, id).toBe(true);
        expect(await stateOf(page), order.join(' → ')).toEqual(EDITED);
      });
    }
  });

  it('changes one item of a list by its identity, and leaves the rest and the other fields as they were', async () => {
    await withPage(shotPage(), async (page) => {
      await act(page, 'mark');
      expect(await stateOf(page)).toEqual({
        saved: 'saved',
        shown: [
          { id: 'shot', title: 'Feature 2 · screen', facts: { Points: 'History', Camera: 'still, on the whole screen' } },
          { id: 'overlay', title: 'Callout · Undo anything', facts: { 'Points at': 'nothing' } },
        ],
        issues: [{ path: 'graphics[3].anchor', code: 'overlay-unanchored' }],
      });
    });
  });

  it('adds an item with a new identity at its list’s end, takes a field given null away, and replaces a list without identities', async () => {
    const page = shotPage({
      mark: {
        changes: {
          state: {
            saved: null,
            shown: [{ id: 'point', title: 'Point · History', facts: { Shape: 'region' } }],
            issues: [{ path: 'shots[5].camera', code: 'camera-still' }],
          },
        },
      },
    });
    await withPage(page, async (p) => {
      await act(p, 'mark');
      const state = await stateOf(p);
      expect(state).not.toHaveProperty('saved');
      expect((state.shown as Array<{ id: string }>).map((s) => s.id)).toEqual(['shot', 'overlay', 'point']);
      expect(state.issues).toEqual([{ path: 'shots[5].camera', code: 'camera-still' }]);
    });
  });

  it('changes what a case says for the call its input holds, and nothing when the run fails', async () => {
    const page = shotPage({
      anchor: {
        changes: undefined,
        result: { success: false, error: 'No such point.' },
        cases: [{ when: { value: 'History' }, changes: { state: { shown: [{ id: 'overlay', facts: { 'Points at': 'History' } }], issues: [] } } }],
      },
    });
    await withPage(page, async (p) => {
      expect((await act(p, 'anchor', { item: 'feature-2', value: 'Export' })).success).toBe(false);
      expect((await stateOf(p)).issues).toHaveLength(1);
      expect((await act(p, 'anchor', { item: 'feature-2', value: 'History' })).success).toBe(true);
      expect(await stateOf(p)).toMatchObject({ issues: [], shown: [{ id: 'shot' }, { id: 'overlay', facts: { 'Points at': 'History' } }] });
    });
  });

  it('applies `state` whole before `changes`, as it always replaced: a page that uses only `state` is the page it was', async () => {
    const page = shotPage({
      mark: { changes: undefined, state: { state: { saved: 'saving', shown: [{ id: 'shot', title: 'Feature 2 · screen' }] } } },
      frame: { state: { state: { saved: 'saved' } }, changes: { state: { issues: [] } } },
    });
    await withPage(page, async (p) => {
      await act(p, 'mark');
      expect(await stateOf(p)).toEqual({ saved: 'saving', shown: [{ id: 'shot', title: 'Feature 2 · screen' }] });
      await act(p, 'frame');
      expect(await stateOf(p)).toEqual({ saved: 'saved', issues: [] });
    });
  });
});

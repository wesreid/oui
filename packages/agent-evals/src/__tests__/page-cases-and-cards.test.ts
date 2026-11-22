/**
 * Three things a product's flow needs of the harness that it got wrong
 * (studio-api's promo-from-website screen, ADR-0326):
 *
 * - a list's control (one per row) matched its cases without the row, so a
 *   case for one row (`when: { item: … }`) never held: choosing a Storyboard's
 *   kind never went to its questions;
 * - a read stub answered the same before and after the page's work changed
 *   what it reads (a capture continued through its links read back as never
 *   continued), so the agent retried work that had worked (`afterRan`);
 * - a rubric that wants a question asked was judged on the reply's text
 *   alone, where an agent asks on a choice card: what the turn showed the
 *   person is its reply and its cards.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { conversationOf, messageText, type ChatRequest, type ScriptedReply } from '@ouispec/agent-worker/testing';
import { deriveInputSchema, toolName, type OuiManifest } from '@ouispec/bindings';
import type { AgentEvalSuite } from '@ouispec/contract';
import { createFixturePage } from '../page.js';
import { check, runEvals, shownToCustomer, type EvalTurnRecord } from '../run.js';
import { configFor, recordWith, scratch } from './support.js';

const dirs: Array<() => void> = [];
afterAll(() => dirs.forEach((cleanup) => cleanup()));
const tempDir = () => {
  const s = scratch();
  dirs.push(s.cleanup);
  return s.dir;
};

/** The creator's kinds, one tile per kind, as the product's manifest declares them. */
const CREATOR: OuiManifest = {
  version: 1,
  buildId: 'eval',
  surfaces: [
    {
      id: 'page:creator',
      kind: 'page',
      title: 'New Storyboard',
      description: 'Choose a kind, then its questions.',
      routes: ['/storyboards/new'],
      actions: [
        {
          name: toolName('creator.kind'),
          id: 'creator.kind',
          source: 'control',
          control: 'tile',
          itemized: true,
          title: 'Kind',
          description: 'Choose the kind of Storyboard',
          effect: 'navigate',
          input: deriveInputSchema('button', {}, { itemized: true }),
          reach: [],
          declaredIn: 'creator.tsx',
        },
      ],
      observations: [{ id: 'state', description: 'What the page shows.', schema: { type: 'object' } }],
    },
  ],
};

describe('a list’s control', () => {
  it('matches its cases with the row it ran for, as `item`', async () => {
    const page = createFixturePage(
      {
        at: '/storyboards/new',
        controls: {
          'creator.kind': {
            rows: [
              { key: 'brief', title: 'Brief' },
              { key: 'product-promo', title: 'Product promo' },
            ],
            cases: [{ when: { item: 'product-promo' }, navigate: '/storyboards/new?kind=product-promo' }],
          },
        },
      },
      { manifest: CREATOR },
    );
    try {
      const pick = async (requestId: string, item: string) => {
        await page.channel.dispatch('turn', { requestId, surfaceId: 'page:creator', actionId: 'creator_kind', params: { item }, timestamp: 0 });
        return page.channel.awaitResult(requestId, { userId: 'u-1', timeoutMs: 2_000 });
      };
      expect((await pick('k1', 'brief'))?.success).toBe(true);
      // Another row's case does not hold for this one.
      expect(page.location()).toBe('/storyboards/new');
      expect((await pick('k2', 'product-promo'))?.success).toBe(true);
      expect(page.location()).toBe('/storyboards/new?kind=product-promo');
      expect(page.ran.map((r) => r.input)).toEqual([{ item: 'brief' }, { item: 'product-promo' }]);
    } finally {
      page.close();
    }
  });
});

const lastTool = (request: ChatRequest) => {
  const last = conversationOf(request).at(-1);
  return last?.role === 'tool' ? messageText(last) : null;
};

describe('a read stub after the page’s work', () => {
  const suite: AgentEvalSuite = {
    version: 1,
    name: 'reads',
    stubs: {
      readCapture: [
        // Once the capture is continued through its links, it reads back with them.
        { when: { captureId: 'c-1' }, afterRan: { action: 'site_capture', input: { followLinks: true } }, result: { success: true, data: { pages: 3 } } },
        { when: { captureId: 'c-1' }, result: { success: true, data: { pages: 1 } } },
      ],
    },
    page: {
      at: '/home',
      surfaces: [
        {
          id: 'room:site',
          name: 'Site',
          description: 'Captures a site.',
          actions: [
            {
              id: 'site_capture',
              description: 'Captures the site, or continues it through its links.',
              effect: 'mutate',
              input: { type: 'object', properties: { followLinks: { type: 'boolean' } }, additionalProperties: false },
            },
          ],
        },
      ],
    },
    scenarios: [
      {
        id: 'reads-before-and-after',
        title: 'Reads the capture, continues it, and reads it again',
        turns: [{ user: 'Read it, follow its links, and read it again', expect: { calls: [{ tool: 'readCapture', times: 2 }] } }],
      },
    ],
  };
  const readTool = {
    name: 'readCapture',
    description: 'Reads a capture.',
    inputSchema: { type: 'object', properties: { captureId: { type: 'string' } }, required: ['captureId'] },
    execute: async () => ({ success: false, error: 'stubbed' }),
  };
  const model = (request: ChatRequest): ScriptedReply | undefined => {
    const answered = lastTool(request);
    if (answered === null) return { toolCalls: [{ id: 'r1', name: 'readCapture', args: { captureId: 'c-1' } }] };
    if (answered.includes('"pages":1')) return { toolCalls: [{ id: 'f1', name: 'ui_act', args: { action: 'site_capture', input: { followLinks: true } } }] };
    if (!answered.includes('"pages"')) return { toolCalls: [{ id: 'r2', name: 'readCapture', args: { captureId: 'c-1' } }] };
    return { text: answered.includes('"pages":3') ? 'It now has 3 pages.' : 'Still 1 page.' };
  };

  it('answers as the backend would once the page action it waits for has run', async () => {
    const config = configFor(tempDir(), {
      suites: [suite],
      channels: { web_chat: {} },
      agent: () => ({
        persona: { name: 'Ava', identity: 'You are Ava.', instructions: [], overrides: { disableUIControlRules: true } },
        tools: [readTool as never],
        toolPolicy: { evaluate: async () => ({ action: 'allow' }) },
      }),
    });
    const { result } = await recordWith(model, () => runEvals(config, { mode: 'record' }));
    const [reads] = result.cases;
    expect(reads.failures).toEqual([]);
    expect(reads.turns[0].reply).toBe('It now has 3 pages.');
  });
});

describe('what a turn showed the person', () => {
  const record = (reply: string, choices: EvalTurnRecord['choices']): EvalTurnRecord =>
    ({ turn: 0, kind: 'user', customer: 'hi', reply, toolCalls: [], approval: null, held: false, modelRequests: 1, usage: {} as never, choices, page: null, invalidToolCalls: [] }) as unknown as EvalTurnRecord;

  it('is its reply, then each choice card: what it says first, its question and its options', () => {
    expect(
      shownToCustomer(
        record('Here is the concept.', [
          {
            question: 'Five more pages are on the site.\n\nShould I read them?',
            options: [{ label: 'Yes, read them', description: 'More screens and proof' }, { label: 'No' }],
          },
        ]),
      ),
    ).toBe('Here is the concept.\n\nFive more pages are on the site.\n\nShould I read them?\n- Yes, read them: More screens and proof\n- No');
    expect(shownToCustomer(record('Done.', []))).toBe('Done.');
  });

  it('is what `says` and `mustNotSay` hold: a question asked on a card is asked, and a card says what it shows', async () => {
    const asked = record('Here is the concept.', [{ question: 'Should I read the linked pages?', options: [{ label: 'Yes' }, { label: 'No' }] }]);
    expect(await check({ says: [{ pattern: 'should i read the linked pages', flags: 'i' }] }, asked, '', null)).toEqual([]);
    const failures = await check({ mustNotSay: ['linked pages'] }, asked, '', null);
    expect(failures.map((f) => f.assertion)).toEqual(['mustNotSay']);
  });
});

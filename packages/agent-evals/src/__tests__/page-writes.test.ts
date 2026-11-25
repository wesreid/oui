/**
 * A page whose writes show, and a page whose rows are named as a host names
 * them (a product's editor eval, recorded live):
 *
 * - a declared surface's state never took what its actions were given: after
 *   the agent wrote two lines, the next observation still showed them empty,
 *   so every model wrote them again or read them back, one to five calls more.
 *   An action that `writes` puts its input into its surface's state once it
 *   succeeds: a field, or a list's row named by key, title or title ignoring
 *   case, as the product's page resolves it. A failed run writes nothing.
 * - `page.ran` held a row's `item` to its literal key, where the product's page
 *   resolves the title the agent gave ("Line 3") to the same row. It now holds
 *   `item` to the row it names, and an `item` that names no row fails, naming it.
 * - a page that opts into neither is the page it was: the same observations,
 *   the same verdicts and the same recording fingerprint.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { conversationOf, messageText, type ChatRequest, type ScriptedReply } from '@ouispec/agent-worker/testing';
import { deriveInputSchema, toolName, type OuiManifest } from '@ouispec/bindings';
import { OUI_READ_ACTION, OUI_RUNTIME_SURFACE, type OUIActionResult } from 'oui-spec/spec';
import type { AgentEvalPage, AgentEvalPageAction, AgentEvalPageWrite, AgentEvalScenario, AgentEvalSuite } from '@ouispec/contract';
import { fingerprint } from '../cassettes.js';
import { createFixturePage, EvalPageError, type EvalPage, type EvalPageRun } from '../page.js';
import { check, runEvals, type EvalTurnRecord } from '../run.js';
import { configFor, recordWith, scratch } from './support.js';

const dirs: Array<() => void> = [];
afterAll(() => dirs.forEach((cleanup) => cleanup()));
const tempDir = () => {
  const s = scratch();
  dirs.push(s.cleanup);
  return s.dir;
};

/** A script's lines, each with its words and its language: a declared surface that opts into nothing. */
const LINES_PAGE = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/lines-page.json', import.meta.url)), 'utf8')) as AgentEvalPage;
const LIST = (name: string): AgentEvalPageWrite => ({ to: ['state', 'lists', name], item: 'item' });

/** The same page, its three actions writing what they are given: each line's words and language, and the script's title. */
function writingPage(writes: Partial<Record<string, AgentEvalPageWrite[]>> = {}): AgentEvalPage {
  const all: Record<string, AgentEvalPageWrite[]> = {
    script_line_text: [LIST('line.text')],
    script_line_language: [LIST('line.language')],
    script_title: [{ to: ['state', 'title'] }],
    ...writes,
  };
  const surface = LINES_PAGE.surfaces![0];
  return {
    ...LINES_PAGE,
    surfaces: [{ ...surface, actions: surface.actions.map((a): AgentEvalPageAction => (all[a.id] ? { ...a, writes: all[a.id] } : a)) }],
  };
}

let requests = 0;
async function execute(page: EvalPage, surfaceId: string, actionId: string, params: Record<string, unknown>): Promise<OUIActionResult> {
  const requestId = `w${++requests}`;
  await page.channel.dispatch('eval-room', { requestId, surfaceId, actionId, params, timestamp: 0 });
  return (await page.channel.awaitResult(requestId, { userId: 'u-1', timeoutMs: 1_000 }))!;
}
const act = (page: EvalPage, actionId: string, params: Record<string, unknown>) => execute(page, 'room:script', actionId, params);
/** The surface's `state` observation as the agent reads it (`oui.read`). */
const stateOf = async (page: EvalPage) =>
  (await execute(page, OUI_RUNTIME_SURFACE, OUI_READ_ACTION, { surface: 'room:script', observation: 'state' })).data as {
    value: { title?: string; lists: Record<string, Array<{ key: string; title: string; value: string }>> };
  };
const valuesOf = async (page: EvalPage, list: string) => Object.fromEntries((await stateOf(page)).value.lists[list].map((r) => [r.key, r.value]));

async function withPage<T>(fixture: AgentEvalPage, run: (page: EvalPage) => Promise<T>): Promise<T> {
  const page = createFixturePage(fixture);
  try {
    return await run(page);
  } finally {
    page.close();
  }
}

describe('an action that writes its input', () => {
  it('shows a list row’s new value in the next observation, the row named by key', async () => {
    await withPage(writingPage(), async (page) => {
      expect((await act(page, 'script_line_text', { item: 'line-2', value: 'Doors open at ten.' })).success).toBe(true);
      expect(await valuesOf(page, 'line.text')).toEqual({ 'line-1': 'Spring is here.', 'line-2': 'Doors open at ten.', 'line-3': '' });
      // The other list, and the rest of the state, are as they were.
      expect(await valuesOf(page, 'line.language')).toEqual({ 'line-1': 'en', 'line-2': 'en', 'line-3': 'en' });
      expect((await stateOf(page)).value).toMatchObject({ saved: 'saved' });
    });
  });

  it('names a row by its exact title, or its title ignoring case, as a host does, and records the run with the row’s key', async () => {
    await withPage(writingPage(), async (page) => {
      expect((await act(page, 'script_line_text', { item: 'Line 3', value: 'Entry is free.' })).success).toBe(true);
      expect((await act(page, 'script_line_text', { item: ' line 2 ', value: 'Doors open at ten.' })).success).toBe(true);
      expect(await valuesOf(page, 'line.text')).toMatchObject({ 'line-2': 'Doors open at ten.', 'line-3': 'Entry is free.' });
      // The page's action received the row's key, as the product's page hands it over, and its cases match it.
      expect(page.ran.map((r) => r.input)).toEqual([
        { item: 'line-3', value: 'Entry is free.' },
        { item: 'line-2', value: 'Doors open at ten.' },
      ]);
      expect(page.rowsOf(page.ran[0])).toEqual([
        { key: 'line-1', title: 'Line 1' },
        { key: 'line-2', title: 'Line 2' },
        { key: 'line-3', title: 'Line 3' },
      ]);
    });
  });

  it('writes a field: the value replaces what is at its path', async () => {
    await withPage(writingPage(), async (page) => {
      expect((await act(page, 'script_title', { value: 'Spring promo' })).success).toBe(true);
      expect((await stateOf(page)).value.title).toBe('Spring promo');
      expect((await act(page, 'script_title', { value: 'Spring fair' })).success).toBe(true);
      expect((await stateOf(page)).value.title).toBe('Spring fair');
    });
  });

  it('writes nothing when its result fails it, or when the case its input holds does', async () => {
    const page = writingPage({ script_title: [{ to: ['state', 'title'] }] });
    const surface = page.surfaces![0];
    const failing: AgentEvalPage = {
      ...page,
      surfaces: [{ ...surface, actions: surface.actions.map((a) => (a.id === 'script_title' ? { ...a, result: { success: false, error: 'The script is locked.' } } : a)) }],
    };
    await withPage(failing, async (p) => {
      // The language action fails by default and succeeds for en and fr (its cases): Italian is not written.
      const italian = await act(p, 'script_line_language', { item: 'Line 3', value: 'it' });
      expect(italian).toMatchObject({ success: false, error: { message: 'Not an option. The languages: en, fr.' } });
      expect(await valuesOf(p, 'line.language')).toEqual({ 'line-1': 'en', 'line-2': 'en', 'line-3': 'en' });
      expect((await act(p, 'script_line_language', { item: 'Line 3', value: 'fr' })).success).toBe(true);
      expect(await valuesOf(p, 'line.language')).toMatchObject({ 'line-3': 'fr' });
      // An action whose result fails it writes nothing.
      expect((await act(p, 'script_title', { value: 'Spring fair' })).success).toBe(false);
      expect((await stateOf(p)).value.title).toBeUndefined();
    });
  });

  it('fails, naming the rows, when its item names no row or several, and writes nothing', async () => {
    await withPage(writingPage(), async (page) => {
      const missing = await act(page, 'script_line_text', { item: 'Line 9', value: 'Nowhere.' });
      expect(missing).toMatchObject({
        success: false,
        error: { code: 'ITEM_NOT_FOUND', message: 'No row "Line 9" is on screen for script_line_text. On screen: "Line 1" (line-1), "Line 2" (line-2), "Line 3" (line-3)' },
      });
      expect(await valuesOf(page, 'line.text')).toEqual({ 'line-1': 'Spring is here.', 'line-2': '', 'line-3': '' });
    });
    const twice = writingPage();
    const lists = (twice.surfaces![0].state!.state as { lists: Record<string, unknown[]> }).lists;
    const shared: AgentEvalPage = {
      ...twice,
      surfaces: [{ ...twice.surfaces![0], state: { state: { lists: { ...lists, 'line.text': [{ key: 'a', title: 'Intro', value: '' }, { key: 'b', title: 'intro', value: '' }] } } } }],
    };
    await withPage(shared, async (page) => {
      const ambiguous = await act(page, 'script_line_text', { item: 'INTRO', value: 'Hello.' });
      expect(ambiguous).toMatchObject({ success: false, error: { code: 'AMBIGUOUS_ITEM', message: 'Several rows are called "INTRO"; give the id instead: "Intro" (a), "intro" (b)' } });
      expect(await valuesOf(page, 'line.text')).toEqual({ a: '', b: '' });
      // By its key, either is written.
      expect((await act(page, 'script_line_text', { item: 'b', value: 'Hello.' })).success).toBe(true);
      expect(await valuesOf(page, 'line.text')).toEqual({ a: '', b: 'Hello.' });
    });
  });

  it('never changes the fixture it was built from: the next case starts from the same page', async () => {
    const fixture = writingPage();
    const before = JSON.stringify(fixture);
    await withPage(fixture, async (page) => {
      await act(page, 'script_line_text', { item: 'line-2', value: 'Doors open at ten.' });
      await act(page, 'script_title', { value: 'Spring fair' });
    });
    expect(JSON.stringify(fixture)).toBe(before);
    await withPage(fixture, async (page) => expect(await valuesOf(page, 'line.text')).toMatchObject({ 'line-2': '' }));
  });

  it('refuses a fixture that writes rows where its surface holds no list', () => {
    expect(() => createFixturePage(writingPage({ script_line_text: [LIST('line.words')] }))).toThrow(EvalPageError);
    expect(() => createFixturePage(writingPage({ script_line_text: [LIST('line.words')] }))).toThrow(
      'the action "script_line_text" of "room:script" writes rows of state › lists › line.words, and its surface’s `state` holds no list there',
    );
  });
});

describe('a page that opts into no writes', () => {
  it('keeps the state its fixture declares, and records the input as given, as before', async () => {
    await withPage(LINES_PAGE, async (page) => {
      expect((await act(page, 'script_line_text', { item: 'Line 2', value: 'Doors open at ten.' })).success).toBe(true);
      expect(await valuesOf(page, 'line.text')).toEqual({ 'line-1': 'Spring is here.', 'line-2': '', 'line-3': '' });
      expect(page.ran.map((r) => r.input)).toEqual([{ item: 'Line 2', value: 'Doors open at ten.' }]);
      expect(page.rowsOf(page.ran[0])).toBeUndefined();
    });
  });
});

// ─── page.ran, as a host resolves a row ──────────────────────────────────────

const ROWS = [
  { key: 'line-1', title: 'Line 1' },
  { key: 'line-2', title: 'Line 2' },
  { key: 'line-3', title: 'Line 3' },
];
const run = (item: string, value = 'Entry is free.'): EvalPageRun => ({ action: 'script_line_text', id: 'script_line_text', surface: 'room:script', input: { item, value }, at: '/scripts/s-1' });
const turnWith = (ran: EvalPageRun[]): EvalTurnRecord =>
  ({ turn: 0, kind: 'user', customer: 'hi', reply: 'Done.', toolCalls: [], approval: null, held: false, modelRequests: 1, usage: {} as never, choices: [], page: { at: '/scripts/s-1', ran }, invalidToolCalls: [] }) as unknown as EvalTurnRecord;
const ranFailures = async (ran: EvalPageRun[], item: string, rowsOf?: (r: EvalPageRun) => readonly { key: string; title: string }[] | undefined) =>
  check({ page: { ran: [{ action: 'script_line_text', input: { item } }] } }, turnWith(ran), '', null, { ...(rowsOf ? { rowsOf } : {}) });

describe('page.ran, where the run addressed a row of a list the page knows', () => {
  const known = () => ROWS;

  it('holds `item` to the row it names: by key, exact title or title ignoring case, either side', async () => {
    expect(await ranFailures([run('line-3')], 'line-3', known)).toEqual([]);
    expect(await ranFailures([run('line-3')], 'Line 3', known)).toEqual([]);
    expect(await ranFailures([run('line-3')], 'line 3', known)).toEqual([]);
    // A run recorded as the agent gave it, by title, holds an expectation by key.
    expect(await ranFailures([run('Line 3')], 'line-3', known)).toEqual([]);
    // The rest of the input is held as before.
    const wrongValue = await check({ page: { ran: [{ action: 'script_line_text', input: { item: 'Line 3', value: 'Doors open at ten.' } }] } }, turnWith([run('line-3')]), '', null, { rowsOf: known });
    expect(wrongValue.map((f) => f.assertion)).toEqual(['page.ran']);
  });

  it('fails a run of another row, and an item that names no row, naming the row it looked for', async () => {
    const other = await ranFailures([run('line-2')], 'Line 3', known);
    expect(other.map((f) => f.message)).toEqual(['script_line_text with {"item":"Line 3"} did not run on the page; it ran script_line_text {"item":"line-2","value":"Entry is free."}']);
    const missing = await ranFailures([run('line-3')], 'line-9', known);
    expect(missing).toEqual([
      {
        assertion: 'page.ran',
        message:
          'script_line_text with {"item":"line-9"} did not run on the page: no row of its list is "line-9" (its rows: "Line 1" (line-1), "Line 2" (line-2), "Line 3" (line-3)); it ran script_line_text {"item":"line-3","value":"Entry is free."}',
      },
    ]);
  });

  it('holds `ranInCase` to the last run of the row it names', async () => {
    const ran = [run('line-3', 'First.'), run('Line 3', 'Entry is free.')];
    expect(await check({ page: { ranInCase: [{ action: 'script_line_text', input: { item: 'line-3', value: 'Entry is free.' } }] } }, turnWith(ran), '', null, { caseRan: ran, rowsOf: known })).toEqual([]);
    const stale = await check({ page: { ranInCase: [{ action: 'script_line_text', input: { item: 'Line 3', value: 'First.' } }] } }, turnWith(ran), '', null, { caseRan: ran, rowsOf: known });
    expect(stale.map((f) => f.assertion)).toEqual(['page.ranInCase']);
  });

  it('is the literal match it was where the page knows no list for the run', async () => {
    expect(await ranFailures([run('line-3')], 'LINE-3')).toEqual([]);
    expect((await ranFailures([run('Line 3')], 'line-3')).map((f) => f.assertion)).toEqual(['page.ran']);
    expect((await ranFailures([run('Line 3')], 'line-3', () => undefined)).map((f) => f.assertion)).toEqual(['page.ran']);
  });
});

describe('a list control’s rows, from the manifest', () => {
  const MANIFEST: OuiManifest = {
    version: 1,
    buildId: 'eval',
    surfaces: [
      {
        id: 'page:script',
        kind: 'page',
        title: 'Script',
        description: 'Its lines.',
        routes: ['/scripts/:scriptId'],
        actions: [
          {
            name: toolName('script.line.text'),
            id: 'script.line.text',
            source: 'control',
            control: 'text',
            itemized: true,
            title: 'What is said',
            description: 'The words of a line',
            effect: 'edit',
            input: deriveInputSchema('text', {}, { itemized: true }),
            reach: [],
            declaredIn: 'script.tsx',
          },
        ],
        observations: [{ id: 'state', description: 'What the page shows.', schema: { type: 'object' } }],
      },
    ],
  };

  it('are what page.ran resolves an item against: an expectation by title holds the run of its row', async () => {
    const page = createFixturePage(
      { at: '/scripts/s-1', navigation: false, controls: { 'script.line.text': { rows: ROWS.map((r) => ({ ...r, value: '' })) } } },
      { manifest: MANIFEST },
    );
    try {
      const done = await execute(page, 'page:script', 'script_line_text', { item: 'Line 2', value: 'Doors open at ten.' });
      expect(done.success).toBe(true);
      // The binding ran the row's control, and the run is the row's key, as before.
      expect(page.ran.map((r) => r.input)).toEqual([{ item: 'line-2', value: 'Doors open at ten.' }]);
      expect(page.rowsOf(page.ran[0])).toEqual(ROWS);
      const record = turnWith(page.ran.slice());
      const by = (item: string) => check({ page: { ran: [{ action: 'script.line.text', input: { item } }] } }, record, '', null, { rowsOf: page.rowsOf });
      expect(await by('line-2')).toEqual([]);
      expect(await by('Line 2')).toEqual([]);
      expect((await by('Line 4')).map((f) => f.message)[0]).toContain('no row of its list is "Line 4"');
    } finally {
      page.close();
    }
  });
});

// ─── Through a whole case: the next step reads what was written ──────────────

/** The page's state as a step was sent it: its `<page_state>` block, the page as it is now. */
const pageStateOf = (request: ChatRequest) =>
  request.messages
    .map((m) => messageText(m))
    .filter((t) => t.startsWith('<page_state>'))
    .join('\n');
const lastTool = (request: ChatRequest) => {
  const last = conversationOf(request).at(-1);
  return last?.role === 'tool' ? messageText(last) : null;
};
const uiAct = (id: string, action: string, input: Record<string, unknown>) => ({ id, name: 'ui_act', args: { action, input } });

const SCENARIO: AgentEvalScenario = {
  id: 'lines',
  title: 'Writes two lines, once each',
  turns: [
    {
      user: 'Write lines 2 and 3.',
      expect: {
        page: {
          ran: [
            { action: 'script_line_text', input: { item: 'line-2' } },
            { action: 'script_line_text', input: { item: 'line-3' } },
          ],
        },
      },
    },
  ],
};

/** A model that writes each line by its title once the page shows the one before it written, then answers from what the page shows. */
function linesModel(request: ChatRequest): ScriptedReply | undefined {
  const state = pageStateOf(request);
  if (lastTool(request) === null) return { toolCalls: [uiAct('c2', 'script_line_text', { item: 'Line 2', value: 'Doors open at ten.' })] };
  if (state.includes('Doors open at ten.') && !state.includes('Entry is free.')) return { toolCalls: [uiAct('c3', 'script_line_text', { item: 'Line 3', value: 'Entry is free.' })] };
  return { text: state.includes('Entry is free.') ? 'Both lines are written.' : 'The page still shows the line empty.' };
}

describe('a case on a page that writes', () => {
  const runOn = async (page: AgentEvalPage) => {
    const suite: AgentEvalSuite = { version: 1, name: 'lines', page, scenarios: [SCENARIO] };
    const config = configFor(tempDir(), { suites: [suite], channels: { web_chat: {} } });
    return { config, ...(await recordWith(linesModel, () => runEvals(config, { mode: 'record' }))) };
  };

  it('sends the step after a write a page state with the line written, and judges the runs by their rows (acceptance)', async () => {
    const { config, result, requests: sent } = await runOn(writingPage());
    const [lines] = result.cases;
    expect(lines.failures).toEqual([]);
    expect(lines.turns[0].reply).toBe('Both lines are written.');
    expect(sent).toHaveLength(3);
    expect(pageStateOf(sent[1])).toContain('Doors open at ten.');
    expect(pageStateOf(sent[2])).toContain('Entry is free.');
    // Replayed, the same page answers the same way.
    expect((await runEvals(config)).cases.map((c) => [c.status, c.failures])).toEqual([['passed', []]]);
  });

  it('on a page that opts into no writes, shows the line empty after the write and judges the title as given, as before', async () => {
    const { result, requests: sent } = await runOn(LINES_PAGE);
    const [lines] = result.cases;
    expect(lines.turns[0].reply).toBe('The page still shows the line empty.');
    expect(pageStateOf(sent[1])).not.toContain('Doors open at ten.');
    expect(lines.failures.map((f) => f.assertion)).toEqual(['page.ran', 'page.ran']);
  });
});

// ─── Fingerprints ────────────────────────────────────────────────────────────

const fingerprintOf = (page: AgentEvalPage) => {
  const scenario: AgentEvalScenario = {
    id: 'lines',
    title: 'Writes two lines',
    page,
    turns: [{ user: 'Write lines 2 and 3.', expect: { page: { ran: [{ action: 'script_line_text', input: { item: 'line-2' } }] } } }],
  };
  return fingerprint({
    systemPrompt: 'You are Ava.',
    tools: [],
    channel: { name: 'web', settings: {} },
    suite: { version: 1, name: 'lines', scenarios: [scenario] },
    scenario,
    page: { fixture: page, manifest: null, knowledge: null },
  });
};

describe('a recording’s fingerprint', () => {
  it('is unchanged for a page that opts into no writes: agent-evals 0.40.0 wrote this one', () => {
    expect(fingerprintOf(LINES_PAGE)).toBe('8a0bf7b7ed5cced62fa3cdbbd5585ead1d46149483c8a9dacb887400c45227a7');
  });

  it('changes when a page opts into writes, so a recording made before replays as stale', () => {
    expect(fingerprintOf(writingPage())).not.toBe(fingerprintOf(LINES_PAGE));
    expect(fingerprintOf(writingPage({ script_title: [{ to: ['state', 'name'] }] }))).not.toBe(fingerprintOf(writingPage()));
  });
});

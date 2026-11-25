/**
 * What stored history keeps of the pages a conversation was on.
 *
 * Nova's assistant (2026-11-25 review, §2.1) took back answers that had been
 * true once the page moved on: every stored UI answer said only "the page as
 * it is now" where its state had been, and the page a turn began on was never
 * stored at all. So an answer keeps a digest of the page it showed (`shown`)
 * beside its state, and a turn keeps a digest of the page its message was sent
 * from (`pageAtStart`). Both are made once and never change, so every answer
 * and every message still reads the same each time it is sent.
 */
import { describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { OUIActionRequest, OUIActionResult, OUIObservationSnapshot, OUISurface } from 'oui-spec/spec';
import type { AgentTurnInput, AgentWorkerConfig, TurnHistoryMessage } from '../types.js';
import { createToolRegistry } from '../tools/types.js';
import type { UIActionChannel } from '../ui/channel.js';
import { PROMPT_CACHE_BREAKPOINTS } from '../model.js';
import { answerWithoutState, STATE_AT_END } from '../ui/page-state-at-end.js';
import { DEFAULT_STATE_DIGEST_CHARS, pageDigest, readStateDigestId, readStateDigestSetting, stateDigestOf } from '../ui/state-digest.js';
import { pageAtStartNote } from '../ui/page-at-start.js';
import { laterAnswerFor } from '../ui/ui-tools.js';
import { stoppedTurnMessages } from '../stop/partial.js';
import { historyOf } from '../history.js';
import { pageOf } from './support/page.js';
import { assertAgentRuntimeConfig } from '../runtime/config.js';

// ─── A page: a lead open beside the list of leads, in an app shell ──────────────────────────────────────────

const LEAD = 'page:lead';
const SHELL = 'shell:app';

const lead = (name: string, source: string, vehicle: string) => ({
  id: 'leads.detail',
  title: 'Lead',
  facts: { Name: name, Source: source, Vehicle: vehicle },
});
const leadRow = (key: string, title: string) => ({ key, title });

function observationsOf(open: { name: string; source: string; vehicle: string }): OUIObservationSnapshot {
  return {
    [SHELL]: { state: { values: {}, lists: { 'nav.accounts': [leadRow('a1', 'Main store'), leadRow('a2', 'Second store')] }, unavailable: [] } },
    [LEAD]: {
      state: {
        values: { 'leads.note': 'call back' },
        lists: {
          'leads.open': [
            leadRow('l1', 'Maria Alvarez'),
            leadRow('l2', 'Tom Lee'),
            leadRow('l3', 'Ana Diaz'),
            leadRow('l4', 'Sam Roe'),
          ],
        },
        unavailable: [],
        shown: [lead(open.name, open.source, open.vehicle)],
      },
      problems: [],
    },
  };
}

const MARIA = { name: 'Maria Alvarez', source: 'Website', vehicle: '2021 Rogue S' };
const TOM = { name: 'Tom Lee', source: 'Walk-in', vehicle: '2023 Kicks SV' };

const surface: OUISurface = {
  id: LEAD,
  name: 'Lead',
  description: 'one lead, beside the list of open leads',
  actions: [
    {
      id: 'leads_open',
      description: 'Open a lead',
      input: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    },
  ],
  observations: [{ id: 'state', description: 'what the page shows' }],
};
const shell: OUISurface = { id: SHELL, name: 'App', description: 'the app around every page', actions: [] };

// ─── The default digest ─────────────────────────────────────────────────────────────────────────────────────

describe('the default digest of a page', () => {
  const schemas = {};

  it('gives the surface acted on first, each display’s facts by label, each list’s count and first rows, and the shells last', () => {
    expect(pageDigest(observationsOf(MARIA), { surfaceId: LEAD, schemas })).toBe(
      'page:lead — Lead (Name: Maria Alvarez; Source: Website; Vehicle: 2021 Rogue S); leads.open: 4 (Maria Alvarez, Tom Lee, Ana Diaz, …)' +
        ' | shell:app — nav.accounts: 2 (Main store, Second store)',
    );
    // Acted on in the shell, the shell comes first.
    expect(pageDigest(observationsOf(MARIA), { surfaceId: SHELL, schemas })).toMatch(/^shell:app — nav\.accounts/);
  });

  it('is the same every time it is made from the same page', () => {
    const one = pageDigest(observationsOf(MARIA), { surfaceId: null, schemas });
    expect(pageDigest(structuredClone(observationsOf(MARIA)), { surfaceId: null, schemas })).toBe(one);
  });

  it('names a declared list’s rows by the title its schema declares, and a display of many rows by their titles', () => {
    const observations: OUIObservationSnapshot = {
      'room:editor': {
        layers: { items: [{ id: 'g1', label: 'Ruth on the beach' }, { id: 'g2', label: 'Ruth in the forest' }] },
        'room:editor:export:status': { status: 'running' },
      },
      [LEAD]: {
        state: {
          values: {},
          lists: {},
          shown: [
            { id: 'cards', title: 'Vehicles', facts: { Price: '$24,990' }, item: { key: 'v1', title: '2021 Rogue S' } },
            { id: 'cards', title: 'Vehicles', facts: { Price: '$21,500' }, item: { key: 'v2', title: '2023 Kicks SV' } },
          ],
        },
      },
    };
    const declared = { 'room:editor': { layers: { properties: { items: { 'x-rows': { ref: 'id', title: 'label' } } } } } };
    expect(pageDigest(observations, { surfaceId: 'room:editor', schemas: declared })).toBe(
      'room:editor — layers.items: 2 (Ruth on the beach, Ruth in the forest) | page:lead — Vehicles: 2 (2021 Rogue S, 2023 Kicks SV)',
    );
  });

  it('holds to its bound, 600 characters unless the host sets one, and says where it was cut', () => {
    const many: OUIObservationSnapshot = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [
        `page:p${i}`,
        { state: { values: {}, lists: {}, shown: [lead(`Person ${i} ${'x'.repeat(60)}`, 'Website', '2021 Rogue S')] } },
      ]),
    );
    const digest = pageDigest(many, { surfaceId: null, schemas });
    expect(digest.length).toBeLessThanOrEqual(DEFAULT_STATE_DIGEST_CHARS);
    expect(digest.length).toBeGreaterThan(DEFAULT_STATE_DIGEST_CHARS - 40);
    expect(digest.endsWith('…')).toBe(true);
    expect(digest.startsWith('page:p0 — Lead (Name: Person 0')).toBe(true);
    expect(pageDigest(many, { surfaceId: null, schemas }, 120).length).toBeLessThanOrEqual(120);
    // A fact's value is cut on its own, so one long value never takes the whole digest.
    const long = pageDigest({ [LEAD]: { state: { shown: [lead('y'.repeat(500), 'Website', 'Rogue')] } } }, { surfaceId: null, schemas });
    expect(long).toContain('Source: Website');
  });

  it('is empty for a page that shows nothing it can say', () => {
    expect(pageDigest({ [LEAD]: { state: { values: { a: 1 }, lists: {}, unavailable: [] }, problems: [] } }, { surfaceId: null, schemas })).toBe('');
    expect(stateDigestOf({ [LEAD]: { state: { values: {}, lists: {} } } }, { surfaceId: null, schemas, at: 'answer' }, undefined, undefined)).toBeNull();
  });
});

describe('the host’s digest', () => {
  const context = { surfaceId: LEAD, schemas: {}, at: 'answer' as const };

  it('is used as it says, given the observations, the surface acted on and the schemas, and cut to the bound', () => {
    const digest = vi.fn(() => 'Open lead: Maria Alvarez (Website), 2021 Rogue S');
    expect(stateDigestOf(observationsOf(MARIA), context, digest, undefined)).toBe('Open lead: Maria Alvarez (Website), 2021 Rogue S');
    expect(digest).toHaveBeenCalledWith(observationsOf(MARIA), context);
    const long = stateDigestOf(observationsOf(MARIA), context, () => 'z '.repeat(1_000), 50)!;
    expect(long.length).toBeLessThanOrEqual(50);
    expect(long.endsWith('…')).toBe(true);
  });

  it('keeps no digest when it says null, fails, or gives something that is not text; `false` keeps none', () => {
    const warn = vi.fn();
    expect(stateDigestOf(observationsOf(MARIA), context, () => null, undefined, warn)).toBeNull();
    expect(stateDigestOf(observationsOf(MARIA), context, () => '   ', undefined, warn)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(
      stateDigestOf(observationsOf(MARIA), context, () => {
        throw new Error('no lead');
      }, undefined, warn),
    ).toBeNull();
    expect(stateDigestOf(observationsOf(MARIA), context, (() => 42) as never, undefined, warn)).toBeNull();
    expect(warn.mock.calls.map((c) => c[1])).toEqual([
      'The host’s page digest failed; the page is kept without one',
      'The host’s page digest is not text; the page is kept without one',
    ]);
    expect(stateDigestOf(observationsOf(MARIA), context, false, undefined)).toBeNull();
  });

  it('is refused before any turn when it is neither a function nor false', () => {
    expect(readStateDigestSetting(undefined)).toBeUndefined();
    expect(readStateDigestSetting(false)).toBe(false);
    expect(() => readStateDigestSetting(true)).toThrow(/ui\.stateDigest must be a function, false, or left out, not boolean/);
    expect(() => readStateDigestSetting('short')).toThrow(/not string/);
    const runtime = {
      model: 'm' as never,
      realtime: { url: 'https://rt.example', apiKey: 'k' },
      systemPrompt: () => 'p',
      tools: [],
      getDb: async () => null,
      getHistory: async () => [],
      persistMessages: async () => {},
    };
    expect(() => assertAgentRuntimeConfig({ ...runtime, uiActions: { stateDigest: 'short' as never } })).toThrow(/ui\.stateDigest/);
    // Its name, which recordings are fingerprinted by, is a non-empty string when given.
    expect(readStateDigestId(undefined)).toBeUndefined();
    expect(readStateDigestId('lead-facts-v1')).toBe('lead-facts-v1');
    expect(() => readStateDigestId('  ')).toThrow(/ui\.stateDigestId must be a non-empty string naming what stateDigest writes, not an empty string/);
    expect(() => readStateDigestId(2)).toThrow(/not number/);
    expect(() => assertAgentRuntimeConfig({ ...runtime, uiActions: { stateDigest: () => null, stateDigestId: '' } })).toThrow(/ui\.stateDigestId/);
    expect(() => assertAgentRuntimeConfig({ ...runtime, uiActions: { stateDigest: () => null, stateDigestId: 'lead-facts-v1' } })).not.toThrow();
    expect(() => assertAgentRuntimeConfig({ ...runtime, uiActions: { stateDigest: false } })).not.toThrow();
  });
});

// ─── Stored answers ─────────────────────────────────────────────────────────────────────────────────────────

describe('an answer’s digest in what is stored', () => {
  const answer = JSON.stringify({ result: { ok: true }, page: { surfaces: ['Lead'] }, shown: 'page:lead — Lead (Name: Maria Alvarez)', state: { big: true } });

  it('survives answerWithoutState: only the state is taken out, and giving it up again changes nothing', () => {
    const stored = answerWithoutState(answer);
    expect(JSON.parse(stored)).toEqual({ result: { ok: true }, page: { surfaces: ['Lead'] }, shown: 'page:lead — Lead (Name: Maria Alvarez)', pageState: STATE_AT_END });
    expect(answerWithoutState(stored)).toBe(stored);
  });

  it('survives a stopped turn’s store', () => {
    const [, result] = stoppedTurnMessages({
      steps: [{ text: '', toolCalls: [{ toolCallId: 'c1', toolName: 'ui_act', input: { action: 'leads_open' } }] }],
      calls: [{ toolCallId: 'c1', toolName: 'ui_act', input: { action: 'leads_open' }, text: answer }],
      streamedText: '',
      marker: { reason: 'user_stop', at: 1 },
    });
    expect(result.content).toBe(answerWithoutState(answer));
    expect(JSON.parse(result.content!)).toMatchObject({ shown: 'page:lead — Lead (Name: Maria Alvarez)' });
    expect(result.content).not.toContain('"state"');
  });

  it('is in the answer to work that ended after its turn, made from the page the work ended on', () => {
    const final: OUIActionResult = { requestId: 'call-1', success: true, timestamp: 1, data: { done: true }, observations: observationsOf(TOM) };
    const page = pageOf([surface, shell]);
    const later = laterAnswerFor(final, { actionId: 'leads_open' }, page);
    expect((later.data as { shown: string }).shown).toBe(pageDigest(observationsOf(TOM), { surfaceId: LEAD, schemas: {} }));
    expect(laterAnswerFor(final, { actionId: 'leads_open' }, page, { stateDigest: false }).data).not.toHaveProperty('shown');
    expect((laterAnswerFor(final, { actionId: 'leads_open' }, page, { stateDigest: () => 'Tom Lee' }).data as { shown: string }).shown).toBe('Tom Lee');
  });
});

// ─── Through turns ──────────────────────────────────────────────────────────────────────────────────────────

type PromptMessage = { role: string; content: unknown; providerOptions?: Record<string, unknown> };
const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };

/** A model that makes these calls, one step each, then answers; each step's prompt is kept. */
function scripted(calls: Array<{ toolName: string; input: unknown }>) {
  const prompts: PromptMessage[][] = [];
  const model = new MockLanguageModelV4({
    doStream: async (options: { prompt: unknown }) => {
      prompts.push(structuredClone(options.prompt) as PromptMessage[]);
      const call = calls[prompts.length - 1];
      const chunks = call
        ? [
            { type: 'stream-start', warnings: [] },
            { type: 'tool-call', toolCallId: `call-${prompts.length}`, toolName: call.toolName, input: JSON.stringify(call.input) },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage },
          ]
        : [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: '0' },
            { type: 'text-delta', id: '0', delta: 'Done.' },
            { type: 'text-end', id: '0' },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'end_turn' }, usage },
          ];
      return { stream: simulateReadableStream({ chunks: chunks as never[] }) };
    },
  } as never);
  return { model, prompts };
}

/** The tab: opening a lead shows it. */
function tab() {
  const sent: OUIActionRequest[] = [];
  const channel: UIActionChannel = {
    dispatch: vi.fn(async (_room, request) => {
      sent.push(request);
    }),
    awaitResult: vi.fn(async (requestId): Promise<OUIActionResult | null> => {
      const request = sent.find((r) => r.requestId === requestId);
      if (!request) return null;
      return { requestId, success: true, timestamp: 1, data: { opened: request.params.value }, observations: observationsOf(TOM) };
    }),
  };
  return { channel, sent };
}

const openTom = { toolName: 'ui_act', input: { action: 'leads_open', input: { value: 'l2' } } };

async function turn(model: unknown, overrides: Partial<AgentTurnInput> = {}, ui: Partial<NonNullable<AgentWorkerConfig['ui']>> = {}) {
  const beforeTurnComplete = vi.fn(async () => {});
  const config: AgentWorkerConfig = {
    tools: createToolRegistry([]),
    emit: { emit: vi.fn(async () => {}) },
    model: model as AgentWorkerConfig['model'],
    promptCacheBreakpoint: PROMPT_CACHE_BREAKPOINTS.bedrock,
    systemPrompt: 'You are the assistant.',
    ui: { channel: tab().channel, resultTimeoutMs: 500, ...ui },
    beforeTurnComplete,
  };
  const input: AgentTurnInput = {
    turnId: 'turn-1',
    conversationId: 'conv-1',
    userId: 'user-1',
    accountId: 'acct-1',
    socketRoom: 'agent:turn:turn-1',
    content: 'Open Tom’s lead',
    history: [{ role: 'user', content: 'Open Tom’s lead' }],
    context: { oui: { surfaces: [surface, shell], observations: observationsOf(MARIA) } },
    ...overrides,
  };
  const { runAgentTurn } = await import('../orchestrator.js');
  const result = await runAgentTurn(config, input);
  return { result, beforeTurnComplete };
}

const isTail = (m: PromptMessage) => JSON.stringify(m.providerOptions ?? {}).includes('"stepTail":true');
const isTurnContext = (m: PromptMessage) => JSON.stringify(m.providerOptions ?? {}).includes('"turnContext":true');
const conversation = (prompt: PromptMessage[]) => prompt.filter((m) => m.role !== 'system' && !isTail(m) && !isTurnContext(m));
const textOf = (m: PromptMessage) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
/** The text of the result the model was sent for a call. */
function resultSent(prompt: PromptMessage[], callId: string): string | undefined {
  for (const m of prompt) {
    if (m.role !== 'tool') continue;
    for (const part of m.content as Array<{ type: string; toolCallId: string; output: { value: string } }>) {
      if (part.type === 'tool-result' && part.toolCallId === callId) return part.output.value;
    }
  }
  return undefined;
}
/** The text of the person's message in a prompt (a string, or its text parts). */
function userText(m: PromptMessage): string {
  if (typeof m.content === 'string') return m.content;
  return (m.content as Array<{ type: string; text?: string }>).filter((p) => p.type === 'text').map((p) => p.text).join('');
}

describe('a turn on a page, and the turn after it', () => {
  it('stores each answer with the digest of the page it showed, sent and stored byte for byte the same', async () => {
    const { model, prompts } = scripted([openTom]);
    const { result } = await turn(model);

    const stored = result.newMessages.find((m) => m.role === 'tool')!;
    const answer = JSON.parse(stored.content!) as Record<string, unknown>;
    expect(answer.shown).toBe(pageDigest(observationsOf(TOM), { surfaceId: LEAD, schemas: {} }));
    expect(answer.shown).toContain('Name: Tom Lee');
    expect(answer).not.toHaveProperty('state');
    expect(answer.pageState).toBe(STATE_AT_END);
    // Sent the same as it is stored, at the step after it.
    expect(resultSent(prompts[1], 'call-1')).toBe(stored.content);

    // The next turn reads the answer from the history the host stored: the same words, and the page it showed.
    const next = scripted([]);
    const history: TurnHistoryMessage[] = [
      { role: 'user', content: 'Open Tom’s lead', pageAtStart: result.pageAtStart },
      ...historyOf(result.newMessages),
      { role: 'user', content: 'Which car was he looking at?' },
    ];
    await turn(next.model, { turnId: 'turn-2', content: 'Which car was he looking at?', history, context: {} });
    expect(resultSent(next.prompts[0], 'call-1')).toBe(stored.content);
    expect(resultSent(next.prompts[0], 'call-1')).toContain('Vehicle: 2023 Kicks SV');
  });

  it('keeps the page the turn began on with its message: given to the host, sent with the message, and read the same next turn', async () => {
    const { model, prompts } = scripted([openTom]);
    const { result, beforeTurnComplete } = await turn(model);

    const digest = pageDigest(observationsOf(MARIA), { surfaceId: null, schemas: {} });
    expect(digest).toMatch(/^page:lead — Lead \(Name: Maria Alvarez; Source: Website; Vehicle: 2021 Rogue S\)/);
    expect(result.pageAtStart).toBe(digest);
    expect(beforeTurnComplete).toHaveBeenCalledWith(expect.objectContaining({ pageAtStart: digest }));

    // Every step of the turn sends the message with its note, in the same words.
    for (const prompt of prompts) {
      const message = conversation(prompt).find((m) => m.role === 'user')!;
      expect(userText(message)).toBe(`Open Tom’s lead\n\n${pageAtStartNote(digest)}`);
    }

    // The next turn, on another page, reads turn one's message exactly as turn one sent it: the cache reads it.
    const next = scripted([]);
    const history: TurnHistoryMessage[] = [
      { role: 'user', content: 'Open Tom’s lead', pageAtStart: result.pageAtStart },
      ...historyOf(result.newMessages),
      { role: 'user', content: 'Why did you lead with the Rogue?' },
    ];
    const { result: second } = await turn(next.model, {
      turnId: 'turn-2',
      content: 'Why did you lead with the Rogue?',
      history,
      context: { oui: { surfaces: [surface, shell], observations: observationsOf(TOM) } },
    });
    const before = conversation(prompts.at(-1)!);
    const now = conversation(next.prompts[0]);
    expect(textOf(now[0])).toBe(textOf(before[0]));
    expect(userText(now[0])).toContain('Vehicle: 2021 Rogue S');
    // Its own message carries its own page.
    expect(userText(now.at(-1)!)).toBe(`Why did you lead with the Rogue?\n\n${pageAtStartNote(second.pageAtStart!)}`);
    expect(second.pageAtStart).toContain('Name: Tom Lee');
  });

  it('uses the host’s digest; null keeps none for that page, and false keeps none at all', async () => {
    const host = vi.fn((observations: OUIObservationSnapshot, { at }: { at: string }) => {
      const open = (observations[LEAD]?.state as { shown: Array<{ facts: Record<string, string> }> }).shown[0].facts;
      return at === 'answer' ? `Opened: ${open.Name}` : null;
    });
    const one = scripted([openTom]);
    const { result } = await turn(one.model, {}, { stateDigest: host });
    expect(JSON.parse(result.newMessages.find((m) => m.role === 'tool')!.content!).shown).toBe('Opened: Tom Lee');
    expect(result.pageAtStart).toBeUndefined();
    expect(host).toHaveBeenCalledWith(observationsOf(TOM), expect.objectContaining({ surfaceId: LEAD, at: 'answer' }));
    expect(host).toHaveBeenCalledWith(observationsOf(MARIA), expect.objectContaining({ surfaceId: null, at: 'pageAtStart' }));
    expect(userText(conversation(one.prompts[0])[0])).toBe('Open Tom’s lead');

    const off = scripted([openTom]);
    const { result: none, beforeTurnComplete } = await turn(off.model, {}, { stateDigest: false });
    expect(JSON.parse(none.newMessages.find((m) => m.role === 'tool')!.content!)).not.toHaveProperty('shown');
    expect(none.pageAtStart).toBeUndefined();
    expect(beforeTurnComplete.mock.calls[0][0]).not.toHaveProperty('pageAtStart');
    expect(userText(conversation(off.prompts[0])[0])).toBe('Open Tom’s lead');
  });

  it('holds the digest to the host’s bound', async () => {
    const { model } = scripted([openTom]);
    const { result } = await turn(model, {}, { maxStateDigestChars: 60 });
    expect(result.pageAtStart!.length).toBeLessThanOrEqual(60);
    expect(JSON.parse(result.newMessages.find((m) => m.role === 'tool')!.content!).shown.length).toBeLessThanOrEqual(60);
  });

  it('keeps no page on a turn with no message of the person’s, or no page', async () => {
    const approval = scripted([]);
    const { result: approved } = await turn(approval.model, {
      content: '',
      history: [],
      approval: { approvalId: 'a-1', decision: 'decline' },
    });
    expect(approved.pageAtStart).toBeUndefined();

    const noPage = scripted([]);
    const { result: plain } = await turn(noPage.model, { context: {} });
    expect(plain.pageAtStart).toBeUndefined();
    expect(userText(conversation(noPage.prompts[0])[0])).toBe('Open Tom’s lead');
  });
});

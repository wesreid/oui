/**
 * How much the agent says while it works, through a whole turn: the runtime a
 * host creates (`createAgentTurnRunner` with a persona), the real orchestrator
 * and `ai` loop, and a model scripted through the real `@ai-sdk/openai`
 * package. The artifact checked is the request the provider sends the model.
 *
 * A host that says how much (`narration: 'host'`) sends its instruction with
 * the turn, in its history's `stepContext`. The model is sent rules that defer
 * to it, and the instruction in the turn's context, after the person's words;
 * the system prompt is the same whatever the instruction says, so a change of
 * level keeps the cached conversation. A host that names no narration sends
 * exactly the system prompt it sent before the option existed.
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createOpenAI } from '@ai-sdk/openai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentTurnRunner } from '../runtime/turn-runner.js';
import { NARRATION_INSTRUCTION, type NarrationSetting } from '../prompt/rules/narration.js';
import { scriptedChatCompletions, type ChatRequest } from '../testing/scripted.js';
import type { AgentPersonaConfig } from '../prompt/types.js';
import type { AgentRuntimeConfig, AgentTurnPayload } from '../runtime/types.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const SAID = 'Find me a blue RAV4 under thirty thousand and put it on my shortlist.';
const REPLY = 'For a shortlist we use **Saved cars**, under My garage. I found a 2024 blue RAV4 at $28,900 and saved it there.';
/** What a host that lets the person choose might send at its most talkative level. */
const EXPLAIN =
  '## How you talk while you work: explain as you go\n- Before each distinct step, say in one or two sentences what you will do and why.';
const QUIET = '## How you talk while you work: results only\n- Write nothing while you work. Give the result, in words, at the end.';

// ─── The realtime server: takes what the turn sends its room ─────────────────

let realtime: http.Server;
let realtimeUrl: string;
beforeAll(async () => {
  realtime = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'));
  });
  await new Promise<void>((resolve) => realtime.listen(0, '127.0.0.1', resolve));
  realtimeUrl = `http://127.0.0.1:${(realtime.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => realtime.close(() => resolve()));
});

// ─── The product ─────────────────────────────────────────────────────────────

const persona = (narration?: NarrationSetting, narrationDefault?: string): AgentPersonaConfig => ({
  name: 'Deos',
  identity: 'You are Deos, the assistant at a car dealership.',
  instructions: ['Quote only the dealer price.'],
  overrides: { disableUIControlRules: true, ...(narration ? { narration } : {}), ...(narrationDefault !== undefined ? { narrationDefault } : {}) },
});

/** The host's default level, as the lines it states once in the system prompt (`narrationDefault`). */
const EXPLAIN_DEFAULT = '- Before each distinct step, say in one or two sentences what you will do and why.';

/** A runtime as a host creates it, whose history carries `stepContext`; the requests its model was sent, in order. */
function product(narration: NarrationSetting | undefined, stepContext: string | null, narrationDefault?: string) {
  const scripted = scriptedChatCompletions(() => ({ text: REPLY }));
  const config: AgentRuntimeConfig<object> = {
    model: createOpenAI({ apiKey: 'fixture-scripted-key', fetch: scripted.fetch }).chat('gpt-fixture'),
    realtime: { url: realtimeUrl, apiKey: 'realtime-key' },
    persona: persona(narration, narrationDefault),
    tools: [],
    getDb: async () => ({}),
    getHistory: async () => ({ messages: [{ role: 'user', content: SAID }], stepContext }),
    persistMessages: async () => {},
    logger: quiet,
    approvals: { store: { create: async () => {}, redeem: async () => ({ ok: false, reason: 'used', error: 'used' }), status: async () => null } },
    stops: { client: { watch: (_t, _u, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(null), { once: true })) } },
    uiActions: { channel: { request: async () => ({ success: false, error: 'not used' }) } as never },
  };
  return { runner: createAgentTurnRunner(config), requests: scripted.requests };
}

const TURN: AgentTurnPayload = {
  turnId: 'turn-narration-1',
  conversationId: 'conv-1',
  userId: 'visitor-1',
  accountId: 'rooftop-1',
  socketRoom: 'conversation:conv-1',
  content: SAID,
  context: { currentPath: '/inventory', timeZone: 'Europe/Paris' },
};

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((p: { text?: string }) => p.text ?? '').join('\n') : '';
const systemOf = (request: ChatRequest) => request.messages.filter((m) => m.role === 'system' || m.role === 'developer').map((m) => textOf(m.content)).join('\n');
/** The turn's context: the user-role block that carries the clock, after the person's words. */
const turnContextOf = (request: ChatRequest) => {
  const users = request.messages.filter((m) => m.role === 'user').map((m) => textOf(m.content));
  return users.find((t) => t.includes('<now>')) ?? '';
};

async function turnWith(narration: NarrationSetting | undefined, stepContext: string | null, narrationDefault?: string) {
  const { runner, requests } = product(narration, stepContext, narrationDefault);
  const outcome = await runner.run(TURN, { channel: 'chat' });
  expect(outcome).toMatchObject({ status: 'completed', turnId: TURN.turnId });
  expect(requests).toHaveLength(1);
  return requests[0];
}

describe('a host that says how much, through a turn', () => {
  it('sends rules that defer to its instruction, and the instruction with the turn, after the person’s words (acceptance)', async () => {
    const request = await turnWith('host', EXPLAIN);
    const system = systemOf(request);
    expect(system).toContain('### How Much You Say While You Work');
    expect(system).toContain(NARRATION_INSTRUCTION);
    expect(system).not.toContain('write at most one brief line meant for the user');
    expect(system).not.toContain('Do NOT emit filler text between tool rounds.');
    expect(system).not.toContain('pivot immediately to an alternative without narrating each failure');
    // The instruction is in the turn's context, never in the system prompt.
    expect(system).not.toContain('explain as you go');
    expect(turnContextOf(request)).toContain(EXPLAIN);
    const said = request.messages.findIndex((m) => m.role === 'user' && textOf(m.content).includes(SAID));
    const context = request.messages.findIndex((m) => m.role === 'user' && textOf(m.content).includes(EXPLAIN));
    expect(said).toBeGreaterThanOrEqual(0);
    expect(context).toBeGreaterThanOrEqual(said);
  });

  it('sends the same system prompt whatever its instruction says, so a change of level keeps the cached conversation', async () => {
    const explain = await turnWith('host', EXPLAIN);
    const quietTurn = await turnWith('host', QUIET);
    const none = await turnWith('host', null);
    expect(systemOf(quietTurn)).toBe(systemOf(explain));
    expect(systemOf(none)).toBe(systemOf(explain));
    expect(turnContextOf(quietTurn)).toContain(QUIET);
    expect(turnContextOf(none)).not.toContain('How you talk while you work');
  });
});

describe('a host that states its default level, through a turn', () => {
  it('sends the default in the system prompt and no instruction at that level, and an instruction that replaces it at another (acceptance)', async () => {
    const atDefault = await turnWith('host', null, EXPLAIN_DEFAULT);
    const system = systemOf(atDefault);
    expect(system).toContain(`unless the turn comes with ${NARRATION_INSTRUCTION}, which then replaces it:\n${EXPLAIN_DEFAULT}`);
    // The default replaces the one-brief-line fallback, and the turn carries no instruction of its own.
    expect(system).not.toContain('Without one, write at most one brief line');
    expect(turnContextOf(atDefault)).not.toContain('How you talk while you work');
    // Another level sends its instruction with the turn; the system prompt is the same, so the cache holds.
    const quietTurn = await turnWith('host', QUIET, EXPLAIN_DEFAULT);
    expect(systemOf(quietTurn)).toBe(system);
    expect(turnContextOf(quietTurn)).toContain(QUIET);
  });

  it('refuses a default with no host narration, or an empty one, when the runtime is created', () => {
    expect(() => product(undefined, null, EXPLAIN_DEFAULT)).toThrow(/narrationDefault is the host's default amount: it needs narration: 'host'/);
    expect(() => product('brief', null, EXPLAIN_DEFAULT)).toThrow(/needs narration: 'host'/);
    expect(() => product('host', null, '  ')).toThrow(/narrationDefault must be the text of the default amount/);
  });
});

describe('a host that names no narration, through a turn', () => {
  it('sends exactly the system prompt it sent before the option existed: one brief line, fixed by the SDK', async () => {
    const request = await turnWith(undefined, null);
    const system = systemOf(request);
    // The communication rules the earlier release wrote, byte for byte (fixtures/communication).
    expect(system).toContain(readFileSync(fileURLToPath(new URL('./fixtures/communication/rules.conversational.markdown.txt', import.meta.url)), 'utf8'));
    expect(system).toContain('write at most one brief line meant for the user ("Let me check that for you."), or nothing at all');
    expect(system).not.toContain(NARRATION_INSTRUCTION);
    expect(systemOf(await turnWith('brief', null))).toBe(system);
  });

  it('refuses a setting it does not know when the runtime is created, before any turn', () => {
    expect(() => product('explain' as never, null)).toThrow(/narration must be one of brief, host, not "explain"/);
  });
});

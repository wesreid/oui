/**
 * A turn's rounds are announced, through the real `ai` loop: each piece of
 * text names its round (`step`), and each round's end follows all of its text
 * (`agent:round_end`), saying whether it called tools and whether it is the
 * turn's last word. A consumer that speaks only what the turn ends with (the
 * live-call handler's `speak: 'final-round'`) holds a round's text until its
 * end and keeps it when `final`, so the model's words before a tool call are
 * never spoken. Only the model is a stand-in.
 */
import { describe, expect, it, vi } from 'vitest';
import { AGENT_SOCKET_EVENTS } from '@ouispec/agent-core';
import { runAgentTurn } from '../orchestrator.js';
import { createToolRegistry, type RegisteredTool } from '../tools/types.js';
import { loadBuiltinTools } from '../tools/builtin-tools.js';
import type { ApprovalStoreClient } from '../approvals/client.js';
import type { AgentWorkerConfig } from '../types.js';
import { respondingOpenAI, type ScriptedReply } from './support/replay.js';

const lookup: RegisteredTool = {
  name: 'inventory_search',
  description: 'Searches the inventory.',
  effect: 'view',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  execute: vi.fn(async () => ({ success: true, data: { matches: 2 } })),
};

const book: RegisteredTool = {
  name: 'visit_book',
  title: 'Book a visit',
  description: 'Books a visit with the sales team.',
  effect: { kind: 'transaction' },
  inputSchema: { type: 'object', properties: { day: { type: 'string', title: 'Day' } } },
  execute: vi.fn(async () => ({ success: true })),
};

const store: ApprovalStoreClient = {
  create: async () => {},
  redeem: async () => ({ ok: false, reason: 'used', error: 'used' }),
  status: async () => null,
};

type Seen = { event: string; data: Record<string, unknown> };

/** Runs a turn the model answers with `replies`, and returns every event it emitted, in order. */
async function rounds(replies: ScriptedReply[], extra: Partial<AgentWorkerConfig> = {}) {
  const m = respondingOpenAI((_request, i) => replies[i]);
  const seen: Seen[] = [];
  const result = await runAgentTurn(
    {
      tools: createToolRegistry([lookup, book, ...loadBuiltinTools().filter((t) => t.name === 'present_options')]),
      emit: { emit: async (_room, event, data) => void seen.push({ event, data: data as Record<string, unknown> }) },
      systemPrompt: 'You help on a dealer’s site.',
      model: m.model,
      approvals: store,
      ...extra,
    },
    { turnId: 'turn-rounds', conversationId: 'c1', userId: 'u1', accountId: 'a1', socketRoom: 'agent:turn:turn-rounds', content: 'Any blue RAV4s?' },
  );
  /** The text and round ends, as `step:text` and `end:step:calledTools:final`, in the order they were sent. */
  const sequence = seen.flatMap(({ event, data }) =>
    event === AGENT_SOCKET_EVENTS.TOKEN
      ? [`${data.step}:${data.text}`]
      : event === AGENT_SOCKET_EVENTS.ROUND_END
        ? [`end:${data.step}:${data.calledTools}:${data.final}`]
        : [],
  );
  return { seen, result, sequence: joinPieces(sequence) };
}

/** Consecutive text of one round, as one entry: the stream coalesces pieces however it likes. */
function joinPieces(sequence: string[]): string[] {
  const out: string[] = [];
  for (const entry of sequence) {
    const prev = out.at(-1);
    const step = entry.split(':')[0];
    if (prev && !entry.startsWith('end:') && !prev.startsWith('end:') && prev.split(':')[0] === step) {
      out[out.length - 1] = prev + entry.slice(step.length + 1);
    } else out.push(entry);
  }
  return out;
}

describe('the rounds of a turn', () => {
  it('name each piece of text’s round, and end each round after its text: only the last is final', async () => {
    const { sequence, result } = await rounds([
      { text: 'Let me check the lot.', toolCalls: [{ id: 'call_1', name: 'inventory_search', args: { query: 'blue RAV4' } }] },
      { text: 'We have two blue RAV4s in stock.' },
    ]);
    expect(sequence).toEqual([
      '0:Let me check the lot.',
      'end:0:true:false',
      // The paragraph break belongs to the text that follows it.
      '1:\n\nWe have two blue RAV4s in stock.',
      'end:1:false:true',
    ]);
    expect(result.stopReason).toBe('complete');
  });

  it('end a round that said nothing too, and end it before the next round’s text', async () => {
    const { sequence } = await rounds([
      { toolCalls: [{ id: 'call_1', name: 'inventory_search', args: { query: 'blue' } }] },
      { toolCalls: [{ id: 'call_2', name: 'inventory_search', args: { query: 'RAV4' } }] },
      { text: 'Two match.' },
    ]);
    expect(sequence).toEqual(['end:0:true:false', 'end:1:true:false', '2:Two match.', 'end:2:false:true']);
  });

  it('send a round’s tool call after its text and before its end', async () => {
    const { seen } = await rounds([
      { text: 'Checking.', toolCalls: [{ id: 'call_1', name: 'inventory_search', args: {} }] },
      { text: 'Done.' },
    ]);
    const order = seen
      .filter((e) => [AGENT_SOCKET_EVENTS.TOKEN, AGENT_SOCKET_EVENTS.TOOL_CALL_STARTED, AGENT_SOCKET_EVENTS.ROUND_END].includes(e.event as never))
      .map((e) => (e.event === AGENT_SOCKET_EVENTS.ROUND_END ? `end:${e.data.step}` : e.event === AGENT_SOCKET_EVENTS.TOKEN ? `text:${e.data.step}` : 'call'));
    expect(order.indexOf('text:0')).toBeLessThan(order.indexOf('call'));
    expect(order.indexOf('call')).toBeLessThan(order.indexOf('end:0'));
    expect(order.indexOf('end:0')).toBeLessThan(order.indexOf('text:1'));
  });

  it('make a round that stops for the person’s approval final, though it called a tool', async () => {
    const { sequence, result } = await rounds([
      { text: 'I can book that.', toolCalls: [{ id: 'call_book', name: 'visit_book', args: { day: '2026-10-28' } }] },
    ]);
    expect(result.stopReason).toBe('awaiting_approval');
    expect(sequence).toEqual(['0:I can book that.', 'end:0:true:true']);
  });

  it('make a round that offers the person a choice final, though it called a tool', async () => {
    const { sequence, result } = await rounds([
      {
        text: 'Which colour?',
        toolCalls: [{ id: 'call_opts', name: 'present_options', args: { options: [{ id: 'blue', label: 'Blue' }, { id: 'red', label: 'Red' }] } }],
      },
    ]);
    expect(result.stopReason).toBe('present_options');
    expect(sequence).toEqual(['0:Which colour?', 'end:0:true:true']);
  });

  it('make the last round the turn is allowed final, though it called a tool', async () => {
    const { sequence, result } = await rounds(
      [
        { text: 'Looking.', toolCalls: [{ id: 'call_1', name: 'inventory_search', args: {} }] },
        { text: 'Still looking.', toolCalls: [{ id: 'call_2', name: 'inventory_search', args: {} }] },
      ],
      { maxToolRounds: 2 },
    );
    expect(result.stopReason).toBe('step_count');
    expect(sequence).toEqual(['0:Looking.', 'end:0:true:false', '1:\n\nStill looking.', 'end:1:true:true']);
  });
});

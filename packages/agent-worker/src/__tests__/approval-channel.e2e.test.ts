/**
 * The turn's channel (ADR-0260 §3.3): in a UI an approval is the card; on a
 * conversation channel (SMS here) the customer is sent the readback, verbatim,
 * as the turn's last words, and their next message confirms it (ADR-0228 D7).
 * The model is told about approvals in its channel's terms. End to end on the
 * fixture product, with the approval store on the real realtime server.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_SOCKET_EVENTS } from '@ouispec/agent-core';
import type { RegisteredTool } from '../tools/types.js';
import { APPROVAL_TOOL_NOTE, READBACK_APPROVAL_TOOL_NOTE } from '../approvals/requirement.js';
import { payloadRefusal } from '../runtime/turn-runner.js';
import { startFixtureProduct, type FixtureProduct } from './support/fixture-product.js';
import { FixtureConversation, runFixtureTurn } from './support/fixture-turn.js';
import { respondingOpenAI, type ChatRequest } from './support/replay.js';

let product: FixtureProduct;
beforeAll(async () => {
  product = await startFixtureProduct();
}, 20_000);
afterAll(async () => product?.stop());

const booked: Array<Record<string, unknown>> = [];
/** Booking a service visit holds a slot for the customer: an external act, approved per call. */
const bookService: RegisteredTool = {
  name: 'book_service',
  title: 'Book a service visit',
  description: 'Holds the time in the service schedule for this customer.',
  effect: { kind: 'transaction' },
  argsSensitive: false,
  inputSchema: {
    type: 'object',
    properties: {
      service: { type: 'string', title: 'Service' },
      day: { type: 'string', title: 'Day' },
      time: { type: 'string', title: 'Time' },
    },
    required: ['service', 'day', 'time'],
  },
  execute: async (input) => {
    booked.push(input);
    return { success: true, data: { confirmation: 'SV-1042' } };
  },
};
const CALL = { id: 'call_book_1', name: 'book_service', args: { service: 'Oil change', day: 'Saturday', time: '09:00' } };
const READBACK = 'Book a service visit: Service Oil change, Day Saturday, Time 09:00. Holds the time in the service schedule for this customer.';
const toolDescription = (request: ChatRequest) => request.tools?.find((t) => t.function.name === 'book_service')?.function.description ?? '';

describe('approvals in the turn’s channel', () => {
  it('on SMS: the model is told of the readback, the readback is the turn’s last words, and a confirmed yes runs the stored call', async () => {
    booked.length = 0;
    const conversation = new FixtureConversation();
    const model = respondingOpenAI((_req, i) => (i === 0 ? { text: 'I can book that for you.', toolCalls: [CALL] } : undefined));
    const asked = await runFixtureTurn(product, {
      adapter: 'container',
      model: model.model,
      turnId: 'turn-sms-book',
      conversation,
      tools: [bookService],
      payload: { conversationId: 'conv-sms', channel: 'sms', content: 'Book me an oil change Saturday at 9' },
    });

    expect(asked.outcome.status).toBe('completed');
    expect(toolDescription(model.requests[0])).toContain(READBACK_APPROVAL_TOOL_NOTE);
    expect(toolDescription(model.requests[0])).not.toContain('approval card');
    const messages = asked.persisted[0].messages;
    // What the model was told the call is waiting for: the readback, not a card.
    const waiting = JSON.parse(String(messages.find((m) => m.role === 'tool')?.content)) as { message: string };
    expect(waiting.message).toContain(`"${READBACK}"`);
    expect(waiting.message).not.toContain('card');
    // The readback, word for word, is what the customer is sent last, and what the next turn reads.
    expect(messages.at(-1)).toEqual({ role: 'assistant', content: READBACK });
    const streamed = asked.tab
      .turnEvents('turn-sms-book')
      .filter((e) => e.event === AGENT_SOCKET_EVENTS.TOKEN)
      .map((e) => (e.data as { text: string }).text)
      .join('');
    expect(streamed).toBe(`I can book that for you.\n\n${READBACK}`);
    expect(booked).toEqual([]);

    // The product's classifier read "yes" as confirming the readback: it decides for the customer on the SMS channel.
    const decided = await product.internal(`/internal/approvals/${CALL.id}/decide`, { userId: 'ana', decision: 'approve', channel: 'sms' });
    expect(decided.status).toBe(200);
    const token = decided.body.token as string;
    const confirming = respondingOpenAI((req) => {
      expect(req.messages.some((m) => m.role === 'assistant' && String(m.content).includes(READBACK))).toBe(true);
      return { text: 'You are booked for Saturday at 9. Confirmation SV-1042.' };
    });
    const ran = await runFixtureTurn(product, {
      adapter: 'container',
      model: confirming.model,
      turnId: 'turn-sms-yes',
      conversation,
      tools: [bookService],
      payload: { conversationId: 'conv-sms', channel: 'sms', content: '', approval: { approvalId: CALL.id, decision: 'approve', token } },
    });
    expect(ran.outcome.status).toBe('completed');
    expect(booked).toEqual([CALL.args]);
    expect(ran.persisted[0].messages.at(-1)).toMatchObject({ content: 'You are booked for Saturday at 9. Confirmation SV-1042.' });
  });

  it('in a UI (the default): the model is told of the card, and nothing is added to its reply', async () => {
    const model = respondingOpenAI((_req, i) => (i === 0 ? { toolCalls: [{ ...CALL, id: 'call_book_ui' }] } : undefined));
    const asked = await runFixtureTurn(product, {
      adapter: 'container',
      model: model.model,
      turnId: 'turn-ui-book',
      tools: [bookService],
      payload: { conversationId: 'conv-ui', content: 'Book me an oil change Saturday at 9' },
    });
    expect(asked.outcome.status).toBe('completed');
    expect(toolDescription(model.requests[0])).toContain(APPROVAL_TOOL_NOTE);
    const messages = asked.persisted[0].messages;
    expect(messages.map((m) => m.role)).toEqual(['assistant', 'tool']);
    expect(String(messages[1].content)).toContain('on the approval card');
    expect(await asked.tab.waitForTurn(AGENT_SOCKET_EVENTS.APPROVAL_REQUIRED, 'turn-ui-book')).toMatchObject({ preview: { readback: READBACK } });
  });

  it('refuses a turn whose channel the platform does not know', () => {
    const turn = { turnId: 't', conversationId: 'c', userId: 'u', accountId: 'a', socketRoom: 'r', content: 'hi' };
    expect(payloadRefusal({ ...turn, channel: 'fax' })).toBe('channel must be one of ui, voice, phone, sms, chat');
    expect(payloadRefusal({ ...turn, channel: 'sms' })).toBeNull();
  });
});

/**
 * ADR-0260 §2 on the real server, two instances on one real Redis: a person on
 * the staff takes a conversation, the customer's tab and the staff console see
 * it in the conversation's room, the turn's worker on the other instance hears
 * it as a stop, only the holder speaks for the business, and only the holder
 * (or the product) hands it back. The customer is an anonymous website
 * visitor, as Nova's is.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io-client';
import { CONVERSATION_EVENTS, type ConversationHold, type StaffSpeaker } from '@ouispec/agent-core';
import type { RealtimeServerInstance } from '../server.js';
import { createHarness, next, type Harness } from './harness.js';

const KEY = 'takeover-internal-key';
let harness: Harness;
let a: RealtimeServerInstance;
let b: RealtimeServerInstance;

const jordan: StaffSpeaker = { userId: 'staff-17', displayName: 'Jordan', role: 'Toyota of Quillhaven sales' };
const casey: StaffSpeaker = { userId: 'staff-23', displayName: 'Casey', role: 'Service' };

beforeAll(async () => {
  harness = await createHarness({
    key: KEY,
    users: {
      // Website visitors: the product signed a session for each when its widget loaded. No account, no sign-in.
      'visitor-session-a': { userId: 'visitor-a' },
      'visitor-session-b': { userId: 'visitor-b' },
      'staff-session-jordan': { userId: 'staff-17', accountId: 'dealer-1' },
    },
  });
  a = await harness.start();
  b = await harness.start();
}, 20_000);
afterAll(async () => harness?.close());

/** The product's API: its own check first, then the server's route with the internal key. */
const post = async (server: RealtimeServerInstance, path: string, body: unknown) => {
  const res = await harness.internal(server, path, { body });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

/** A socket in the conversation's room, joined with the token the product minted for it. */
async function inRoom(server: RealtimeServerInstance, session: string, userId: string, room: string): Promise<Socket> {
  const socket = await harness.connect(server, session);
  const joined = await harness.subscribe(socket, { rooms: [room], tokens: { [room]: await harness.mintToken(server, userId, room) } });
  expect(joined.ok).toBe(true);
  return socket;
}

describe('a person takes a conversation over and hands it back', () => {
  it("the visitor and the staff console see it in the conversation's room, on either instance, and the hold is one", async () => {
    const room = 'agent:conversation:c-take';
    const visitor = await inRoom(a, 'visitor-session-a', 'visitor-a', room);
    const console_ = await inRoom(b, 'staff-session-jordan', 'staff-17', room);
    const seenByVisitor = next<Record<string, unknown>>(visitor, CONVERSATION_EVENTS.TAKEN_OVER);
    const seenByConsole = next<Record<string, unknown>>(console_, CONVERSATION_EVENTS.TAKEN_OVER);

    const taken = await post(b, '/internal/conversations/c-take/hold', { holder: jordan, rooms: [room] });
    expect(taken.status).toBe(200);
    expect(taken.body).toMatchObject({ ok: true, change: 'taken_over', hold: { conversationId: 'c-take', holder: jordan } });
    const event = await seenByVisitor;
    expect(event).toMatchObject({ conversationId: 'c-take', hold: { holder: jordan } });
    expect(await seenByConsole).toEqual(event);

    // Asked on the other instance, the hold is the same one.
    const held = await harness.internal(a, '/internal/conversations/c-take/hold');
    expect(held.status).toBe(200);
    expect(((await held.json()) as ConversationHold).holder).toEqual(jordan);

    // Someone else is refused, with who holds it; the holder again is answered `already`, and nobody is told twice.
    const second = await post(a, '/internal/conversations/c-take/hold', { holder: casey, rooms: [room] });
    expect(second).toMatchObject({ status: 409, body: { ok: false, reason: 'held', hold: { holder: jordan } } });
    let again = 0;
    visitor.on(CONVERSATION_EVENTS.TAKEN_OVER, () => again++);
    const repeat = await post(a, '/internal/conversations/c-take/hold', { holder: jordan, rooms: [room] });
    expect(repeat.body).toMatchObject({ ok: true, change: 'already' });
    await new Promise((r) => setTimeout(r, 100));
    expect(again).toBe(0);
  });

  it("is heard as a stop by the turn's worker on the other instance: a waiting turn wakes, a new one is told at once", async () => {
    const watching = harness.internal(a, '/internal/turns/t-run/stop?userId=visitor-a&conversationId=c-stop&waitMs=5000');
    await new Promise((r) => setTimeout(r, 50));
    await post(b, '/internal/conversations/c-stop/hold', { holder: jordan, rooms: ['agent:conversation:c-stop'] });

    const heard = await watching;
    expect(heard.status).toBe(200);
    expect(await heard.json()).toMatchObject({ turnId: 't-run', by: 'staff-17', reason: 'taken_over' });

    // A turn that arrives while it is held is told on its first question, without waiting.
    const arriving = await harness.internal(b, '/internal/turns/t-new/stop?userId=visitor-a&conversationId=c-stop&waitMs=0');
    expect(arriving.status).toBe(200);
    expect(await arriving.json()).toMatchObject({ turnId: 't-new', reason: 'taken_over' });
    // A worker that does not name its conversation is not stopped by the hold.
    expect((await harness.internal(b, '/internal/turns/t-new/stop?userId=visitor-a&waitMs=0')).status).toBe(204);
    // A stop the visitor asked for comes first: it says what they asked.
    await post(a, '/internal/turns/t-own/stop', { userId: 'visitor-a', reason: 'user_stop' });
    const own = await harness.internal(a, '/internal/turns/t-own/stop?userId=visitor-a&conversationId=c-stop&waitMs=0');
    expect(await own.json()).toMatchObject({ reason: 'user_stop' });
  });

  it('only the holder speaks for the business: a staff message is announced while its speaker holds the conversation', async () => {
    const room = 'agent:conversation:c-say';
    const visitor = await inRoom(a, 'visitor-session-a', 'visitor-a', room);
    const message = (speaker: StaffSpeaker, id: string) => ({
      message: { id, role: 'staff', content: `${speaker.displayName} here: $500 off today.`, createdAt: '2026-10-08T15:00:00.000Z', speaker },
      rooms: [room],
    });

    expect(await post(b, '/internal/conversations/c-say/messages', message(jordan, 'm-0'))).toMatchObject({
      status: 409,
      body: { ok: false, reason: 'not_held' },
    });
    await post(b, '/internal/conversations/c-say/hold', { holder: jordan, rooms: [room] });
    expect(await post(b, '/internal/conversations/c-say/messages', message(casey, 'm-1'))).toMatchObject({
      status: 409,
      body: { ok: false, reason: 'not_holder' },
    });

    const arriving = next<Record<string, unknown>>(visitor, CONVERSATION_EVENTS.MESSAGE);
    expect(await post(b, '/internal/conversations/c-say/messages', message(jordan, 'm-2'))).toMatchObject({ status: 200, body: { ok: true } });
    expect(await arriving).toMatchObject({ conversationId: 'c-say', message: { id: 'm-2', role: 'staff', speaker: jordan } });

    // The customer's and the agent's messages are announced whoever holds it, for the staff watching.
    const customer = next<Record<string, unknown>>(visitor, CONVERSATION_EVENTS.MESSAGE);
    const sent = await post(a, '/internal/conversations/c-say/messages', {
      message: { id: 'm-3', role: 'user', content: 'Great, thanks', createdAt: '2026-10-08T15:00:01.000Z' },
      rooms: [room],
    });
    expect(sent.status).toBe(200);
    expect(await customer).toMatchObject({ message: { id: 'm-3', role: 'user' } });
  });

  it('only the holder hands it back, or the product on its own authority, and the room is told who', async () => {
    const room = 'agent:conversation:c-back';
    const visitor = await inRoom(a, 'visitor-session-a', 'visitor-a', room);
    await post(b, '/internal/conversations/c-back/hold', { holder: jordan, rooms: [room] });

    expect(await post(b, '/internal/conversations/c-back/hold/release', { userId: 'staff-23', rooms: [room] })).toMatchObject({
      status: 409,
      body: { ok: false, reason: 'not_holder', hold: { holder: jordan } },
    });
    const back = next<Record<string, unknown>>(visitor, CONVERSATION_EVENTS.HANDED_BACK);
    expect(await post(b, '/internal/conversations/c-back/hold/release', { userId: 'staff-17', rooms: [room] })).toMatchObject({
      status: 200,
      body: { ok: true, change: 'handed_back', by: 'holder', hold: { holder: jordan } },
    });
    expect(await back).toMatchObject({ conversationId: 'c-back', by: 'holder', hold: { holder: jordan } });
    expect((await harness.internal(a, '/internal/conversations/c-back/hold')).status).toBe(204);
    // A turn of it now runs: no stop.
    expect((await harness.internal(a, '/internal/turns/t-after/stop?userId=visitor-a&conversationId=c-back&waitMs=0')).status).toBe(204);

    // The product's own release (an idle policy) needs no user, and says so.
    await post(b, '/internal/conversations/c-back/hold', { holder: casey, rooms: [room] });
    const released = next<Record<string, unknown>>(visitor, CONVERSATION_EVENTS.HANDED_BACK);
    expect((await post(a, '/internal/conversations/c-back/hold/release', { rooms: [room] })).body).toMatchObject({ change: 'handed_back', by: 'product' });
    expect(await released).toMatchObject({ by: 'product', hold: { holder: casey } });
    expect((await post(a, '/internal/conversations/c-back/hold/release', { rooms: [room] })).body).toEqual({ ok: true, change: 'not_held' });
  });

  it("an anonymous visitor joins only its own conversation's room", async () => {
    const room = 'agent:conversation:c-visitor-a';
    const other = await harness.connect(a, 'visitor-session-b');
    // Without a token, with another room's token, and with a token minted for another visitor: refused.
    expect((await harness.subscribe(other, room)).ok).toBe(false);
    const ownToken = await harness.mintToken(a, 'visitor-b', 'agent:conversation:c-visitor-b');
    expect((await harness.subscribe(other, { rooms: [room], tokens: { [room]: ownToken } })).denied).toEqual([room]);
    const stolen = await harness.mintToken(a, 'visitor-a', room);
    expect((await harness.subscribe(other, { rooms: [room], tokens: { [room]: stolen } })).denied).toEqual([room]);
    // An unauthenticated socket never connects at all.
    await expect(harness.connect(a)).rejects.toThrow(/Authentication required/);
  });

  it('refuses the conversation events from the emit API, a malformed body, a room the policy does not know, and a missing key', async () => {
    for (const event of Object.values(CONVERSATION_EVENTS)) {
      const res = await harness.emit(a, event, { conversationId: 'c-x' }, ['agent:conversation:c-x']);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/sent only by the server's conversation routes/);
    }
    expect((await post(a, '/internal/conversations/c-x/hold', { holder: { userId: 'staff-17' }, rooms: ['agent:conversation:c-x'] })).status).toBe(400);
    expect((await post(a, '/internal/conversations/c-x/hold', { holder: jordan, rooms: ['nowhere'] })).status).toBe(400);
    expect((await post(a, '/internal/conversations/c-x/hold', { holder: jordan, rooms: [] })).status).toBe(400);
    expect((await post(a, '/internal/conversations/bad id/hold', { holder: jordan, rooms: ['agent:conversation:c-x'] })).status).toBe(400);
    const keyless = await harness.internal(a, '/internal/conversations/c-x/hold', { body: { holder: jordan, rooms: ['agent:conversation:c-x'] }, key: 'wrong' });
    expect(keyless.status).toBe(401);
    expect((await harness.internal(a, '/internal/conversations/c-x/hold')).status).toBe(204);
  });
});

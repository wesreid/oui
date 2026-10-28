// @vitest-environment jsdom
/**
 * A UI action approved by voice, in the tab: the card of a call's
 * turn shows in the tab that follows the conversation; the grant the store
 * pushes to the conversation's room is claimed on the tab's own socket and
 * handed to its OUI runtime, which runs the approved request once; the card
 * says it was approved by voice. A grant for another conversation, for a room
 * the tab is not in, or already expired is not claimed; a replayed push is not
 * claimed again and the runtime refuses it; a grant another tab took is not
 * handed to the runtime; a spoken no shows on the card.
 */
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSurfaceRuntime, defineSurface } from 'oui-spec/core';
import { argsHash } from 'oui-spec/spec';
import {
  APPROVAL_CLAIM_EVENT,
  APPROVAL_PUSH_EVENTS,
  type AgentClientConfig,
  type ApprovalClaimResult,
  type ApprovalGrantedEvent,
  type ApprovalRequiredEvent,
} from '@ouispec/agent-core';
import { createFakeSocket, type FakeSocket } from '../../provider/__tests__/fake-socket.js';
import { AgentProvider, useAgent } from '../../provider/AgentProvider.js';
import { ApprovalCard } from '../ApprovalCard.js';

afterEach(cleanup);

const ROOM = 'deos:conversation:conv-1';
const order = { symbol: 'ACME', quantity: 100 };

let agent: ReturnType<typeof useAgent>;
function Probe() {
  agent = useAgent();
  return null;
}

/** A call's turn stopped at an order on the page: it is the conversation's, not this tab's. */
const callApproval = (over: Partial<ApprovalRequiredEvent> = {}): ApprovalRequiredEvent => ({
  turnId: 'call-turn-7',
  conversationId: 'conv-1',
  approvalId: 'call_order_9',
  tool: 'ui_act',
  effect: 'transaction',
  destructive: false,
  expiresAt: Date.now() + 5 * 60_000,
  timestamp: Date.now(),
  preview: {
    title: 'Place an order',
    consequence: 'Sends the order to the exchange.',
    arguments: [{ name: 'symbol', label: 'Symbol', value: 'ACME' }],
    readback: 'Place an order: Symbol ACME.',
  },
  ...over,
});

async function granted(over: Partial<ApprovalGrantedEvent> = {}): Promise<ApprovalGrantedEvent> {
  return {
    approvalId: 'call_order_9',
    grantId: 'grant-1',
    argsHash: await argsHash(order),
    expiresAt: Date.now() + 120_000,
    conversationId: 'conv-1',
    room: ROOM,
    channel: 'voice',
    timestamp: Date.now(),
    ...over,
  };
}

/** The tab: the provider following its conversation's room, the card, and its own OUI runtime with an order surface. */
function setup(claim: (payload: { approvalId: string; grantId: string }) => ApprovalClaimResult) {
  let socket!: FakeSocket;
  const placed: Array<Record<string, unknown>> = [];
  const runtime = createSurfaceRuntime({ announce: false, settle: { quietMs: 0, timeoutMs: 50 } });
  runtime.mount(
    defineSurface({
      id: 'orders',
      name: 'Orders',
      description: 'Orders',
      actions: [
        {
          id: 'orders_place',
          title: 'Place an order',
          description: 'Sends the order to the exchange.',
          effect: 'transaction',
          input: { type: 'object' },
          handler: async (params) => {
            placed.push(params);
            return { success: true };
          },
        },
      ],
    }),
    () => ({}),
  );
  const grantApproval = vi.fn((grant: { approvalId: string; argsHash: string; expiresAt: number }) => runtime.grantApproval(grant));
  window.sessionStorage.clear();
  const config: AgentClientConfig = {
    createConversation: async () => ({ conversationId: 'conv-1' }),
    sendMessage: vi.fn(async () => ({ turnId: 'turn-1', socketRoom: 'agent:turn:turn-1', roomToken: 'tok-1' })),
    conversationRoom: async (conversationId) => ({ room: `deos:conversation:${conversationId}`, roomToken: `room-tok-${conversationId}` }),
    grantApproval,
    realtime: {
      url: 'wss://rt.example',
      getToken: () => 'visitor-session',
      createSocket: () => {
        socket = createFakeSocket();
        const emit = socket.emit.bind(socket);
        socket.emit = (event: string, ...args: unknown[]) => {
          emit(event, ...args);
          const ack = args[1];
          if (event === APPROVAL_CLAIM_EVENT && typeof ack === 'function') ack(claim(args[0] as { approvalId: string; grantId: string }));
        };
        return socket;
      },
    },
  };
  render(
    <AgentProvider config={config}>
      <Probe />
      <ApprovalCard />
    </AgentProvider>,
  );
  return { socket: () => socket, grantApproval, runtime, placed };
}

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
const claims = (socket: FakeSocket) => socket.emitted.filter((e) => e.event === APPROVAL_CLAIM_EVENT).map((e) => e.args[0]);

/** The visitor writes once (the conversation exists and its room is followed), and their own turn ends. */
async function onConversation(socket: () => FakeSocket) {
  await act(async () => {
    await agent.sendMessage('I would like to buy 100 ACME');
  });
  await settle();
  act(() => socket().fire('agent:turn_complete', { turnId: 'turn-1' }));
}

describe('a UI action approved by voice, in the tab', () => {
  it('shows the call’s card, claims the pushed grant once, runs the request once, and says it was approved by voice', async () => {
    const hash = await argsHash(order);
    const tab = setup(({ approvalId }) => ({ ok: true, approvalId, argsHash: hash, expiresAt: Date.now() + 120_000, channel: 'voice' }));
    await onConversation(tab.socket);
    act(() => tab.socket().fire('agent:approval_required', callApproval()));
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();

    const grant = await granted();
    act(() => tab.socket().fire(APPROVAL_PUSH_EVENTS.GRANTED, grant));
    await settle();
    expect(claims(tab.socket())).toEqual([{ approvalId: 'call_order_9', grantId: 'grant-1' }]);
    expect(tab.grantApproval).toHaveBeenCalledTimes(1);
    expect(tab.grantApproval).toHaveBeenCalledWith({ approvalId: 'call_order_9', argsHash: hash, expiresAt: expect.any(Number) });
    expect(screen.getByRole('status').textContent).toBe('Approved by voice.');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    // Nothing is decided on the card, and the tab starts no turn of its own: the call's turn carries the token.
    expect(tab.socket().emitted.some((e) => e.event === 'approval:decide')).toBe(false);

    const request = (requestId: string) => ({
      requestId,
      surfaceId: 'orders',
      actionId: 'orders_place',
      params: order,
      timestamp: Date.now(),
      approval: { approvalId: 'call_order_9', argsHash: hash },
    });
    expect(await tab.runtime.execute(request('r1'))).toMatchObject({ success: true });
    expect(await tab.runtime.execute(request('r2'))).toMatchObject({ success: false, error: { code: 'APPROVAL_REQUIRED' } });
    expect(tab.placed).toEqual([order]);

    // The same push again: not claimed again, and the runtime would refuse it anyway.
    act(() => tab.socket().fire(APPROVAL_PUSH_EVENTS.GRANTED, grant));
    await settle();
    expect(claims(tab.socket())).toHaveLength(1);
    expect(tab.runtime.grantApproval({ approvalId: grant.approvalId, argsHash: hash, expiresAt: Date.now() + 60_000 })).toBe(false);
  });

  it('does not claim a grant for another conversation, for a room the tab is not in, or already expired; one another tab took is not handed to the runtime', async () => {
    const tab = setup(() => ({ ok: false, reason: 'used', error: 'another tab has already taken this grant' }));
    await onConversation(tab.socket);
    act(() => tab.socket().fire('agent:approval_required', callApproval()));
    for (const stale of [
      await granted({ conversationId: 'conv-other', grantId: 'g-other' }),
      await granted({ room: 'deos:conversation:conv-2', grantId: 'g-room' }),
      await granted({ expiresAt: Date.now() - 1, grantId: 'g-old' }),
    ]) {
      act(() => tab.socket().fire(APPROVAL_PUSH_EVENTS.GRANTED, stale));
    }
    await settle();
    expect(claims(tab.socket())).toEqual([]);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();

    // Nor anything that is not a grant.
    act(() => {
      tab.socket().fire(APPROVAL_PUSH_EVENTS.GRANTED, { bogus: true });
      tab.socket().fire(APPROVAL_PUSH_EVENTS.GRANTED, undefined);
    });
    await settle();
    expect(claims(tab.socket())).toEqual([]);

    // The person approved it, so the card says so here too; the other tab holds the grant.
    const grant = await granted({ grantId: 'g-taken' });
    act(() => tab.socket().fire(APPROVAL_PUSH_EVENTS.GRANTED, grant));
    await settle();
    expect(claims(tab.socket())).toEqual([{ approvalId: 'call_order_9', grantId: 'g-taken' }]);
    expect(tab.grantApproval).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe('Approved by voice.');
  });

  it('shows a spoken no on the card, and claims nothing', async () => {
    const tab = setup(() => ({ ok: false, reason: 'unknown', error: 'none' }));
    await onConversation(tab.socket);
    act(() => tab.socket().fire('agent:approval_required', callApproval()));
    act(() => tab.socket().fire(APPROVAL_PUSH_EVENTS.DECLINED, { approvalId: 'call_order_9', conversationId: 'conv-1', channel: 'phone', timestamp: Date.now() }));
    expect(screen.getByRole('status').textContent).toBe('Declined on the phone.');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(claims(tab.socket())).toEqual([]);
    expect(tab.grantApproval).not.toHaveBeenCalled();
  });

  it('does not show a card from another conversation, or one of its own ended turn again', async () => {
    const tab = setup(() => ({ ok: false, reason: 'unknown', error: 'none' }));
    await onConversation(tab.socket);
    act(() => tab.socket().fire('agent:approval_required', callApproval({ conversationId: 'conv-other' })));
    act(() => tab.socket().fire('agent:approval_required', callApproval({ turnId: 'turn-1' })));
    expect(agent.pendingApproval).toBeNull();
  });
});

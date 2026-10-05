// @vitest-environment jsdom
/**
 * The approval card (ADR-0228 §2.2.3): the browser half of an irreversible
 * action.
 *
 * `agent:approval_required` shows the card with the declaration's words. Only
 * a click on it decides: `approval:decide` on the user's own socket. An
 * approval's grant goes to this tab's OUI runtime, and the continuation turn
 * carries the token outside the message text. The tab's runtime then runs the
 * approved request, and only that one (§5.1 browser half, §5.4).
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSurfaceRuntime, defineSurface } from 'oui-spec/core';
import { argsHash } from 'oui-spec/spec';
import {
  APPROVAL_DECIDE_EVENT,
  type AgentClientConfig,
  type ApprovalDecideResult,
  type ApprovalRequiredEvent,
} from '@ouispec/agent-core';
import { createFakeSocket, type FakeSocket } from '../../provider/__tests__/fake-socket.js';
import { AgentProvider, useAgent } from '../../provider/AgentProvider.js';
import { ApprovalCard } from '../ApprovalCard.js';

afterEach(cleanup);

const order = { symbol: 'ACME', quantity: 100 };

async function required(over: Partial<ApprovalRequiredEvent> = {}): Promise<ApprovalRequiredEvent> {
  return {
    turnId: 'turn-1',
    conversationId: 'conv-1',
    approvalId: 'call_order_1',
    tool: 'orders_place',
    effect: 'transaction',
    destructive: false,
    expiresAt: Date.now() + 5 * 60_000,
    timestamp: Date.now(),
    preview: {
      title: 'Place an order',
      consequence: 'Sends the order to the exchange. It cannot be undone.',
      arguments: [
        { name: 'symbol', label: 'Symbol', value: 'ACME' },
        { name: 'quantity', label: 'Quantity', value: '100' },
      ],
      readback: 'Place an order: Symbol ACME, Quantity 100. Sends the order to the exchange. It cannot be undone.',
    },
    ...over,
  };
}

let agent: ReturnType<typeof useAgent>;
function Probe() {
  agent = useAgent();
  return null;
}

/** The tab: the provider on a fake socket, the card, and the tab's own OUI runtime with an order surface. */
function setup(answer: (payload: { approvalId: string; decision: string }) => ApprovalDecideResult | Promise<ApprovalDecideResult>) {
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
          handler: async params => {
            placed.push(params);
            return { success: true };
          },
        },
      ],
    }),
    () => ({}),
  );
  // The first start is turn-1, the turn the approval event below names: a card is shown only for
  // the turn the tab is running (the mock has recorded the call by the time it answers).
  const sendMessage = vi.fn(async (_params: Parameters<AgentClientConfig['sendMessage']>[0]) => ({
    turnId: `turn-${sendMessage.mock.calls.length}`,
    socketRoom: `chat:turn:turn-${sendMessage.mock.calls.length}`,
    roomToken: 'room-token',
  }));
  const grantApproval = vi.fn((grant: { approvalId: string; argsHash: string; expiresAt: number }) => runtime.grantApproval(grant));
  const config: AgentClientConfig = {
    createConversation: async () => ({ conversationId: 'conv-1' }),
    sendMessage,
    grantApproval,
    realtime: {
      url: 'wss://rt.example',
      getToken: () => 'jwt',
      createSocket: () => {
        socket = createFakeSocket();
        const emit = socket.emit.bind(socket);
        socket.emit = (event: string, ...args: unknown[]) => {
          emit(event, ...args);
          const ack = args[1];
          if (event === APPROVAL_DECIDE_EVENT && typeof ack === 'function') {
            void Promise.resolve(answer(args[0] as { approvalId: string; decision: string })).then(r => ack(r));
          }
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
  return { socket: () => socket, sendMessage, grantApproval, runtime, placed };
}

/** The user sends a message, and the turn stops at an approval. */
async function turnStopsAtApproval(socket: FakeSocket, event: ApprovalRequiredEvent) {
  await act(async () => {
    await agent.sendMessage('Buy 100 ACME');
  });
  act(() => {
    socket.fire('agent:approval_required', event);
    socket.fire('agent:turn_complete', { turnId: event.turnId });
  });
}

describe('ApprovalCard', () => {
  it('shows nothing until a turn stops for approval, then the declaration’s words', async () => {
    const tab = setup(async () => ({ ok: true, decision: 'decline', approvalId: 'x' }));
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    await turnStopsAtApproval(tab.socket(), await required());

    expect(screen.getByText('Place an order')).toBeTruthy();
    expect(screen.getByText('Sends the order to the exchange. It cannot be undone.')).toBeTruthy();
    expect(screen.getByText('Symbol')).toBeTruthy();
    expect(screen.getByText('ACME')).toBeTruthy();
    expect(screen.getByText('Quantity')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeTruthy();
    expect(agent.pendingApproval?.approvalId).toBe('call_order_1');
  });

  it('on Approve: decides on the user’s socket, gives the grant to the tab, continues the turn with the token, and the tab then runs exactly that request once', async () => {
    const event = await required();
    const hash = await argsHash(order);
    const tab = setup(async ({ approvalId }) => ({
      ok: true,
      decision: 'approve',
      approvalId,
      token: 'eyJ.signed.token',
      argsHash: hash,
      expiresAt: event.expiresAt,
      channel: 'ui',
    }));
    await turnStopsAtApproval(tab.socket(), event);
    const messagesBefore = agent.messages.length;

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    });

    expect(tab.socket().emitted.filter(e => e.event === APPROVAL_DECIDE_EVENT).map(e => e.args[0])).toEqual([
      { approvalId: 'call_order_1', decision: 'approve' },
    ]);
    expect(tab.grantApproval).toHaveBeenCalledWith({ approvalId: 'call_order_1', argsHash: hash, expiresAt: event.expiresAt });
    expect(tab.sendMessage).toHaveBeenCalledTimes(2);
    expect(tab.sendMessage.mock.calls[1][0]).toMatchObject({
      conversationId: 'conv-1',
      content: '',
      approval: { approvalId: 'call_order_1', decision: 'approve', token: 'eyJ.signed.token' },
    });
    // The click is not a message: no user bubble, and the token never reaches the chat.
    expect(agent.messages.length).toBe(messagesBefore);
    expect(JSON.stringify(agent.messages)).not.toContain('eyJ.signed.token');
    expect(agent.pendingApproval).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();

    // The worker's dispatch of the approved call: it runs, once, and only for the approved params.
    const approval = { approvalId: 'call_order_1', argsHash: hash };
    const changed = await tab.runtime.execute({ requestId: 'r0', surfaceId: 'orders', actionId: 'orders_place', params: { ...order, quantity: 9_999 }, timestamp: 0, approval });
    expect(changed).toMatchObject({ success: false, error: { code: 'APPROVAL_REQUIRED' } });
    expect(await tab.runtime.execute({ requestId: 'r1', surfaceId: 'orders', actionId: 'orders_place', params: order, timestamp: 0, approval })).toMatchObject({ success: true });
    expect(await tab.runtime.execute({ requestId: 'r2', surfaceId: 'orders', actionId: 'orders_place', params: order, timestamp: 0, approval })).toMatchObject({
      success: false,
      error: { code: 'APPROVAL_REQUIRED' },
    });
    expect(tab.placed).toEqual([order]);
  });

  it('on Decline: decides on the socket, gives no grant, and continues the turn saying so', async () => {
    const tab = setup(async ({ approvalId }) => ({ ok: true, decision: 'decline', approvalId }));
    await turnStopsAtApproval(tab.socket(), await required());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    });
    expect(tab.socket().emitted.filter(e => e.event === APPROVAL_DECIDE_EVENT).map(e => e.args[0])).toEqual([
      { approvalId: 'call_order_1', decision: 'decline' },
    ]);
    expect(tab.grantApproval).not.toHaveBeenCalled();
    expect(tab.sendMessage.mock.calls[1][0]).toMatchObject({ content: '', approval: { approvalId: 'call_order_1', decision: 'decline' } });
    expect(tab.sendMessage.mock.calls[1][0].approval).not.toHaveProperty('token');
    expect(agent.pendingApproval).toBeNull();
  });

  it('says why when the store refuses, gives no grant and starts no turn', async () => {
    const tab = setup(async () => ({ ok: false, reason: 'expired', error: 'this approval has expired' }));
    await turnStopsAtApproval(tab.socket(), await required());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    });
    expect(screen.getByRole('alert').textContent).toMatch(/expired/);
    expect(tab.grantApproval).not.toHaveBeenCalled();
    expect(tab.sendMessage).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    });
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(tab.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('cannot be approved once it has expired', async () => {
    const tab = setup(async () => ({ ok: true, decision: 'decline', approvalId: 'x' }));
    await turnStopsAtApproval(tab.socket(), await required({ expiresAt: Date.now() - 1 }));
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/expired/i)).toBeTruthy();
  });

  it('draws with the host’s own parts when given them', async () => {
    const tab = setup(async () => ({ ok: true, decision: 'decline', approvalId: 'x' }));
    cleanup();
    let socket!: FakeSocket;
    const Card = ({ title, subtitle, children, actions, tone }: { title: React.ReactNode; subtitle?: React.ReactNode; children?: React.ReactNode; actions?: React.ReactNode; tone?: string }) => (
      <section data-part="host-card" data-tone={tone}>
        <h2>{title}</h2>
        <p>{subtitle}</p>
        {children}
        <footer>{actions}</footer>
      </section>
    );
    const Button = ({ children, onClick, disabled, variant }: { children?: React.ReactNode; onClick?: () => unknown; disabled?: boolean; variant?: string }) => (
      <button data-part="host-button" data-variant={variant} disabled={disabled} onClick={() => void onClick?.()}>
        {children}
      </button>
    );
    render(
      <AgentProvider
        config={{
          createConversation: async () => ({ conversationId: 'conv-1' }),
          sendMessage: async () => ({ turnId: 'turn-1', socketRoom: 'chat:turn:turn-1', roomToken: 't' }),
          realtime: { url: 'wss://rt.example', getToken: () => 'jwt', createSocket: () => (socket = createFakeSocket()) },
        }}
      >
        <Probe />
        <ApprovalCard components={{ Card, Button }} />
      </AgentProvider>,
    );
    void tab;
    await turnStopsAtApproval(socket, await required());
    expect(document.querySelector('[data-part="host-card"]')?.getAttribute('data-tone')).toBe('warning');
    expect([...document.querySelectorAll('[data-part="host-button"]')].map(b => [b.textContent, b.getAttribute('data-variant')])).toEqual([
      ['Decline', 'secondary'],
      ['Approve', 'primary'],
    ]);
  });
});

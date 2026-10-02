import { describe, expect, it, vi } from 'vitest';
import { createWebSocketTransport } from '../../src/transport/websocket.js';
import { createDirectTransportPair } from '../../src/transport/direct.js';
import type { OUIActionResult } from '../../src/spec/types.js';
import { createMockSocket } from '../helpers/mock-socket.js';

const result: OUIActionResult = { requestId: 'r-1', success: true, data: { ok: 1 }, timestamp: 1 };

describe('action results', () => {
  it('websocket: sendResult emits {ns}:action:result and onResult receives it', () => {
    const socket = createMockSocket();
    const transport = createWebSocketTransport(socket);
    transport.sendResult(result);
    expect(socket.emitted).toEqual([{ event: 'oui:action:result', data: result }]);

    const handler = vi.fn();
    transport.onResult(handler);
    socket.receive('oui:action:result', result);
    expect(handler).toHaveBeenCalledWith(result);
  });

  it('websocket: a dispatch without a requestId is dropped, because it could never be answered', () => {
    const socket = createMockSocket();
    const transport = createWebSocketTransport(socket);
    const handler = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    transport.onAction(handler);
    socket.receive('oui:dispatch', { surfaceId: 's', actionId: 'a', params: {} });
    expect(handler).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('websocket: dispose removes only its own listeners and leaves the socket connected', () => {
    const socket = createMockSocket();
    const foreign = () => {};
    socket.on('connect', foreign);
    const transport = createWebSocketTransport(socket);
    transport.onAction(() => {});
    transport.onResult(() => {});
    expect(socket.listenerCount()).toBeGreaterThan(1);

    transport.dispose();
    expect(socket.listenerCount()).toBe(1);
    expect(socket.listenerCount('connect')).toBe(1);
    expect(socket.disconnectCalls).toBe(0);
  });

  it('direct: client sendResult reaches server onResult', () => {
    const { server, client } = createDirectTransportPair();
    const handler = vi.fn();
    server.onResult(handler);
    client.sendResult(result);
    expect(handler).toHaveBeenCalledWith(result);
  });
});

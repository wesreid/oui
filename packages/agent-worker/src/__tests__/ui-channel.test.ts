import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHttpUIActionChannel } from '../ui/channel.js';

const request = { requestId: 'call-1', surfaceId: 'app-shell', actionId: 'navigate', params: { path: '/x' }, timestamp: 1 };
const answer = { requestId: 'call-1', success: true, timestamp: 2 };

afterEach(() => vi.unstubAllGlobals());

describe('createHttpUIActionChannel', () => {
  it('delivers a request to the room under OUI\'s own dispatch event', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const channel = createHttpUIActionChannel({ url: 'https://rt', apiKey: 'k' });

    // An older realtime service answers without receipts.
    expect(await channel.dispatch('agent:turn:t1', request)).toBeNull();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://rt/api/emit');
    // Asking the room's tabs for a receipt (oui-spec §7.3.7).
    expect(JSON.parse(String(init.body))).toEqual({ event: 'oui:dispatch', data: request, rooms: ['agent:turn:t1'], ackTimeoutMs: 1500 });
  });

  it('reports who received the request, as the realtime service counts its receipts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: true, receipts: { acknowledged: 2, accepted: 1 } }), { status: 200 })),
    );
    const channel = createHttpUIActionChannel({ url: 'https://rt', apiKey: 'k' });
    expect(await channel.dispatch('room', request)).toEqual({ acknowledged: 2, accepted: 1 });
  });

  it('asks for no receipt when told not to', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await createHttpUIActionChannel({ url: 'https://rt', apiKey: 'k', receiptTimeoutMs: 0 }).dispatch('room', request);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).not.toHaveProperty('ackTimeoutMs');
  });

  it('fails the call when the request could not be delivered', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 502 })));
    const channel = createHttpUIActionChannel({ url: 'https://rt', apiKey: 'k' });
    await expect(channel.dispatch('room', request)).rejects.toThrow(/HTTP 502/);
  });

  it('keeps asking until the answer arrives, scoped to the user', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(answer), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const channel = createHttpUIActionChannel({ url: 'https://rt', apiKey: 'k', maxPollMs: 50 });

    await expect(channel.awaitResult('call-1', { userId: 'u1', timeoutMs: 5_000 })).resolves.toEqual(answer);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/internal/oui/action-results/call-1?');
    expect(url).toContain('userId=u1');
  });

  it('asks for the final answer with final=1, and only then', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(answer), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const channel = createHttpUIActionChannel({ url: 'https://rt', apiKey: 'k', maxPollMs: 50 });
    await channel.awaitResult('call-1', { userId: 'u1', timeoutMs: 5_000, final: true });
    await channel.awaitResult('call-2', { userId: 'u1', timeoutMs: 5_000 });
    expect(String(fetchMock.mock.calls[0][0])).toContain('final=1');
    expect(String(fetchMock.mock.calls[1][0])).not.toContain('final');
  });

  it('returns null at the deadline, and throws on a configuration error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    const channel = createHttpUIActionChannel({ url: 'https://rt', apiKey: 'k', maxPollMs: 20 });
    await expect(channel.awaitResult('call-1', { userId: 'u1', timeoutMs: 60 })).resolves.toBeNull();

    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })));
    await expect(channel.awaitResult('call-1', { userId: 'u1', timeoutMs: 1_000 })).rejects.toThrow(/HTTP 401/);
  });
});

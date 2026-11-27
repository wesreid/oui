import { describe, expect, it } from 'vitest';
import { recordingFetch, replayingFetch, type RecordedExchange } from '../testing/cassette.js';

/** A live fetch whose body arrives in pieces, each released by the test. */
function pacedLive() {
  const releases: Array<() => void> = [];
  const live = (async () => {
    const pieces = ['first ', 'second ', 'last'];
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (i === pieces.length) return controller.close();
        await new Promise<void>((resolve) => releases.push(resolve));
        controller.enqueue(new TextEncoder().encode(pieces[i++]));
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/vnd.amazon.eventstream' } });
  }) as typeof fetch;
  return { live, release: () => releases.shift()?.() };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('recordingFetch', () => {
  it('hands each chunk on as it arrives, so a caller times the API, not the recording', async () => {
    const exchanges: RecordedExchange[] = [];
    const paced = pacedLive();
    const res = await recordingFetch(exchanges, paced.live)('https://bedrock.example/model/m/converse-stream');
    const reader = res.body!.getReader();
    const firstRead = reader.read();
    await flush();
    paced.release();
    // The first piece is readable while the rest has not been sent.
    expect(new TextDecoder().decode((await firstRead).value)).toBe('first ');
    const rest: string[] = [];
    for (;;) {
      const next = reader.read();
      await flush();
      paced.release();
      const { done, value } = await next;
      if (done) break;
      rest.push(new TextDecoder().decode(value));
    }
    expect(rest.join('')).toBe('second last');
    expect(exchanges).toHaveLength(1);
    expect(Buffer.from(exchanges[0].bodyBase64, 'base64').toString()).toBe('first second last');
    expect(exchanges[0]).toMatchObject({ path: '/model/m/converse-stream', status: 200, contentType: 'application/vnd.amazon.eventstream' });
  });

  it('keeps a whole body that replays as it was recorded, through JSON as a cassette is written', async () => {
    const exchanges: RecordedExchange[] = [];
    const live = (async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    await (await recordingFetch(exchanges, live)('https://api.example/v1/messages')).text();
    const written = JSON.parse(JSON.stringify(exchanges)) as RecordedExchange[];
    const replayed = await replayingFetch(written)('https://api.example/v1/messages');
    expect(await replayed.json()).toEqual({ ok: true });
  });

  it('keeps exchanges in the order their requests were sent, whichever answers first', async () => {
    const exchanges: RecordedExchange[] = [];
    let answerFirst: (r: Response) => void = () => {};
    const live = ((input: string) =>
      input.endsWith('/one')
        ? new Promise<Response>((resolve) => (answerFirst = resolve))
        : Promise.resolve(new Response('two', { status: 200 }))) as unknown as typeof fetch;
    const fetcher = recordingFetch(exchanges, live);
    const one = fetcher('https://api.example/one');
    const two = await fetcher('https://api.example/two');
    await two.text();
    answerFirst(new Response('one', { status: 200 }));
    await (await one).text();
    expect(exchanges.map((e) => e.path)).toEqual(['/one', '/two']);
    expect(exchanges.map((e) => Buffer.from(e.bodyBase64, 'base64').toString())).toEqual(['one', 'two']);
  });

  it('keeps nothing for a request that got no response', async () => {
    const exchanges: RecordedExchange[] = [];
    const live = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(recordingFetch(exchanges, live)('https://api.example/v1/messages')).rejects.toThrow('fetch failed');
    expect(exchanges).toEqual([]);
  });
});

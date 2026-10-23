/**
 * A live-call turn's response: a server-sent event stream, kept alive while
 * the turn has nothing to say (a tool call, an answer from the page), so the
 * call service's silence deadline is never reached by a turn that is working.
 */
import type { ServerResponse } from 'node:http';
import type { LiveCallStreamEventName, LiveCallStreamEvents } from './protocol.js';

/** How long the stream may be silent before a `: keep-alive` comment is sent. */
export const DEFAULT_KEEP_ALIVE_MS = 5_000;

export interface LiveCallEventStream {
  /** Sends one event. Does nothing once the stream is closed, by either end. */
  send<E extends LiveCallStreamEventName>(event: E, data: LiveCallStreamEvents[E]): void;
  /** Ends the response. */
  end(): void;
  /** Whether events can still be sent: the response has not ended and the caller has not gone. */
  open(): boolean;
}

/** Answers `200 text/event-stream` on `res` at once, and returns the stream. */
export function openLiveCallEventStream(res: ServerResponse, keepAliveMs: number = DEFAULT_KEEP_ALIVE_MS): LiveCallEventStream {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // A proxy in front of the product must pass each event on as it is written.
    'x-accel-buffering': 'no',
  });
  res.flushHeaders();
  // Each event is written as soon as it is produced: a reply's first words are what the caller waits on.
  res.socket?.setNoDelay(true);

  const open = () => !res.writableEnded && !res.destroyed;
  const keepAlive = setTimeout(function beat() {
    if (!open()) return;
    res.write(': keep-alive\n\n');
    keepAlive.refresh();
  }, keepAliveMs);
  const stop = () => clearTimeout(keepAlive);
  res.once('close', stop);

  const write = (chunk: string) => {
    if (!open()) return;
    res.write(chunk);
    // The silence is counted from the last thing written.
    keepAlive.refresh();
  };

  return {
    send(event, data) {
      write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    end() {
      stop();
      if (open()) res.end();
    },
    open,
  };
}

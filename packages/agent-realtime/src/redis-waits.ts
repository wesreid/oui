/**
 * Waiting on something another instance may store: the mechanism the UI
 * action result store and the settlement store share.
 *
 * A value is stored in Redis and its id published on a channel. A wait reads
 * it at once, then again each time its id is published, and once more at its
 * deadline in case a notification was missed. Waits on one instance share one
 * subscription.
 */
import type { RealtimeLogger } from './logger.js';

/** The Redis commands the stores use. ioredis satisfies it. */
export interface ResultsRedis {
  set(key: string, value: string, ex: 'EX', seconds: number, nx: 'NX'): Promise<'OK' | null>;
  get(key: string): Promise<string | null>;
  publish(channel: string, message: string): Promise<number>;
}

/** A connection in subscriber mode. ioredis satisfies it. */
export interface ResultsSubscriber {
  subscribe(channel: string): Promise<unknown>;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
}

export interface WaitHub {
  /**
   * `read()`'s value once it has one, reading at once, on every publish of
   * `id`, and at the deadline; null when it has none by `waitMs`.
   */
  wait<T>(id: string, waitMs: number, read: () => Promise<T | null>, onReadError: (err: unknown) => void): Promise<T | null>;
  /** Waits in progress on this instance. */
  pendingCount(): number;
}

export function createWaitHub(subscriber: ResultsSubscriber, channel: string, logger: RealtimeLogger, label: string): WaitHub {
  const waiters = new Map<string, Set<() => void>>();

  subscriber.on('message', (ch, id) => {
    if (ch !== channel) return;
    const pending = waiters.get(id);
    if (!pending) return;
    for (const wake of [...pending]) wake();
  });
  subscriber.subscribe(channel).catch((err: unknown) => {
    logger.error({ err }, `${label}: subscribe failed — waits will only see what was stored before they began`);
  });

  return {
    async wait<T>(id: string, waitMs: number, read: () => Promise<T | null>, onReadError: (err: unknown) => void): Promise<T | null> {
      const now = await read();
      if (now || waitMs <= 0) return now;

      return new Promise<T | null>((resolve) => {
        let done = false;
        const finish = (value: T | null) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          const set = waiters.get(id);
          set?.delete(wake);
          if (set && set.size === 0) waiters.delete(id);
          resolve(value);
        };
        const wake = () => {
          read().then((r) => {
            if (r) finish(r);
          }, onReadError);
        };
        const timer = setTimeout(() => {
          // One last look before giving up, in case the notification was missed.
          read().then(finish, () => finish(null));
        }, waitMs);

        let set = waiters.get(id);
        if (!set) {
          set = new Set();
          waiters.set(id, set);
        }
        set.add(wake);
        // Close the gap between the first read and registering the waiter: a
        // value stored in between was published before anyone was listening.
        wake();
      });
    },

    pendingCount() {
      let n = 0;
      for (const set of waiters.values()) n += set.size;
      return n;
    },
  };
}

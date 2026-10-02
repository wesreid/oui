/**
 * HTTP emit adapter — sends events to a realtime server via HTTP POST /api/emit.
 * This is the default adapter used when the worker runs as a Lambda/container
 * and the realtime server is a separate process.
 */
import type { RealtimeEmitAdapter } from './types.js';

export interface HttpEmitAdapterConfig {
  url: string;
  apiKey: string;
  timeoutMs?: number;
}

export function createHttpEmitAdapter(config: HttpEmitAdapterConfig): RealtimeEmitAdapter {
  const { url, apiKey, timeoutMs = 5000 } = config;
  // No silent no-op: an adapter without a URL used to drop every event, so a
  // misconfigured worker streamed its turns to nobody.
  requireRealtime(url, apiKey);

  return {
    async emit(room: string, event: string, data: unknown): Promise<void> {
      try {
        const res = await fetch(`${url}/api/emit`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Api-Key': apiKey,
          },
          body: JSON.stringify({ event, data, rooms: [room] }),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!res.ok) {
          console.warn(`[agent-worker] Emit failed: ${res.status} for event ${event}`);
        }
      } catch (error) {
        console.warn(`[agent-worker] Emit error for ${event}:`, error instanceof Error ? error.message : error);
      }
    },
  };
}

/** Throws, naming the value, unless the realtime server's URL and key are both given. */
export function requireRealtime(url: string | undefined, apiKey: string | undefined): void {
  const missing = [!url && 'realtime.url', !apiKey && 'realtime.apiKey'].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`[agent-sdk] Missing required configuration: ${missing.join(', ')} (the realtime server that carries turns and UI actions)`);
  }
}

/**
 * Realtime emit adapter — how the worker sends events to connected clients.
 * Default implementation: HTTP POST to a Socket.IO server's /api/emit endpoint.
 * Platforms can provide custom adapters (direct Socket.IO, Redis pub/sub, etc.).
 */

export interface RealtimeEmitAdapter {
  emit(room: string, event: string, data: unknown): Promise<void>;
}

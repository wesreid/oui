/**
 * A fixture product with no Closure code in it: its own users, its own rooms,
 * its own event declarations (fixture-events.ts), the SDK realtime server on a
 * real Redis following them, and a browser tab whose OUI surface runtime
 * answers UI actions and checks approvals as a real tab's does. The fixture
 * turns run against it.
 */
import { io as connectClient, type Socket } from 'socket.io-client';
import { createWebSocketTransport } from 'oui-spec/transport';
import { createSurfaceRuntime, defineSurface, type ActionHandlerResult, type MountedSurface } from 'oui-spec/core';
import type { OUIAction, OUIActionRequest, OUISurface } from 'oui-spec/spec';
import { APPROVAL_DECIDE_EVENT, type ApprovalDecideResult, type ApprovalDecision } from '@ouispec/agent-core';
import { createRealtimeServer, type RealtimeServerInstance, type RoomPolicy } from '@ouispec/agent-realtime';
import { startTestRedis, type TestRedis } from '@ouispec/agent-realtime/testing';
import { MANIFEST_VERSION, resolveKnowledge, type GeneratedKnowledge } from '@ouispec/bindings';
import { fixtureEvents } from './fixture-events.js';

export const INTERNAL_KEY = 'fixture-product-internal-key';
const TOKEN_SECRET = 'fixture-product-room-token-secret-000';
export const APPROVAL_KEY = 'fixture-product-approval-signing-key-01';

/** The product's users, keyed by the session token its browser holds. */
const SESSIONS: Record<string, { userId: string; accountId: string }> = {
  'session-ana': { userId: 'ana', accountId: 'desk-1' },
};

/** The product's rooms: `member:{id}` by identity, `chat:turn:{id}` and `export:{id}` by token. */
const policy: RoomPolicy = {
  isValidRoom: (room) => /^member:[a-z0-9-]+$|^chat:turn:[a-zA-Z0-9-]+$|^export:[a-zA-Z0-9-]+$/.test(room),
  identityRooms: (user) => [`member:${user.userId}`],
  requiresToken: (room) => room.startsWith('chat:turn:') || room.startsWith('export:'),
  canJoin: (room, user) => room === `member:${user.userId}`,
};

// ─── The product's pages, as OUI surfaces ───────────────────────────────────

export const shellSurface: OUISurface = {
  id: 'app-shell',
  name: 'App Shell',
  description: 'The frame around every page',
  actions: [
    {
      id: 'navigate',
      description: 'Go to a page',
      input: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  ],
};
export const inboxSurface: OUISurface = { id: 'inbox', name: 'Inbox', description: 'Messages', actions: [] };
/**
 * An irreversible external act (ADR-0226 §2.6 `transaction`): a report, once
 * emailed, cannot be unsent. Its title, consequence and argument labels are
 * what the approval card shows (ADR-0228 §2.2).
 */
export const sendReportAction = {
  id: 'reports_send',
  title: 'Send a report',
  description: 'Emails a saved report to a recipient. Once sent it cannot be unsent.',
  effect: 'transaction',
  input: {
    type: 'object',
    properties: {
      reportId: { type: 'string', title: 'Report' },
      to: { type: 'string', title: 'Recipient', description: 'An email address' },
    },
    required: ['reportId', 'to'],
    additionalProperties: false,
  },
} satisfies OUIAction;
export const reportsSurface: OUISurface = {
  id: 'reports',
  name: 'Reports',
  description: 'Saved reports',
  actions: [{ id: 'reports_export', description: 'Export a report', input: { type: 'object', properties: {} } }, sendReportAction],
  observations: [{ id: 'reports', description: 'The saved reports, newest first', schema: { type: 'array' } }],
};
/** What the Reports page shows: it reports this as its `reports` observation while it is open. */
export const SAVED_REPORTS = [
  { id: 'q3', title: 'Q3 results' },
  { id: 'q2', title: 'Q2 results' },
];

/** What each page offers once the tab is on it. */
const PAGES: Record<string, OUISurface[]> = {
  '/inbox': [shellSurface, inboxSurface],
  '/reports': [shellSurface, reportsSurface],
};

/**
 * The knowledge the product's generator emits from its UI code (ADR-0220,
 * ADR-0226): the app's map, and each page in full. A tab resolves it for the
 * page it is on and sends it with the turn as `context.uiKnowledge`.
 */
export const DESK_KNOWLEDGE: GeneratedKnowledge = {
  version: MANIFEST_VERSION,
  buildId: 'desk-build-1',
  overview: { title: 'Desk', content: 'Pages: Inbox (/inbox), Reports (/reports).' },
  pages: [
    {
      surface: 'inbox',
      routes: ['/inbox'],
      summary: { title: 'Inbox', content: 'Messages sent to the user.' },
      detail: { title: 'Inbox, in full', content: 'Lists messages newest first. Reports are on the Reports page.' },
      relationships: null,
      recipes: [{ name: 'Find a report', trigger: 'The user asks for a report', steps: ['Go to /reports', 'Read the reports observation'] }],
      adjacent: ['reports'],
    },
    {
      surface: 'reports',
      routes: ['/reports'],
      summary: { title: 'Reports', content: 'Saved reports: export one, or email it.' },
      detail: { title: 'Reports, in full', content: 'Export a report with reports_export; email one with reports_send.' },
      relationships: null,
      recipes: [],
      adjacent: ['inbox'],
    },
  ],
};

// ─── The browser tab ────────────────────────────────────────────────────────

export interface FixtureTab {
  socket: Socket;
  /** Put the tab on a page (`/inbox`, `/reports`): the surfaces it mounts are the ones its runtime answers for. */
  show(path: string): void;
  /** Join another turn's room, as the tab does for each turn it sends. */
  joinTurn(turnRoom: string): Promise<void>;
  /** The user's click on the approval card: `approval:decide` on this tab's own socket. */
  decide(approvalId: string, decision: ApprovalDecision): Promise<ApprovalDecideResult>;
  /** UI action requests the tab received. */
  dispatches: OUIActionRequest[];
  /** Every server event the tab received, in order. */
  events: Array<{ event: string; data: unknown }>;
  /** Resolves when an event with this name arrives (or has arrived). */
  waitFor(event: string, timeoutMs?: number): Promise<unknown>;
  /** The same, for the event of one turn: its `turnId`. */
  waitForTurn(event: string, turnId: string, timeoutMs?: number): Promise<unknown>;
  /** The events one turn sent the tab, in order. */
  turnEvents(turnId: string): Array<{ event: string; data: unknown }>;
  close(): void;
}

async function openTab(server: RealtimeServerInstance, session: string, firstTurnRoom: string): Promise<FixtureTab> {
  const socket = connectClient(`http://127.0.0.1:${server.port}`, {
    auth: { token: session },
    transports: ['websocket'],
    reconnection: false,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });

  const events: FixtureTab['events'] = [];
  const waiters: Array<{ event: string; match: (d: unknown) => boolean; resolve: (d: unknown) => void }> = [];
  socket.onAny((event: string, data: unknown) => {
    events.push({ event, data });
    for (const w of waiters.filter((w) => w.event === event && w.match(data))) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(data);
    }
  });
  const ofTurn = (turnId: string) => (d: unknown) => (d as { turnId?: unknown } | null)?.turnId === turnId;
  const waitFor = (event: string, match: (d: unknown) => boolean, timeoutMs: number) => {
    const seen = events.find((e) => e.event === event && match(e.data));
    if (seen) return Promise.resolve(seen.data);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`tab saw no ${event} within ${timeoutMs} ms`)), timeoutMs);
      waiters.push({
        event,
        match,
        resolve: (d) => {
          clearTimeout(timer);
          resolve(d);
        },
      });
    });
  };

  // The product's API asks for the turn room's token after authorizing the
  // user; the tab joins with it.
  const joinTurn = async (turnRoom: string) => {
    const res = await fetch(`http://127.0.0.1:${server.port}/internal/room-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': INTERNAL_KEY },
      body: JSON.stringify({ userId: SESSIONS[session].userId, room: turnRoom }),
    });
    const { token } = (await res.json()) as { token: string };
    const joined = await new Promise<{ ok: boolean }>((resolve) =>
      socket.emit('subscribe', { rooms: [turnRoom], tokens: { [turnRoom]: token } }, resolve),
    );
    if (!joined.ok) throw new Error(`fixture tab could not join ${turnRoom}`);
  };
  await joinTurn(firstTurnRoom);

  // OUI's own surface runtime answers every UI action with its real result
  // (ADR-0209), and runs an approval-requiring one only on this tab's grant
  // (ADR-0228 §2.2.6). The requests are also kept, as the wire carried them.
  const runtime = createSurfaceRuntime({ announce: false, settle: { quietMs: 10, timeoutMs: 1_000 } });
  let mounted: MountedSurface[] = [];
  let shownPath = '';
  const show = (path: string) => {
    if (path === shownPath) return;
    const surfaces = PAGES[path];
    if (!surfaces) throw new Error(`the fixture has no page ${path}`);
    for (const m of mounted) m.unmount();
    mounted = surfaces.map((surface) => runtime.mount(withHandlers(surface, show), () => ({})));
    // A page reports what it shows, as a real one does.
    mounted.find((m) => m.surfaceId === reportsSurface.id)?.pushObservation('reports', SAVED_REPORTS);
    shownPath = path;
  };
  show('/inbox');
  runtime.attach(socket);
  const dispatches: OUIActionRequest[] = [];
  const transport = createWebSocketTransport(socket);
  transport.onAction((request) => dispatches.push(request));

  return {
    socket,
    joinTurn,
    show,
    // As the approval card does: the decision on the user's own socket, and an
    // approval's grant handed to this tab's runtime.
    decide: (approvalId, decision) =>
      new Promise((resolve) =>
        socket.emit(APPROVAL_DECIDE_EVENT, { approvalId, decision }, (result: ApprovalDecideResult) => {
          if (result.ok && result.decision === 'approve') {
            runtime.grantApproval({ approvalId, argsHash: result.argsHash, expiresAt: result.expiresAt });
          }
          resolve(result);
        }),
      ),
    dispatches,
    events,
    waitFor: (event, timeoutMs = 5_000) => waitFor(event, () => true, timeoutMs),
    waitForTurn: (event, turnId, timeoutMs = 5_000) => waitFor(event, ofTurn(turnId), timeoutMs),
    turnEvents: (turnId) => events.filter((e) => ofTurn(turnId)(e.data)),
    close() {
      transport.dispose();
      runtime.dispose();
      socket.disconnect();
    },
  };
}

/** A page's surface with what its actions really do on this tab. */
function withHandlers(surface: OUISurface, show: (path: string) => void) {
  const handlers: Record<string, (params: Record<string, unknown>) => ActionHandlerResult> = {
    navigate: (params) => {
      const path = String(params.path ?? '');
      if (!PAGES[path]) return { success: false, error: { code: 'NOT_FOUND', message: `No page at ${path}` } };
      show(path);
      return { success: true, data: { navigatedTo: path } };
    },
    reports_send: (params) => ({ success: true, data: { sent: true, reportId: params.reportId, to: params.to } }),
    reports_export: () => ({ success: true, data: { exported: true } }),
  };
  return defineSurface({
    ...surface,
    actions: surface.actions.map((action) => ({
      ...action,
      handler: async (params: Record<string, unknown>) =>
        handlers[action.id]?.(params) ?? { success: false, error: { code: 'NOT_FOUND', message: `No action ${action.id}` } },
    })),
  });
}

// ─── The product ────────────────────────────────────────────────────────────

export interface FixtureProduct {
  realtimeUrl: string;
  /** Calls the realtime server's internal API with the product's key, as its backend does. */
  internal(path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
  openTab(session: string, turnRoom: string): Promise<FixtureTab>;
  /** The product's backend emitting one of its events, as its job pipeline does. Returns the HTTP status. */
  emit(event: string, data: unknown, rooms: string[]): Promise<number>;
  stop(): Promise<void>;
}

export async function startFixtureProduct(): Promise<FixtureProduct> {
  const redis: TestRedis = await startTestRedis();
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  const server = await createRealtimeServer({
    auth: {
      async verify(token) {
        const user = SESSIONS[token];
        if (!user) throw new Error('unknown session');
        return user;
      },
    },
    roomPolicy: policy,
    internalApiKey: INTERNAL_KEY,
    roomTokens: { secret: TOKEN_SECRET },
    approvals: { signingKey: APPROVAL_KEY },
    redis: redis.config,
    events: fixtureEvents,
    corsOrigins: ['http://localhost'],
    port: 0,
    logger: quiet,
  });
  const tabs: FixtureTab[] = [];
  const realtimeUrl = `http://127.0.0.1:${server.port}`;
  return {
    realtimeUrl,
    async internal(path, body) {
      const res = await fetch(`${realtimeUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': INTERNAL_KEY },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
    },
    async openTab(session, turnRoom) {
      const tab = await openTab(server, session, turnRoom);
      tabs.push(tab);
      return tab;
    },
    async emit(event, data, rooms) {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/emit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': INTERNAL_KEY },
        body: JSON.stringify({ event, data, rooms }),
      });
      return res.status;
    },
    async stop() {
      tabs.forEach((t) => t.close());
      await server.close();
      await redis.stop();
    },
  };
}

// ─── The fixture turn ───────────────────────────────────────────────────────

export const FIXTURE_TURN = {
  turnId: 'turn-fx-1',
  conversationId: 'conv-fx-1',
  userId: 'ana',
  accountId: 'desk-1',
  socketRoom: 'chat:turn:turn-fx-1',
  content: 'Open my reports',
  // What a UI client sends with each turn: its surfaces (ADR-0209), and the
  // generated knowledge for the page it is on.
  context: {
    currentPath: '/inbox',
    oui: { surfaces: [shellSurface, inboxSurface], observations: {} },
    uiKnowledge: resolveKnowledge(DESK_KNOWLEDGE, '/inbox'),
  },
} as const;

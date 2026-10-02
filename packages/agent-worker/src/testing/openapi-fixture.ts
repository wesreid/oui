/**
 * A fixture product's API, for testing generated API tools end to end without any
 * real product: an OpenAPI 3.1 document, and a real HTTP server that authenticates
 * its callers and enforces each operation's permissions itself.
 *
 * "Desk" is a small trading desk:
 * - some operations are opted in for agents (`x-agent`), some are not;
 * - its users hold different permissions, so a call the user may not make comes
 *   back as the route's own 403;
 * - its backend agents act as a user through a signed header (the product's
 *   implementation of the SDK's `actAs` seam), and its people and MCP clients
 *   through a session bearer token.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { OpenApiDocument, SecurityRequirement } from '../openapi/document.js';

// ─── The product's people ───────────────────────────────────────────────────

export interface DeskUser {
  userId: string;
  accountId: string;
  permissions: string[];
}

export const DESK_USERS: Record<string, DeskUser> = {
  ana: { userId: 'ana', accountId: 'desk-1', permissions: ['orders:read', 'orders:write', 'reports:run', 'watchlists:read'] },
  bo: {
    userId: 'bo',
    accountId: 'desk-1',
    permissions: ['orders:read', 'watchlists:read', 'watchlists:write'],
  },
};

/** Session tokens the product's own sign-in issued, e.g. to an MCP client. */
export const DESK_SESSIONS: Record<string, string> = {
  'session-ana': 'ana',
  'session-bo': 'bo',
};

const AGENT_HEADER = 'x-desk-agent';
const AGENT_KEY = 'desk-fixture-agent-signing-key';

function sign(userId: string, accountId: string): string {
  return createHmac('sha256', AGENT_KEY).update(`${userId}.${accountId}`).digest('base64url');
}

/**
 * The product's way for a backend agent to act as a user: a signed header naming the
 * user and account. Pass it to `loadOpenApiTools` as `actAs`.
 */
export function deskAgentHeaders(ctx: { userId: string; accountId: string }): Record<string, string> {
  return { [AGENT_HEADER]: `${ctx.userId}.${ctx.accountId}.${sign(ctx.userId, ctx.accountId)}` };
}

// ─── The product's API document ─────────────────────────────────────────────

const AUTHENTICATED = (...permissions: string[]): SecurityRequirement[] => [{ session: permissions }, { agent: permissions }];

export function deskOpenApiDocument(): OpenApiDocument {
  return {
    openapi: '3.1.0',
    info: { title: 'Desk API', version: '1.0.0' },
    components: {
      securitySchemes: {
        session: { type: 'http', scheme: 'bearer' },
        agent: { type: 'apiKey', in: 'header', name: AGENT_HEADER },
      },
      parameters: {
        Limit: {
          name: 'limit',
          in: 'query',
          description: 'How many to return, at most',
          schema: { type: 'integer', minimum: 1, maximum: 100 },
        },
        WatchlistId: { name: 'watchlistId', in: 'path', required: true, schema: { type: 'string', minLength: 1 } },
      },
      schemas: {
        Side: { type: 'string', enum: ['buy', 'sell'] },
        Order: {
          type: 'object',
          properties: {
            id: { type: 'string', readOnly: true },
            symbol: { type: 'string', pattern: '^[A-Z]{1,5}$', description: 'Ticker symbol' },
            side: { $ref: '#/components/schemas/Side' },
            quantity: { type: 'integer', minimum: 1 },
            limitPrice: { type: ['number', 'null'], exclusiveMinimum: 0, description: 'Leave out for a market order' },
            status: { type: 'string', readOnly: true },
          },
          required: ['id', 'symbol', 'side', 'quantity', 'status'],
          additionalProperties: false,
        },
      },
    },
    paths: {
      '/v1/orders': {
        get: {
          operationId: 'listOrders',
          summary: 'List your orders',
          description: 'Your own orders, newest first.',
          parameters: [
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['open', 'filled', 'cancelled'] } },
            { $ref: '#/components/parameters/Limit' },
          ],
          security: AUTHENTICATED('orders:read'),
          'x-agent': { expose: true, effect: 'view', pa: true },
          responses: { '200': { description: 'Orders' } },
        },
        post: {
          operationId: 'placeOrder',
          summary: 'Place an order',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } },
          },
          security: AUTHENTICATED('orders:write'),
          'x-agent': { expose: true, effect: 'transaction', consequence: 'Sends a live order to the exchange.' },
          responses: { '201': { description: 'The order' } },
        },
      },
      '/v1/orders/{orderId}': {
        parameters: [{ name: 'orderId', in: 'path', required: true, schema: { type: 'string' } }],
        get: {
          operationId: 'getOrder',
          summary: 'Get one of your orders',
          security: AUTHENTICATED('orders:read'),
          'x-agent': { expose: true, effect: 'view' },
          responses: { '200': { description: 'The order' } },
        },
      },
      '/v1/quotes/{symbol}': {
        get: {
          operationId: 'getQuote',
          summary: 'Get the latest quote for a symbol',
          parameters: [{ name: 'symbol', in: 'path', required: true, schema: { type: 'string', pattern: '^[A-Z]{1,5}$' } }],
          security: AUTHENTICATED('orders:read'),
          'x-agent': { expose: true, effect: 'view', pa: true },
          responses: { '200': { description: 'The quote' } },
        },
      },
      '/v1/watchlists/{watchlistId}': {
        patch: {
          operationId: 'renameWatchlist',
          summary: 'Rename a watchlist',
          parameters: [{ $ref: '#/components/parameters/WatchlistId' }],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { name: { type: 'string', minLength: 1, maxLength: 60 } },
                  required: ['name'],
                  additionalProperties: false,
                },
              },
            },
          },
          security: AUTHENTICATED('watchlists:write'),
          'x-agent': { expose: true, effect: 'mutate' },
          responses: { '200': { description: 'The watchlist' } },
        },
        delete: {
          operationId: 'deleteWatchlist',
          summary: 'Delete a watchlist',
          parameters: [{ $ref: '#/components/parameters/WatchlistId' }],
          security: AUTHENTICATED('watchlists:write'),
          'x-agent': { expose: true, effect: 'mutate', destructive: true, consequence: 'The watchlist and its symbols are gone.' },
          responses: { '204': { description: 'Deleted' } },
        },
      },
      '/v1/reports': {
        post: {
          operationId: 'runReport',
          summary: 'Run a report',
          description: 'Starts a report export; it is ready when its job completes.',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    kind: { type: 'string', enum: ['pnl', 'exposure'] },
                    from: { type: 'string', format: 'date' },
                  },
                  required: ['kind', 'from'],
                  additionalProperties: false,
                },
              },
            },
          },
          security: AUTHENTICATED('reports:run'),
          'x-agent': { expose: true, effect: 'job' },
          // The completion it waits on is declared in DESK_EVENTS (desk-events.ts).
          'x-async-binding': { event: 'report:ready', room: 'export:{exportId}', timeout: '20s' },
          responses: { '202': { description: 'Queued' } },
        },
      },
      '/v1/admin/users': {
        get: {
          operationId: 'listUsers',
          summary: 'List every user on the desk',
          security: AUTHENTICATED('admin'),
          responses: { '200': { description: 'Users' } },
        },
      },
      '/v1/admin/reindex': {
        post: {
          operationId: 'reindex',
          summary: 'Rebuild the search index',
          security: AUTHENTICATED('admin'),
          'x-agent': { expose: false },
          responses: { '202': { description: 'Started' } },
        },
      },
      '/v1/health': {
        get: { operationId: 'getHealth', summary: 'Health', security: [], responses: { '200': { description: 'OK' } } },
      },
    },
  };
}

/** The operations the document opts in for agents, and those it opts in for the product's own assistant. */
export const DESK_AGENT_OPERATIONS = [
  'listOrders',
  'placeOrder',
  'getOrder',
  'getQuote',
  'renameWatchlist',
  'deleteWatchlist',
  'runReport',
] as const;
export const DESK_PA_OPERATIONS = ['listOrders', 'getQuote'] as const;

// ─── The product's server ───────────────────────────────────────────────────

export interface DeskRequest {
  method: string;
  path: string;
  query: Record<string, string[]>;
  headers: Record<string, string>;
  body: unknown;
  /** Who the server authenticated the request as, or null. */
  caller: string | null;
}

export interface DeskApiOptions {
  /**
   * Called when a report export is queued, after its 202 is sent: the product's
   * pipeline, which ends the job some time later with a declared event.
   */
  onReportQueued?: (exportId: string, caller: DeskUser) => void;
}

export interface DeskApi {
  baseUrl: string;
  document: OpenApiDocument;
  /** Every request the server received, in order. */
  requests: DeskRequest[];
  close(): Promise<void>;
}

interface Order {
  id: string;
  owner: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  limitPrice: number | null;
  status: 'open' | 'filled' | 'cancelled';
}

function authenticate(req: IncomingMessage): DeskUser | null {
  const agent = req.headers[AGENT_HEADER];
  if (typeof agent === 'string') {
    const [userId, accountId, mac] = agent.split('.');
    if (!userId || !accountId || !mac) return null;
    const expected = Buffer.from(sign(userId, accountId));
    const given = Buffer.from(mac);
    const user = DESK_USERS[userId];
    if (!user || user.accountId !== accountId || expected.length !== given.length || !timingSafeEqual(expected, given)) {
      return null;
    }
    return user;
  }
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
  const userId = bearer ? DESK_SESSIONS[bearer] : undefined;
  return userId ? (DESK_USERS[userId] ?? null) : null;
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Start Desk's API on a free local port. */
export async function startDeskApi(options: DeskApiOptions = {}): Promise<DeskApi> {
  const requests: DeskRequest[] = [];
  const orders: Order[] = [
    { id: 'o-1', owner: 'ana', symbol: 'ACME', side: 'buy', quantity: 10, limitPrice: 12.5, status: 'open' },
    { id: 'o-2', owner: 'ana', symbol: 'INIT', side: 'sell', quantity: 3, limitPrice: null, status: 'filled' },
    { id: 'o-3', owner: 'bo', symbol: 'ACME', side: 'sell', quantity: 7, limitPrice: 13, status: 'open' },
  ];
  const watchlists = new Map([['w-1', { id: 'w-1', accountId: 'desk-1', name: 'Tech' }]]);
  let nextId = 4;

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://desk.local');
      const query: Record<string, string[]> = {};
      for (const [key, value] of url.searchParams) (query[key] ??= []).push(value);
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers[key] = value;
      let body: unknown;
      try {
        body = await readBody(req);
      } catch {
        send(res, 400, { error: { message: 'The body is not JSON' } });
        return;
      }
      const user = authenticate(req);
      requests.push({ method: req.method ?? '', path: url.pathname, query, headers, body, caller: user?.userId ?? null });

      const route = `${req.method} ${url.pathname}`;
      if (route === 'GET /v1/health') return send(res, 200, { ok: true });
      if (!user) return send(res, 401, { error: { message: 'Sign in first' } });
      const need = (permission: string) => {
        if (user.permissions.includes(permission)) return true;
        send(res, 403, { error: { message: `Missing permission ${permission}` } });
        return false;
      };

      let match: RegExpExecArray | null;
      if (route === 'GET /v1/orders') {
        if (!need('orders:read')) return;
        const status = query.status?.[0];
        const limit = Number(query.limit?.[0] ?? 100);
        const mine = orders.filter((o) => o.owner === user.userId && (!status || o.status === status));
        return send(res, 200, { orders: mine.slice(0, limit).map(({ owner: _owner, ...o }) => o) });
      }
      if (route === 'POST /v1/orders') {
        if (!need('orders:write')) return;
        const input = body as Partial<Order>;
        const order: Order = {
          id: `o-${nextId++}`,
          owner: user.userId,
          symbol: String(input.symbol),
          side: input.side === 'sell' ? 'sell' : 'buy',
          quantity: Number(input.quantity),
          limitPrice: input.limitPrice ?? null,
          status: 'open',
        };
        orders.push(order);
        const { owner: _owner, ...shown } = order;
        return send(res, 201, shown);
      }
      if ((match = /^GET \/v1\/orders\/([^/]+)$/.exec(route))) {
        if (!need('orders:read')) return;
        const order = orders.find((o) => o.id === decodeURIComponent(match![1]!) && o.owner === user.userId);
        if (!order) return send(res, 404, { error: { message: 'No such order' } });
        const { owner: _owner, ...shown } = order;
        return send(res, 200, shown);
      }
      if ((match = /^GET \/v1\/quotes\/([^/]+)$/.exec(route))) {
        if (!need('orders:read')) return;
        return send(res, 200, { symbol: decodeURIComponent(match[1]!), bid: 12.4, ask: 12.6 });
      }
      if ((match = /^(PATCH|DELETE) \/v1\/watchlists\/([^/]+)$/.exec(route))) {
        if (!need('watchlists:write')) return;
        const list = watchlists.get(decodeURIComponent(match[2]!));
        if (!list || list.accountId !== user.accountId) return send(res, 404, { error: { message: 'No such watchlist' } });
        if (match[1] === 'DELETE') {
          watchlists.delete(list.id);
          return send(res, 204);
        }
        list.name = String((body as { name?: unknown }).name);
        return send(res, 200, list);
      }
      if (route === 'POST /v1/reports') {
        if (!need('reports:run')) return;
        const exportId = `exp-${nextId++}`;
        send(res, 202, { exportId, status: 'queued' });
        options.onReportQueued?.(exportId, user);
        return;
      }
      if (route === 'GET /v1/admin/users' || route === 'POST /v1/admin/reindex') {
        if (!need('admin')) return;
        return send(res, 200, {});
      }
      return send(res, 404, { error: { message: `No route ${route}` } });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    document: deskOpenApiDocument(),
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

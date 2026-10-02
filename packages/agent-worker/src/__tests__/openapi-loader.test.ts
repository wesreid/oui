/**
 * The OpenAPI loader refuses, at load and naming the operation, anything it cannot
 * turn into a safe, callable tool. A misdeclared operation fails the host's start-up;
 * it is never quietly dropped or quietly exposed.
 */
import { describe, expect, it } from 'vitest';
import { loadOpenApiTools, type OpenApiToolsOptions } from '../openapi/index.js';
import type { OpenApiDocument, OpenApiOperation } from '../openapi/document.js';
import type { ToolExecutionContext } from '../tools/types.js';
import { deskEvents } from '../testing/index.js';

const ctx: ToolExecutionContext = { userId: 'u1', accountId: 'a1', turnId: 't1', conversationId: 'c1' };

function doc(path: string, method: string, operation: OpenApiOperation, extra: Partial<OpenApiDocument> = {}): OpenApiDocument {
  return {
    openapi: '3.1.0',
    info: { title: 'T', version: '1' },
    components: { securitySchemes: { key: { type: 'apiKey', in: 'header', name: 'x-key' } }, ...extra.components },
    paths: { [path]: { [method]: operation } },
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'components')),
  };
}

const SECURED = { security: [{ key: ['things:read'] }] };
const options = (overrides: Partial<OpenApiToolsOptions> = {}): OpenApiToolsOptions => ({
  baseUrl: 'https://api.example.test',
  actAs: () => ({ 'x-key': 'k' }),
  audience: 'agents',
  ...overrides,
});
const load = (d: OpenApiDocument, o: Partial<OpenApiToolsOptions> = {}) => loadOpenApiTools(d, options(o));

describe('refusals at load', () => {
  it('refuses pa: true on anything but a read, naming the operation', () => {
    expect(() =>
      load(doc('/things/{id}', 'patch', {
        operationId: 'updateThing',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        ...SECURED,
        'x-agent': { expose: true, effect: 'mutate', pa: true },
      })),
    ).toThrow('PATCH /things/{id} (updateThing): x-agent.pa is allowed only on a read-only operation (effect view); this one is mutate, a write');
    expect(() =>
      load(doc('/jobs', 'post', { operationId: 'startJob', ...SECURED, 'x-agent': { expose: true, effect: 'job', pa: true } })),
    ).toThrow(/startJob.*pa.*job, a write/);
  });

  it('refuses pa: true on an operation that is not exposed', () => {
    expect(() =>
      load(doc('/things', 'get', { operationId: 'listThings', ...SECURED, 'x-agent': { effect: 'view', pa: true } })),
    ).toThrow(/listThings.*pa.*expose: true/);
  });

  it('refuses an exposed operation without a usable name', () => {
    expect(() => load(doc('/things', 'get', { ...SECURED, 'x-agent': { expose: true, effect: 'view' } }))).toThrow(
      'GET /things: an exposed operation needs an operationId, its tool name',
    );
    expect(() =>
      load(doc('/things', 'get', { operationId: 'list things!', ...SECURED, 'x-agent': { expose: true, effect: 'view' } })),
    ).toThrow(/operationId "list things!" is not a tool name/);
  });

  it('refuses two exposed operations with one operationId', () => {
    const d = doc('/a', 'get', { operationId: 'same', ...SECURED, 'x-agent': { expose: true, effect: 'view' } });
    d.paths['/b'] = { get: { operationId: 'same', ...SECURED, 'x-agent': { expose: true, effect: 'view' } } };
    expect(() => load(d)).toThrow(/GET \/b \(same\): operationId "same" is also GET \/a/);
  });

  it('refuses a misdeclared x-agent', () => {
    const op = (xAgent: unknown): OpenApiOperation => ({ operationId: 'op', ...SECURED, 'x-agent': xAgent });
    expect(() => load(doc('/x', 'get', op({ expose: true })))).toThrow('GET /x (op): x-agent.effect is required on an exposed operation');
    expect(() => load(doc('/x', 'get', op({ expose: true, effect: 'view', destuctive: true })))).toThrow(
      /x-agent has an unknown key "destuctive"/,
    );
    expect(() => load(doc('/x', 'get', op({ expose: 'yes', effect: 'view' })))).toThrow(/x-agent.expose is true or false/);
    expect(() => load(doc('/x', 'get', op('expose')))).toThrow(/x-agent is an object/);
    expect(() => load(doc('/x', 'post', op({ expose: true, effect: 'teleport' })))).toThrow(/"teleport" is not an effect/);
    expect(() => load(doc('/x', 'post', op({ expose: true, effect: 'mutate', consequence: '' })))).toThrow(
      /x-agent.consequence is a non-empty sentence/,
    );
  });

  it('refuses an effect only a page can have', () => {
    for (const effect of ['selection', 'edit', { kind: 'navigate', to: '/x' }, { kind: 'open', container: 'd' }]) {
      expect(() => load(doc('/x', 'post', { operationId: 'op', ...SECURED, 'x-agent': { expose: true, effect } }))).toThrow(
        /is a page's effect; an API operation's effect is one of view, file, mutate, job, transaction/,
      );
    }
  });

  it('refuses an effect object that names another operation, or is out of range', () => {
    expect(() =>
      load(doc('/x', 'post', {
        operationId: 'op',
        ...SECURED,
        'x-agent': { expose: true, effect: { kind: 'mutate', operation: 'other' } },
      })),
    ).toThrow(/effect names operation "other"; an operation's effect is its own/);
    expect(() =>
      load(doc('/x', 'post', {
        operationId: 'op',
        ...SECURED,
        'x-agent': { expose: true, effect: { kind: 'transaction', approvalMinutes: 40 } },
      })),
    ).toThrow(/approvalMinutes/);
  });

  it('refuses destructive on a read, and a read on a method that changes data', () => {
    expect(() =>
      load(doc('/x', 'get', { operationId: 'op', ...SECURED, 'x-agent': { expose: true, effect: 'view', destructive: true } })),
    ).toThrow(/x-agent.destructive applies only to a write/);
    for (const method of ['put', 'patch', 'delete']) {
      expect(() =>
        load(doc('/x', method, { operationId: 'op', ...SECURED, 'x-agent': { expose: true, effect: 'view' } })),
      ).toThrow(new RegExp(`${method.toUpperCase()} /x \\(op\\): effect view is read-only, but ${method.toUpperCase()} changes data`));
    }
  });

  it('refuses an exposed operation with no security requirement, or an undeclared scheme', () => {
    const op: OpenApiOperation = { operationId: 'op', 'x-agent': { expose: true, effect: 'view' } };
    expect(() => load(doc('/x', 'get', op))).toThrow(
      'GET /x (op): an exposed operation declares its security requirement (operation or document `security`; [] for a public one)',
    );
    // The document's default applies, and [] declares a public operation.
    expect(load(doc('/x', 'get', op, { security: [{ key: [] }] }))[0]!.operation.security).toEqual([{ key: [] }]);
    expect(load(doc('/x', 'get', { ...op, security: [] }))[0]!.operation.security).toEqual([]);
    expect(() => load(doc('/x', 'get', { ...op, security: [{ oauth: ['read'] }] }))).toThrow(
      /security names scheme "oauth", which components.securitySchemes does not declare/,
    );
  });

  it('refuses a body the executor cannot send, and a schema it cannot inline', () => {
    expect(() =>
      load(doc('/files', 'post', {
        operationId: 'upload',
        ...SECURED,
        requestBody: { content: { 'multipart/form-data': { schema: { type: 'object' } } } },
        'x-agent': { expose: true, effect: 'file' },
      })),
    ).toThrow(/upload\): its request body is multipart\/form-data; a tool sends JSON only/);

    const recursive = doc('/trees', 'post', {
      operationId: 'plant',
      ...SECURED,
      requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Tree' } } } },
      'x-agent': { expose: true, effect: 'mutate' },
    }, {
      components: {
        securitySchemes: { key: { type: 'apiKey', in: 'header', name: 'x-key' } },
        schemas: { Tree: { type: 'object', properties: { children: { type: 'array', items: { $ref: '#/components/schemas/Tree' } } } } },
      },
    });
    expect(() => load(recursive)).toThrow(/plant\): #\/components\/schemas\/Tree refers to itself/);

    expect(() =>
      load(doc('/x', 'post', {
        operationId: 'op',
        ...SECURED,
        requestBody: { content: { 'application/json': { schema: { $ref: 'other.yaml#/Thing' } } } },
        'x-agent': { expose: true, effect: 'mutate' },
      })),
    ).toThrow(/op\): \$ref "other.yaml#\/Thing" is not in this document/);
  });

  it('refuses a path whose template and parameters disagree', () => {
    expect(() =>
      load(doc('/things/{id}', 'get', { operationId: 'getThing', ...SECURED, 'x-agent': { expose: true, effect: 'view' } })),
    ).toThrow(/getThing\): the path names \{id\}, which no path parameter declares/);
  });

  it('checks unexposed operations too, so a typo cannot hide one', () => {
    expect(() =>
      load(doc('/x', 'get', { operationId: 'op', ...SECURED, 'x-agent': { expse: true, effect: 'view' } })),
    ).toThrow(/unknown key "expse"/);
  });

  it('refuses a document or options it cannot work with', () => {
    const good = doc('/x', 'get', { operationId: 'op', ...SECURED, 'x-agent': { expose: true, effect: 'view' } });
    expect(() => load({ ...good, openapi: '2.0' })).toThrow(/not an OpenAPI 3 document/);
    expect(() => load(good, { actAs: undefined as never })).toThrow(/actAs is required/);
    expect(() => load(good, { baseUrl: 'api.example.test' })).toThrow(/baseUrl .* absolute http\(s\) URL/);
    expect(() => load(good, { audience: undefined as never })).toThrow(/audience is "agents" or "pa"/);
  });
});

describe('OpenAPI 3.0 and parameter styles', () => {
  it('reads 3.0 nullable as JSON Schema null', () => {
    const [tool] = load({
      ...doc('/x', 'post', {
        operationId: 'op',
        ...SECURED,
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { note: { type: 'string', nullable: true, example: 'hi' }, tag: { nullable: true, enum: ['a', null] } },
              },
            },
          },
        },
        'x-agent': { expose: true, effect: 'mutate' },
      }),
      openapi: '3.0.3',
    });
    expect(tool!.inputSchema.properties).toEqual({
      note: { type: ['string', 'null'], examples: ['hi'] },
      tag: { enum: ['a', null] },
    });
  });

  it('nests a body that is not a closed object, or whose fields collide with a parameter, under `body`', () => {
    const [array] = load(doc('/x', 'post', {
      operationId: 'op',
      ...SECURED,
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'array', items: { type: 'string' } } } } },
      'x-agent': { expose: true, effect: 'mutate' },
    }));
    expect(array!.inputSchema).toMatchObject({ properties: { body: { type: 'array' } }, required: ['body'] });

    const [collide] = load(doc('/x/{id}', 'put', {
      operationId: 'op',
      ...SECURED,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } } },
      'x-agent': { expose: true, effect: 'mutate' },
    }));
    expect(Object.keys(collide!.inputSchema.properties as object)).toEqual(['id', 'body']);
  });

  it('serialises query arrays and objects as the operation declares, and asks actAs for header parameters', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchStub: typeof fetch = async (input, init) => {
      seen.push({ url: String(input), headers: init?.headers as Record<string, string> });
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const d = doc('/search/{kind}', 'get', {
      operationId: 'search',
      ...SECURED,
      parameters: [
        { name: 'kind', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'tag', in: 'query', schema: { type: 'array', items: { type: 'string' } } },
        { name: 'ids', in: 'query', explode: false, schema: { type: 'array', items: { type: 'integer' } } },
        { name: 'filter', in: 'query', style: 'deepObject', schema: { type: 'object', properties: { min: { type: 'number' } } } },
        { name: 'x-tenant', in: 'header', required: true, schema: { type: 'string' } },
      ],
      'x-agent': { expose: true, effect: 'view' },
    });
    const [tool] = load(d, { fetch: fetchStub, baseUrl: 'https://api.example.test/base/', actAs: () => ({ 'x-key': 'k', 'x-tenant': 't1' }) });
    expect(Object.keys(tool!.inputSchema.properties as object)).toEqual(['kind', 'tag', 'ids', 'filter']);

    const result = await tool!.execute({ kind: 'a b', tag: ['x', 'y'], ids: [1, 2], filter: { min: 3 } }, ctx);
    expect(result).toEqual({ success: true, data: { ok: true } });
    expect(seen[0]!.url).toBe('https://api.example.test/base/search/a%20b?tag=x&tag=y&ids=1%2C2&filter%5Bmin%5D=3');
    expect(seen[0]!.headers).toMatchObject({ 'x-key': 'k', 'x-tenant': 't1', accept: 'application/json' });

    const [missing] = load(d, { fetch: fetchStub, actAs: () => ({ 'x-key': 'k' }) });
    expect(await missing!.execute({ kind: 'a' }, ctx)).toEqual({
      success: false,
      error: 'search needs the header x-tenant, which actAs did not supply',
    });
  });
});

describe('async operations bind to declared events', () => {
  const job = (binding: unknown, effect: unknown = 'job'): OpenApiDocument =>
    doc('/exports', 'post', { operationId: 'exportReport', ...SECURED, 'x-agent': { expose: true, effect }, 'x-async-binding': binding });

  it('binds to a declared completion, its declared failure and correlation', () => {
    const [tool] = load(job({ event: 'report:ready', room: 'export:{exportId}' }), { events: deskEvents });
    expect(tool!.operation.async).toEqual({
      completion: 'report:ready',
      failure: 'report:failed',
      correlation: 'exportId',
      idField: 'exportId',
      timeoutMs: 60_000,
    });
    expect(load(job({ event: 'report:ready', timeout: '2m' }), { events: deskEvents })[0]!.operation.async?.timeoutMs).toBe(120_000);
    expect(
      load(job({ event: 'report:ready' }, { kind: 'job', timeoutMs: 90_000 }), { events: deskEvents })[0]!.operation.async?.timeoutMs,
    ).toBe(90_000);
  });

  it('reads the job id from the response field the binding names, when it is not the correlation field', async () => {
    const seen: string[] = [];
    const waiter = {
      waitForSettlement: async ({ id }: { id: string }) => {
        seen.push(id);
        return { kind: 'export', role: 'completion' as const, event: 'report:ready', id, payload: { exportId: id, url: 'u' } };
      },
    };
    const fetchStub: typeof fetch = async () =>
      new Response('{"exportJobId":"exp-9"}', { status: 202, headers: { 'content-type': 'application/json' } });
    const [tool] = load(job({ event: 'report:ready', idField: 'exportJobId' }), { events: deskEvents, waiter, fetch: fetchStub });
    expect(tool!.operation.async).toMatchObject({ correlation: 'exportId', idField: 'exportJobId' });
    expect(await tool!.execute({}, ctx)).toEqual({
      success: true,
      data: { exportJobId: 'exp-9', url: 'u', status: 'complete' },
    });
    expect(seen).toEqual(['exp-9']);
    expect(() => load(job({ event: 'report:ready', idField: 3 }), { events: deskEvents })).toThrow(/x-async-binding.idField is a field name/);
  });

  it('refuses an undeclared event, naming the operation and the event', () => {
    expect(() => load(job({ event: 'report:done' }), { events: deskEvents })).toThrow(/POST \/exports \(exportReport\).*report:done/);
  });

  it('refuses an event that is not a completion', () => {
    expect(() => load(job({ event: 'report:progress' }), { events: deskEvents })).toThrow(/exportReport.*report:progress/);
  });

  it('refuses an async operation when the host gives no declarations', () => {
    expect(() => load(job({ event: 'report:ready' }))).toThrow(
      "POST /exports (exportReport) waits on 'report:ready', but no event declarations were given (OpenApiToolsOptions.events)",
    );
  });

  it('refuses a binding on an operation that does not start a job, and a malformed binding', () => {
    expect(() => load(job({ event: 'report:ready' }, 'mutate'), { events: deskEvents })).toThrow(
      /exportReport\): x-async-binding waits on a job, but its effect is mutate; declare effect job/,
    );
    expect(() => load(job({ room: 'export:{exportId}' }), { events: deskEvents })).toThrow(/x-async-binding.event names the declared completion/);
    expect(() => load(job({ event: 'report:ready', timeout: 'soon' }), { events: deskEvents })).toThrow(/timeout 'soon' is not a duration like 60s or 2m/);
  });

  it('leaves an unexposed operation’s binding alone', () => {
    const d = doc('/exports', 'post', { operationId: 'exportReport', ...SECURED, 'x-async-binding': { event: 'nothing:declared' } });
    expect(load(d)).toEqual([]);
  });
});

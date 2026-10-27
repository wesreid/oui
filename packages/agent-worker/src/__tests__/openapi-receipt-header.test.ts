/**
 * The OpenAPI executor sends an approved call's receipt as the
 * `OUI-Approval-Receipt` header, and nothing else can put one there: a call
 * without a receipt on its context sends none, even when the product's actAs
 * names that header. A generated tool names its server's origin as its
 * receipt audience, and its operation id.
 */
import { describe, expect, it } from 'vitest';
import { loadOpenApiTools } from '../openapi/index.js';
import type { OpenApiDocument } from '../openapi/document.js';
import type { ToolExecutionContext } from '../tools/types.js';

const document: OpenApiDocument = {
  openapi: '3.1.0',
  info: { title: 'Dealer bookings', version: '1' },
  paths: {
    '/v1/bookings': {
      post: {
        operationId: 'bookings_create',
        summary: 'Book a test drive',
        security: [],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', properties: { slot: { type: 'string' } }, required: ['slot'] } } },
        },
        responses: { '201': { description: 'Booked' } },
        'x-agent': { expose: true, effect: 'transaction', consequence: 'Books the slot.' },
      },
    },
  },
};

function recorder() {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: { ...(init.headers as Record<string, string>) } });
    return new Response(JSON.stringify({ id: 'b-1' }), { status: 201, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const ctx: ToolExecutionContext = { userId: 'u1', accountId: 'a1', turnId: 't1', conversationId: 'c1' };

describe('a generated tool’s approved call', () => {
  it('names its server’s origin as its receipt audience, and its operation id', () => {
    const [tool] = loadOpenApiTools(document, { baseUrl: 'https://api.dealer.example:8443/base/', actAs: () => ({}), audience: 'agents' });
    expect(tool.approvalAudience).toBe('https://api.dealer.example:8443');
    expect(tool.operationId).toBe('bookings_create');
  });

  it('sends the receipt on its context as OUI-Approval-Receipt, and actAs cannot stand in for it', async () => {
    const { calls, fetchImpl } = recorder();
    const [tool] = loadOpenApiTools(document, {
      baseUrl: 'https://api.dealer.example',
      actAs: () => ({ authorization: 'Bearer user-assertion', 'oui-approval-receipt': 'forged-by-actAs' }),
      audience: 'agents',
      fetch: fetchImpl,
    });
    const approved = await tool.execute({ slot: 'wed 15:30' }, { ...ctx, approval: { approvalId: 'toolu_1', argsHash: 'a'.repeat(64), receipt: 'header.claims.signature' } });
    expect(approved.success).toBe(true);
    expect(calls[0].headers).toMatchObject({ authorization: 'Bearer user-assertion', 'OUI-Approval-Receipt': 'header.claims.signature' });
    expect(Object.keys(calls[0].headers).filter((h) => h.toLowerCase() === 'oui-approval-receipt')).toEqual(['OUI-Approval-Receipt']);
  });

  it('sends no receipt when the approval has none (a realtime server without receipt keys)', async () => {
    const { calls, fetchImpl } = recorder();
    const [tool] = loadOpenApiTools(document, {
      baseUrl: 'https://api.dealer.example',
      actAs: () => ({ 'OUI-Approval-Receipt': 'forged-by-actAs' }),
      audience: 'agents',
      fetch: fetchImpl,
    });
    expect((await tool.execute({ slot: 'wed 15:30' }, { ...ctx, approval: { approvalId: 'toolu_2', argsHash: 'b'.repeat(64) } })).success).toBe(true);
    expect(Object.keys(calls[0].headers).map((h) => h.toLowerCase())).not.toContain('oui-approval-receipt');
  });
});

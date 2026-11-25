/**
 * A tool the agent writes as a trailer (`RegisteredTool.trailer`, agent-worker)
 * is a trailer only to the agent's own model: an MCP client is served it as
 * the tool it is, listed and called like any other.
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { RegisteredTool } from '@ouispec/agent-worker';
import { createMCPApiToolServer } from '../server/api-tool-server.js';

describe('a trailer tool on MCP', () => {
  it('is listed and runs as the tool it is', async () => {
    const written: unknown[] = [];
    const note: RegisteredTool = {
      name: 'note',
      effect: 'edit',
      answerless: true,
      trailer: true,
      description: 'Write one line in the notes.',
      inputSchema: { type: 'object', sideEffects: false, properties: { text: { type: 'string' } }, required: ['text'] },
      async execute(input) {
        written.push(input);
        return { success: true, data: { id: 'n1', text: input.text } };
      },
    };
    const { server } = createMCPApiToolServer({ tools: [note], principal: () => ({ userId: 'u1', accountId: 'a1' }) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'trailer-client', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const { tools } = await client.listTools();
      expect(tools).toEqual([
        {
          name: 'note',
          description: 'Write one line in the notes.',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          annotations: { readOnlyHint: false, destructiveHint: false },
        },
      ]);
      const result = await client.callTool({ name: 'note', arguments: { text: 'Chorus brighter.' } });
      expect(result.isError).toBeFalsy();
      expect(written).toEqual([{ text: 'Chorus brighter.' }]);
    } finally {
      await client.close();
    }
  });
});

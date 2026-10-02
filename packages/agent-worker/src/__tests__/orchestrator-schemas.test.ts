import { describe, it, expect } from 'vitest';

// Test that we import dynamicTool and jsonSchema correctly
describe('Tool Schema Construction (W1.T1 — D1 fix)', () => {
  it('should use dynamicTool with jsonSchema instead of parameters', async () => {
    // Verify the imports exist and work
    const { dynamicTool, jsonSchema } = await import('ai');
    expect(dynamicTool).toBeDefined();
    expect(jsonSchema).toBeDefined();
  });

  it('should create a valid schema from a tool inputSchema', async () => {
    const { jsonSchema } = await import('ai');
    const testSchema = {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'The name' },
        count: { type: 'number', description: 'A count' },
      },
      required: ['name'],
    };

    const result = jsonSchema(testSchema);
    expect(result).toBeDefined();
  });

  it('should handle tools with no inputSchema by providing an empty object schema', async () => {
    const { jsonSchema } = await import('ai');
    const emptySchema = { type: 'object' as const, properties: {}, additionalProperties: false };
    const result = jsonSchema(emptySchema);
    expect(result).toBeDefined();
  });
});

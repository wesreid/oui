/**
 * Schema-loader sideEffects threading tests (D9)
 *
 * Validates that the `sideEffects` field from intent YAML is threaded into
 * the RegisteredTool's `inputSchema`, where the orchestrator reads it for
 * quota enforcement.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

describe('Schema-loader sideEffects threading (D9)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-loader-test-'));
    // Create the intents subdirectory expected by the loader
    fs.mkdirSync(path.join(tmpDir, 'intents'), { recursive: true });
  });

  it('threads sideEffects: false from intent YAML into inputSchema', async () => {
    const yaml = `
intent:
  id: get-production
  domain: media-production
  description: Get full details of a production.
  sideEffects: false
  parameters:
    productionId:
      type: string
      description: Production ID
      required: true
  execution:
    service: studio-api
    method: get_production
  outcome:
    async: false
`;
    fs.writeFileSync(path.join(tmpDir, 'intents', 'get-production.yaml'), yaml);

    const { loadToolsFromSchema } = await import('../tools/schema-loader.js');
    const tools = await loadToolsFromSchema(tmpDir);

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('get-production');
    expect((tools[0].inputSchema as Record<string, unknown>).sideEffects).toBe(false);
  });

  it('omits sideEffects from inputSchema when not set in YAML (fail-closed)', async () => {
    const yaml = `
intent:
  id: create-character
  domain: media-production
  description: Create a new character.
  parameters:
    name:
      type: string
      description: Character name
      required: true
  execution:
    service: studio-api
    method: create_character
  outcome:
    async: false
`;
    fs.writeFileSync(path.join(tmpDir, 'intents', 'create-character.yaml'), yaml);

    const { loadToolsFromSchema } = await import('../tools/schema-loader.js');
    const tools = await loadToolsFromSchema(tmpDir);

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('create-character');
    // sideEffects should be absent — the orchestrator's fail-closed check
    // `inputSchema.sideEffects !== false` will evaluate to true (side-effecting)
    expect((tools[0].inputSchema as Record<string, unknown>).sideEffects).toBeUndefined();
  });

  it('threads sideEffects: true explicitly without changing fail-closed behavior', async () => {
    const yaml = `
intent:
  id: delete-track
  domain: media-production
  description: Delete a track.
  sideEffects: true
  parameters:
    trackId:
      type: string
      description: Track ID
      required: true
  execution:
    service: studio-api
    method: delete_track
  outcome:
    async: false
`;
    fs.writeFileSync(path.join(tmpDir, 'intents', 'delete-track.yaml'), yaml);

    const { loadToolsFromSchema } = await import('../tools/schema-loader.js');
    const tools = await loadToolsFromSchema(tmpDir);

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('delete-track');
    // sideEffects: true should NOT be threaded — only false opts out
    // The orchestrator's check `!== false` handles both undefined and true identically
    expect((tools[0].inputSchema as Record<string, unknown>).sideEffects).toBeUndefined();
  });
});

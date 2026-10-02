/**
 * Intent tools accept exactly the parameters their YAML declares.
 *
 * The orchestrator validates each call against the tool's input schema. Without
 * `additionalProperties: false` an undeclared argument would pass that check and reach
 * the host's handler, which may forward it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createToolInputValidator } from '../tools/input-validation.js';

describe('schema-loader input strictness', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-loader-strict-'));
    fs.mkdirSync(path.join(tmpDir, 'intents'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'intents', 'generate-tts.yaml'),
      `
intent:
  id: generate-tts
  domain: media-production
  description: Speak a script with a voice.
  parameters:
    text:
      type: string
      description: The script to speak.
      required: true
    voice_id:
      type: string
      description: The voice.
  execution:
    service: studio-api
    method: generate_tts
  outcome:
    async: false
`,
    );
  });

  it('declares additionalProperties: false on the generated input schema', async () => {
    const { loadToolsFromSchema } = await import('../tools/schema-loader.js');
    const [tool] = await loadToolsFromSchema(tmpDir);

    expect(tool.inputSchema).toMatchObject({
      type: 'object',
      required: ['text'],
      additionalProperties: false,
    });
  });

  it('so validation rejects an argument the YAML does not declare', async () => {
    const { loadToolsFromSchema } = await import('../tools/schema-loader.js');
    const [tool] = await loadToolsFromSchema(tmpDir);
    const validate = createToolInputValidator(tool.inputSchema as Record<string, unknown>);

    expect(validate({ text: 'hello', voice_id: 'v1' }).ok).toBe(true);
    expect(validate({ text: 'hello', accountId: 'someone-elses-account' })).toEqual({
      ok: false,
      errors: ['(input) has a property this tool does not accept: "accountId"'],
    });
  });
});

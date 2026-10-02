/**
 * Generated entity CRUD tools accept only the properties they declare.
 *
 * The update tool passes every argument except `id` to the host's mutateEntity as the
 * set of fields to write, so an undeclared argument is an undeclared column write.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createToolInputValidator } from '../tools/input-validation.js';

describe('entity tool input strictness', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-tools-strict-'));
    fs.mkdirSync(path.join(tmpDir, 'entities'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'entities', 'character.yaml'),
      `
entity:
  id: Character
  domain: media-production
  description: A character.
  properties:
    id:
      type: string
    name:
      type: string
      required: true
    description:
      type: string
`,
    );
  });

  it('sets additionalProperties: false on every generated tool', async () => {
    const { loadEntityToolsFromSchema } = await import('../tools/entity-tools.js');
    const tools = await loadEntityToolsFromSchema(tmpDir);

    expect(tools.map((t) => t.name).sort()).toEqual(
      ['create-character', 'delete-character', 'get-character', 'list-characters', 'update-character'].sort(),
    );
    for (const tool of tools) {
      expect({ name: tool.name, additionalProperties: tool.inputSchema?.additionalProperties }).toEqual({
        name: tool.name,
        additionalProperties: false,
      });
    }
  });

  it('rejects a field the entity does not declare on update', async () => {
    const { loadEntityToolsFromSchema } = await import('../tools/entity-tools.js');
    const tools = await loadEntityToolsFromSchema(tmpDir);
    const update = tools.find((t) => t.name === 'update-character')!;
    const validate = createToolInputValidator(update.inputSchema as Record<string, unknown>);

    expect(validate({ id: 'c1', name: 'Ada' }).ok).toBe(true);
    expect(validate({ id: 'c1', accountId: 'someone-elses-account' })).toEqual({
      ok: false,
      errors: ['(input) has a property this tool does not accept: "accountId"'],
    });
  });
});

/**
 * A turn with files (ADR-0252 §2.11, §2.12), through the orchestrator with
 * the `ai` library replaced: the model call is what is checked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentRef } from '@ouispec/agent-core';
import type { AgentWorkerConfig, AgentTurnInput } from '../types.js';
import { createToolRegistry } from '../tools/types.js';
import type { AttachmentStore } from '../attachments/store.js';
import type { ToolPolicyContext } from '../authz/tool-policy.js';

type Part = { type: string; text?: string; data?: unknown; mediaType?: string };
type Msg = { role: string; content: string | Part[] };
type StreamOpts = {
  messages: Msg[];
  tools: Record<string, { execute: (args: unknown, o: { toolCallId: string }) => Promise<string> }>;
  prepareStep?: (o: { steps: unknown[]; messages: Msg[] }) => Promise<{ messages?: Msg[] }>;
};
let seen: StreamOpts | null;
let stepMessages: Msg[][];
let script: ((opts: StreamOpts) => Promise<void>) | null;

vi.mock('ai', () => ({
  streamText: (opts: StreamOpts) => {
    seen = opts;
    const run = (async () => {
      if (script) await script(opts);
      return [{ text: 'Done.', toolCalls: [] }];
    })();
    return {
      textStream: (async function* () {
        await run;
        yield 'Done.';
      })(),
      steps: run.then((s) => s.map((x) => ({ ...x, usage: { inputTokens: 10 } }))),
      usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
      response: run.then(() => ({ messages: [{ role: 'assistant', content: 'Done.' }] })),
    };
  },
  dynamicTool: (def: Record<string, unknown>) => def,
  jsonSchema: (schema: Record<string, unknown>) => schema,
  isStepCount: (n: number) => `isStepCount(${n})`,
  hasToolCall: (name: string) => `hasToolCall(${name})`,
}));

const png: AttachmentRef = { id: 'att_logo00001', name: 'logo.png', mediaType: 'image/png', kind: 'image', bytes: 400_000, width: 1200, height: 800 };
const notes: AttachmentRef = { id: 'att_notes0001', name: 'notes.md', mediaType: 'text/markdown', kind: 'text', bytes: 20 };
const old: AttachmentRef = { id: 'att_older0001', name: 'brief.pdf', mediaType: 'application/pdf', kind: 'pdf', bytes: 90_000, pages: 3 };
const imageBytes = new Uint8Array([9, 9, 9]);

function store(): AttachmentStore {
  return {
    describe: vi.fn(async (ids: readonly string[]) => [png, notes, old].filter((f) => ids.includes(f.id))),
    load: vi.fn(async (_id, _o, as) =>
      as === 'image' ? { ok: true as const, mediaType: 'image/png', bytes: imageBytes } : { ok: true as const, text: '# Brand notes', totalChars: 13 },
    ),
    list: vi.fn(async () => [old, png, notes]),
    conversationUsage: vi.fn(async () => 0),
  };
}

function config(overrides: Partial<AgentWorkerConfig> = {}): AgentWorkerConfig {
  return {
    tools: createToolRegistry([]),
    emit: { emit: vi.fn(async () => {}) },
    model: 'test-model',
    systemPrompt: 'test',
    attachments: { store: store() },
    ...overrides,
  };
}

function input(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return {
    turnId: 'turn-files',
    conversationId: 'conv-1',
    userId: 'user-1',
    accountId: 'acct-1',
    socketRoom: 'agent:turn:turn-files',
    content: 'Use the logo and follow the notes',
    history: [
      { role: 'user', content: 'Here is the brief', attachments: [old] },
      { role: 'assistant', content: 'Got it.' },
      { role: 'user', content: 'Use the logo and follow the notes', attachments: [png, notes] },
    ],
    attachments: [png, notes],
    ...overrides,
  };
}

const lastUser = (messages: Msg[]) => [...messages].reverse().find((m) => m.role === 'user')!;

beforeEach(() => {
  seen = null;
  stepMessages = [];
  script = null;
});

describe('a turn with files', () => {
  it('gives the message its picture and text with its reference lines, and earlier files as reference lines only', async () => {
    const { runAgentTurn } = await import('../orchestrator.js');
    const result = await runAgentTurn(config(), input({ context: { timeZone: 'Europe/Paris' } }));

    const first = seen!.messages[0];
    expect(first).toEqual({ role: 'user', content: 'Here is the brief\n\n[Attachment att_older0001: "brief.pdf", application/pdf, 88 KB, 3 pages]' });

    const turn = lastUser(seen!.messages);
    const parts = turn.content as Part[];
    // The message's text keeps the clock that follows it; the files come after, as parts.
    expect(parts[0].type).toBe('text');
    expect(parts[0].text).toContain('Use the logo and follow the notes\n\n[Attachment att_logo00001');
    expect(parts[0].text).toMatch(/Europe\/Paris/);
    expect(parts.find((p) => p.type === 'file')).toEqual({ type: 'file', mediaType: 'image/png', data: imageBytes });
    expect(parts.some((p) => p.type === 'text' && p.text?.includes('<attachment id="att_notes0001"') && p.text.includes('# Brand notes'))).toBe(true);

    expect(result.attachments).toMatchObject({ count: 2, images: 1, textChars: 13 });
  });

  it('offers the attachment tools, which a host policy sees by their class', async () => {
    const policy = vi.fn(async (_ctx: ToolPolicyContext) => ({ action: 'allow' as const }));
    let listed: unknown;
    script = async (opts) => {
      listed = JSON.parse(await opts.tools.attachment_list.execute({}, { toolCallId: 'call-list' }));
    };
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(config({ toolPolicy: { evaluate: policy } }), input());
    expect(Object.keys(seen!.tools)).toEqual(expect.arrayContaining(['attachment_list', 'attachment_view', 'attachment_read']));
    expect(policy).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'attachment_list', toolKind: 'backend', toolClass: 'attachment' }));
    expect(listed).toMatchObject({ count: 3 });
  });

  it('gives a later step the picture’s line instead of the picture once the turn’s allowance would be passed', async () => {
    script = async (opts) => {
      for (let i = 0; i < 3; i++) {
        const out = await opts.prepareStep!({ steps: [], messages: opts.messages });
        stepMessages.push(out.messages ?? opts.messages);
      }
    };
    const { runAgentTurn } = await import('../orchestrator.js');
    // The picture is about 1,280 tokens a step: two steps fit 3,000, a third does not.
    const result = await runAgentTurn(config({ attachments: { store: store(), turnTokens: 3_000 } }), input());
    const hasPicture = (messages: Msg[]) => (lastUser(messages).content as Part[]).some((p) => p.type === 'file');
    expect(stepMessages.map(hasPicture)).toEqual([true, true, false]);
    expect((lastUser(stepMessages[2]).content as Part[]).some((p) => p.text?.includes('is not repeated from here on'))).toBe(true);
    expect(result.attachments).toMatchObject({ leftOut: 1 });
  });

  it('gives no files without the host’s file area, and offers no attachment tools', async () => {
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(config({ attachments: undefined }), input());
    expect(Object.keys(seen!.tools)).not.toContain('attachment_view');
    expect(typeof lastUser(seen!.messages).content === 'string' || (lastUser(seen!.messages).content as Part[]).every((p) => p.type === 'text')).toBe(true);
  });
});

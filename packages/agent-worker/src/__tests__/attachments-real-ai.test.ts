/**
 * A turn with files through the real `ai` loop (ADR-0252 §2.11, §2.12, §2.15).
 * Only the model is a stand-in: `streamText` runs its own steps, calls
 * `prepareStep` itself, runs the tools and builds each step's prompt, so what
 * is checked is the prompt the provider would have been sent.
 *
 * - The cost guard leaves the costliest file out of the step that would pass
 *   the cap, and the model reads its line there, once.
 * - A picture and a file's text reach the model with the call that fetched
 *   them, and nothing else: not an event, not the turn's stored messages.
 * - A turn policy sees each tool's class.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { AttachmentRef } from '@ouispec/agent-core';
import type { AgentTurnInput, AgentWorkerConfig } from '../types.js';
import { createToolRegistry } from '../tools/types.js';
import type { AttachmentStore } from '../attachments/store.js';
import type { StepTool, TurnPolicy } from '../turn-policy.js';

type PromptPart = { type: string; text?: string; data?: unknown; mediaType?: string; output?: { type: string; value: unknown } };
type PromptMessage = { role: string; content: string | PromptPart[] };

const png: AttachmentRef = { id: 'att_logo00001', name: 'logo.png', mediaType: 'image/png', kind: 'image', bytes: 400_000, width: 1200, height: 800 };
const notes: AttachmentRef = { id: 'att_notes0001', name: 'notes.md', mediaType: 'text/markdown', kind: 'text', bytes: 60 };
/** Bytes no prompt would hold by chance, and their base64. */
const pictureBytes = new Uint8Array(Array.from({ length: 48 }, (_, i) => (i * 37 + 11) % 256));
const pictureBase64 = Buffer.from(pictureBytes).toString('base64');
const SECRET_TEXT = 'Brand colour is PANTONE-7621-C; the codename is BLUEHERON.';

function store(): AttachmentStore {
  return {
    describe: vi.fn(async (ids: readonly string[]) => [png, notes].filter((f) => ids.includes(f.id))),
    load: vi.fn(async (_id, _owner, as, options) =>
      as === 'image'
        ? { ok: true as const, mediaType: 'image/png', bytes: pictureBytes }
        : {
            ok: true as const,
            text: SECRET_TEXT.slice(options?.range?.offset ?? 0, (options?.range?.offset ?? 0) + (options?.range?.limit ?? SECRET_TEXT.length)),
            totalChars: SECRET_TEXT.length,
          },
    ),
    list: vi.fn(async () => [png, notes]),
  };
}

const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };

/** A model that makes these calls, one step each, then answers. Each step's prompt is kept. */
function scripted(calls: Array<{ tool: string; input: Record<string, unknown> }>) {
  const prompts: PromptMessage[][] = [];
  const model = new MockLanguageModelV4({
    doStream: async (options: { prompt: unknown }) => {
      prompts.push(structuredClone(options.prompt) as PromptMessage[]);
      const call = calls[prompts.length - 1];
      const chunks = call
        ? [
            { type: 'stream-start', warnings: [] },
            { type: 'tool-call', toolCallId: `call-${prompts.length}`, toolName: call.tool, input: JSON.stringify(call.input) },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage },
          ]
        : [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: '0' },
            { type: 'text-delta', id: '0', delta: 'Done.' },
            { type: 'text-end', id: '0' },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'end_turn' }, usage },
          ];
      return { stream: simulateReadableStream({ chunks: chunks as never[] }) };
    },
  } as never);
  return { model, prompts };
}

function config(model: unknown, overrides: Partial<AgentWorkerConfig> = {}): AgentWorkerConfig {
  return {
    tools: createToolRegistry([]),
    emit: { emit: vi.fn(async () => {}) },
    model: model as AgentWorkerConfig['model'],
    systemPrompt: 'You are the assistant.',
    attachments: { store: store() },
    ...overrides,
  };
}

function input(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return {
    turnId: 'turn-files-real',
    conversationId: 'conv-1',
    userId: 'user-1',
    accountId: 'acct-1',
    socketRoom: 'agent:turn:turn-files-real',
    content: 'Use the logo',
    history: [{ role: 'user', content: 'Use the logo', attachments: [png] }],
    attachments: [png],
    ...overrides,
  };
}

/** The person's newest message: the last user message that is not the step's own tail (step-messages.ts). */
const lastUser = (prompt: PromptMessage[]) =>
  [...prompt].reverse().find((m) => m.role === 'user' && !JSON.stringify((m as { providerOptions?: unknown }).providerOptions ?? {}).includes('"stepTail":true'))!;
const userParts = (prompt: PromptMessage[]) => lastUser(prompt).content as PromptPart[];
const hasPicture = (prompt: PromptMessage[]) => userParts(prompt).some((p) => p.type === 'file');

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('the cost guard, in the real loop', () => {
  it('leaves the picture out of the step that would pass the turn’s cap, and the model reads its line there once', async () => {
    // The picture is about 1,280 tokens a step: two steps fit 3,000, a third does not.
    const { model, prompts } = scripted([
      { tool: 'attachment_list', input: {} },
      { tool: 'attachment_list', input: {} },
    ]);
    const { runAgentTurn } = await import('../orchestrator.js');
    const result = await runAgentTurn(config(model, { attachments: { store: store(), turnTokens: 3_000 } }), input());

    expect(prompts).toHaveLength(3);
    expect(prompts.map(hasPicture)).toEqual([true, true, false]);
    const third = userParts(prompts[2]).map((p) => p.text ?? '').join('\n');
    // Its line replaces both the picture and the line that introduced it: no "The picture follows." left behind.
    expect(third.match(/\[Attachment att_logo00001/g)).toHaveLength(1);
    expect(third).toContain('Its picture is not repeated from here on');
    expect(third).not.toContain('The picture follows.');
    expect(result.attachments).toMatchObject({ leftOut: 1, images: 0, estimatedTokens: 2 * 1_280 });
  });
});

describe('what a file gives the model, and nothing else', () => {
  it('gives the read text and the viewed picture with their calls, and keeps both out of every event and the stored messages', async () => {
    const { model, prompts } = scripted([
      { tool: 'attachment_view', input: { id: 'att_logo00001' } },
      { tool: 'attachment_read', input: { id: 'att_notes0001' } },
    ]);
    const emit = vi.fn(async () => {});
    const { runAgentTurn } = await import('../orchestrator.js');
    const result = await runAgentTurn(config(model, { emit: { emit } }), input());

    // The model had both, each in the result of the call that fetched it.
    const toolResults = (prompt: PromptMessage[]) =>
      prompt.filter((m) => m.role === 'tool').flatMap((m) => m.content as PromptPart[]);
    const last = JSON.stringify(toolResults(prompts[2]));
    expect(last).toContain(pictureBase64);
    expect(last).toContain(SECRET_TEXT);
    expect(last).toContain('\\"chars\\":58');

    // Nothing else did: every event, and the messages the host stores.
    const events = JSON.stringify(emit.mock.calls);
    const stored = JSON.stringify(result.newMessages);
    for (const leaked of [pictureBase64, SECRET_TEXT, 'BLUEHERON']) {
      expect(events).not.toContain(leaked);
      expect(stored).not.toContain(leaked);
    }
    // What is stored says what was read.
    const readResult = result.newMessages.find((m) => m.role === 'tool' && m.name === 'attachment_read')!;
    expect(JSON.parse(readResult.content!)).toEqual({
      attachment: '[Attachment att_notes0001: "notes.md", text/markdown, 60 B]',
      offset: 0,
      chars: SECRET_TEXT.length,
      totalChars: SECRET_TEXT.length,
      end: true,
    });
    // And the turn's own picture, given with its message, is in neither.
    expect(result.newMessages.some((m) => m.role === 'tool' && m.name === 'attachment_view')).toBe(true);
  });
});

describe('a turn policy', () => {
  it('is told each tool’s class, so it can keep the attachment tools when it picks a step’s tools', async () => {
    const { model } = scripted([]);
    const seen: StepTool[][] = [];
    const policy: TurnPolicy = {
      classifyTurn: () => 'normal',
      prepareStep: async ({ allTools }) => {
        seen.push(allTools);
        return { activeTools: allTools.filter((t) => t.toolClass === 'attachment').map((t) => t.name) };
      },
    };
    const host = { name: 'brand_get', description: 'Reads the brand', inputSchema: { type: 'object' as const, properties: {} }, execute: async () => ({ success: true }) };
    const { runAgentTurn } = await import('../orchestrator.js');
    await runAgentTurn(config(model, { turnPolicy: policy, tools: createToolRegistry([host]) }), input());
    expect(seen[0]).toEqual(
      expect.arrayContaining([
        { name: 'attachment_list', kind: 'backend', toolClass: 'attachment' },
        { name: 'attachment_view', kind: 'backend', toolClass: 'attachment' },
        { name: 'attachment_read', kind: 'backend', toolClass: 'attachment' },
        { name: 'brand_get', kind: 'backend' },
      ]),
    );
  });
});

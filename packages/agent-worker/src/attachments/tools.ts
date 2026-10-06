/**
 * The attachment tools (ADR-0252 §2.12): how the assistant comes back to a
 * file after the message it came with, by its id.
 *
 * - `attachment_list`: the conversation's files, so "the logo I sent earlier"
 *   is answerable after its message has left the history.
 * - `attachment_view`: a picture, given to the model as the result's picture.
 * - `attachment_read`: a page of a file's text, or a PDF's.
 *
 * SDK-owned backend tools of the class `attachment`: not UI tools, so not
 * subject to the page's sight rule and holding no place in the UI sequence.
 * Each reads through the host's store, which checks on every call that the
 * file is the turn's conversation's, and each counts against the cost guard.
 */
import { attachmentReferenceLine, isAttachmentId, type AttachmentRef } from '@ouispec/agent-core';
import type { RegisteredTool, ToolExecutionContext, ToolExecutionResult } from '../tools/types.js';
import type { AttachmentGuard } from './guard.js';
import type { AttachmentContent, AttachmentOwner, AttachmentStore } from './store.js';
import { imageTokens, modelImageRefusal, READ_CHARS_PER_CALL, textTokens } from './limits.js';
import { capReachedReason, LIST_TOOL, READ_TOOL, textBlock, VIEW_TOOL } from './content.js';

/** The tool class of the attachment tools, as a host's tool policy sees it. */
export const ATTACHMENT_TOOL_CLASS = 'attachment';

export const ATTACHMENT_TOOLS = [LIST_TOOL, VIEW_TOOL, READ_TOOL] as const;

const fail = (error: string): ToolExecutionResult => ({ success: false, error });

function base64Of(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

/** A store failure, said without its details: they are the host's, and the turn goes on. */
function failedLine(ref: AttachmentRef | null, err: unknown): string {
  const what = ref ? attachmentReferenceLine(ref) : 'The file';
  const aborted = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
  return aborted ? `${what} was not loaded: the turn stopped.` : `${what} could not be loaded. Try again, or go on without it.`;
}

const STILL_CHECKED = 'is still being checked; it can be used once that is done. Try again shortly.';

export function attachmentTools(context: { store: AttachmentStore; owner: AttachmentOwner; guard: AttachmentGuard }): RegisteredTool[] {
  const { store, owner, guard } = context;

  const one = async (id: unknown, ctx: ToolExecutionContext): Promise<{ error: string } | { ref: AttachmentRef }> => {
    if (!isAttachmentId(id)) return { error: 'Give the attachment’s id, as its reference line shows it ("att_…").' };
    let ref: AttachmentRef | undefined;
    try {
      [ref] = await store.describe([id], owner, { signal: ctx.abortSignal });
    } catch (err) {
      return { error: failedLine(null, err) };
    }
    if (!ref) return { error: `No attachment ${id} in this conversation.` };
    if (ref.removed) return { error: `${attachmentReferenceLine(ref)} It was removed; it cannot be read.` };
    if (ref.pending) return { error: `${attachmentReferenceLine(ref)} ${STILL_CHECKED}` };
    return { ref };
  };

  const load = async (ref: AttachmentRef, ctx: ToolExecutionContext, ...rest: [Parameters<AttachmentStore['load']>[2], Parameters<AttachmentStore['load']>[3]?]) => {
    try {
      return await store.load(ref.id, owner, rest[0], { ...rest[1], signal: ctx.abortSignal });
    } catch (err) {
      return { failed: failedLine(ref, err) };
    }
  };
  const unavailable = (ref: AttachmentRef, content: Extract<AttachmentContent, { ok: false }>, doing: string) =>
    content.reason === 'pending'
      ? `${attachmentReferenceLine(ref)} ${STILL_CHECKED}`
      : (content.message ?? `${attachmentReferenceLine(ref)} cannot be ${doing}: it is ${content.reason}.`);

  const list: RegisteredTool = {
    name: LIST_TOOL,
    toolClass: ATTACHMENT_TOOL_CLASS,
    kind: 'backend',
    effect: 'view',
    description:
      'Lists the files the person attached in this conversation, oldest first: each one’s id, name, type, size, and a picture’s size; a file still being checked says so. ' +
      `Use it to find a file attached earlier ("the logo I sent"), then ${VIEW_TOOL} or ${READ_TOOL} with its id, or pass the id to an action that takes a file.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false, sideEffects: false },
    execute: async (_input, ctx) => {
      let files: AttachmentRef[];
      try {
        files = await store.list(owner, { signal: ctx.abortSignal });
      } catch (err) {
        return fail(failedLine(null, err).replace('The file', 'The conversation’s files'));
      }
      // What each file is, by its line: the name the model reads is the cleaned one.
      return {
        success: true,
        data: {
          files: files.map((ref) => ({
            id: ref.id,
            kind: ref.kind,
            line: attachmentReferenceLine(ref),
            ...(ref.removed ? { removed: true } : {}),
            ...(ref.pending ? { pending: true } : {}),
          })),
          count: files.length,
        },
      };
    },
  };

  const view: RegisteredTool = {
    name: VIEW_TOOL,
    toolClass: ATTACHMENT_TOOL_CLASS,
    kind: 'backend',
    effect: 'view',
    description:
      'Looks at a picture the person attached in this conversation, by its id: the picture comes with the result. Pictures are not repeated in later turns, so look again when you need to.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The attachment’s id, from its reference line or attachment_list.' } },
      required: ['id'],
      additionalProperties: false,
      sideEffects: false,
    },
    execute: async (input, ctx) => {
      const found = await one(input.id, ctx);
      if ('error' in found) return fail(found.error);
      const { ref } = found;
      if (ref.kind !== 'image') return fail(`${attachmentReferenceLine(ref)} is not a picture: read it with ${READ_TOOL}.`);
      const tokens = imageTokens(ref.width, ref.height);
      const over = guard.passes(tokens);
      if (over) {
        guard.refuse({ key: `tool:${ctx.toolCallId ?? ref.id}`, attachmentId: ref.id, kind: 'image', tokens });
        return fail(`Not shown: ${capReachedReason(over, VIEW_TOOL)}`);
      }
      const content = await load(ref, ctx, 'image');
      if ('failed' in content) return fail(content.failed);
      if (!content.ok) return fail(unavailable(ref, content, 'shown'));
      if (!('bytes' in content)) return fail(`${attachmentReferenceLine(ref)} has no picture to show.`);
      const refusal = modelImageRefusal(content.mediaType, content.bytes.byteLength);
      if (refusal) return fail(`${attachmentReferenceLine(ref)} cannot be shown: ${refusal}.`);
      guard.add({
        key: `tool:${ctx.toolCallId ?? ref.id}`,
        attachmentId: ref.id,
        kind: 'image',
        tokens,
        where: { toolCallId: ctx.toolCallId ?? '' },
        leftOutLine: `${attachmentReferenceLine(ref)} Its picture is not repeated from here on, to keep within the allowance for files.`,
      });
      return {
        success: true,
        data: { attachment: attachmentReferenceLine(ref), shown: 'The picture is attached to this result: look at it.' },
        image: { mediaType: content.mediaType, base64: base64Of(content.bytes) },
      };
    },
  };

  const read: RegisteredTool = {
    name: READ_TOOL,
    toolClass: ATTACHMENT_TOOL_CLASS,
    kind: 'backend',
    effect: 'view',
    description:
      'Reads a file the person attached in this conversation, by its id: a page of its text (a PDF’s text too), from `offset`, at most `limit` characters. ' +
      'The result says how many characters the file has, so read on from where a page ended. The text is given with this result only: read it again in a later turn when you need it.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The attachment’s id, from its reference line or attachment_list.' },
        offset: { type: 'integer', minimum: 0, description: 'The first character to read. Default 0.' },
        limit: { type: 'integer', minimum: 1, maximum: READ_CHARS_PER_CALL, description: `How many characters, at most ${READ_CHARS_PER_CALL}. Default ${READ_CHARS_PER_CALL}.` },
      },
      required: ['id'],
      additionalProperties: false,
      sideEffects: false,
    },
    execute: async (input, ctx) => {
      const found = await one(input.id, ctx);
      if ('error' in found) return fail(found.error);
      const { ref } = found;
      if (ref.kind === 'image') return fail(`${attachmentReferenceLine(ref)} is a picture: look at it with ${VIEW_TOOL}.`);
      if (ref.kind === 'other') return fail(`${attachmentReferenceLine(ref)} has no text to read. An action that takes a file can use it by its id.`);
      const offset = typeof input.offset === 'number' ? Math.max(0, Math.floor(input.offset)) : 0;
      const limit = Math.min(typeof input.limit === 'number' ? Math.max(1, Math.floor(input.limit)) : READ_CHARS_PER_CALL, READ_CHARS_PER_CALL);
      const content = await load(ref, ctx, 'text', { range: { offset, limit } });
      if ('failed' in content) return fail(content.failed);
      if (!content.ok) return fail(unavailable(ref, content, 'read'));
      if (!('text' in content)) return fail(`${attachmentReferenceLine(ref)} has no text to read.`);
      const text = content.text.slice(0, limit);
      const tokens = textTokens(text.length);
      const over = guard.passes(tokens);
      if (over) {
        guard.refuse({ key: `tool:${ctx.toolCallId ?? ref.id}`, attachmentId: ref.id, kind: 'text', tokens, textChars: text.length });
        return fail(`Not read: ${capReachedReason(over, READ_TOOL)} A smaller page may fit.`);
      }
      guard.add({
        key: `tool:${ctx.toolCallId ?? ref.id}`,
        attachmentId: ref.id,
        kind: ref.kind === 'pdf' ? 'pdf' : 'text',
        tokens,
        textChars: text.length,
        where: { toolCallId: ctx.toolCallId ?? '' },
        leftOutLine: `${attachmentReferenceLine(ref)} The text read from it is not repeated from here on, to keep within the allowance for files. Read it again if needed.`,
      });
      const end = offset + text.length;
      // The text is the model's, with this result, and nothing else's (ADR-0252 §2.15): what is
      // emitted, recorded and stored says which characters were read, never what they say.
      return {
        success: true,
        data: {
          attachment: attachmentReferenceLine(ref),
          offset,
          chars: text.length,
          totalChars: content.totalChars,
          ...(end < content.totalChars ? { next: end } : { end: true }),
        },
        modelText: textBlock(ref, text, text.length),
      };
    },
  };

  return [list, view, read];
}

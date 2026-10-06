/**
 * The files of the turn's message, as the model is given them (ADR-0252 §2.11),
 * and history's reference to every earlier one.
 *
 * - An image: the platform's model rendition, as a file part (ADR-0244's path).
 * - Text, and a PDF's text: up to 20,000 characters a file and 40,000 a turn,
 *   with a note of how much was left out.
 * - A short PDF as a document part, when the host turns that on.
 * - Anything else: its reference line.
 *
 * Bytes and text are fetched for the model call and kept nowhere: not in an
 * event, the turn's record or a stored message. Later turns read the
 * reference line and look again with the attachment tools.
 */
import type { FilePart, ModelMessage, TextPart } from 'ai';
import { attachmentReferenceLine, type AttachmentRef } from '@ouispec/agent-core';
import type { AttachmentGuard, GuardedPart } from './guard.js';
import type { AttachmentOwner, AttachmentStore } from './store.js';
import {
  PDF_DOCUMENT_MAX_BYTES,
  PDF_DOCUMENT_MAX_PAGES,
  PROVIDER_MAX_DOCUMENTS,
  PROVIDER_MAX_IMAGES,
  TEXT_CHARS_PER_FILE,
  TEXT_CHARS_PER_TURN,
  imageTokens,
  pdfDocumentTokens,
  textTokens,
} from './limits.js';

export const VIEW_TOOL = 'attachment_view';
export const READ_TOOL = 'attachment_read';
export const LIST_TOOL = 'attachment_list';

type Part = TextPart | FilePart;

/** The model's part for a file's text: what it is, then the text, closed so it cannot run into what follows. */
function textBlock(ref: AttachmentRef, text: string, totalChars: number): string {
  const rest = totalChars - text.length;
  return [
    `<attachment id="${ref.id}" name=${JSON.stringify(ref.name)} type="${ref.mediaType}">`,
    text,
    '</attachment>',
    ...(rest > 0 ? [`[${rest} more characters of "${ref.name}" were not given: read them with ${READ_TOOL}.]`] : []),
  ].join('\n');
}

export interface TurnAttachments {
  /** Parts to add to the turn's user message, after its text. */
  parts: Part[];
  /** Lines to add to its text: files given as their reference only, and why. */
  notes: string[];
}

/** The turn's files, loaded through the host's store and capped by the guard. */
export async function turnAttachmentParts(
  refs: readonly AttachmentRef[],
  context: { store: AttachmentStore; owner: AttachmentOwner; guard: AttachmentGuard; pdfAsDocument: boolean },
): Promise<TurnAttachments> {
  const { store, owner, guard } = context;
  const parts: Part[] = [];
  const notes: string[] = [];
  if (refs.length === 0) return { parts, notes };

  // The host's view now: a file can have been removed since the message was sent, and
  // a reference that is not this conversation's is never resolved.
  const described = new Map((await store.describe(refs.map((r) => r.id), owner)).map((r) => [r.id, r]));
  let textLeft = TEXT_CHARS_PER_TURN;
  let images = 0;
  let documents = 0;

  const notGiven = (ref: AttachmentRef, why: string) => notes.push(`${attachmentReferenceLine(ref)} Not given with this message: ${why}`);

  for (const asked of refs) {
    const ref = described.get(asked.id);
    if (!ref) {
      notes.push(`[Attachment ${asked.id}: not available in this conversation]`);
      continue;
    }
    if (ref.removed) {
      notes.push(attachmentReferenceLine(ref));
      continue;
    }
    const key = `message:${ref.id}`;

    if (ref.kind === 'image') {
      const tokens = imageTokens(ref.width, ref.height);
      if (images >= PROVIDER_MAX_IMAGES) {
        notGiven(ref, `a message gives at most ${PROVIDER_MAX_IMAGES} pictures; look at it with ${VIEW_TOOL}.`);
        continue;
      }
      if (!guard.admits(tokens)) {
        guard.refuse({ key, attachmentId: ref.id, kind: 'image', tokens });
        notGiven(ref, `the turn's allowance for files is used up; look at it with ${VIEW_TOOL} in a later turn.`);
        continue;
      }
      const content = await store.load(ref.id, owner, 'image');
      if (!content.ok || !('bytes' in content)) {
        notGiven(ref, content.ok ? 'no picture of it can be given.' : (content.message ?? `it is ${content.reason}.`));
        continue;
      }
      const part: FilePart = { type: 'file', mediaType: content.mediaType, data: content.bytes };
      parts.push({ type: 'text', text: `${attachmentReferenceLine(ref)} The picture follows.` }, part);
      guard.add({
        key,
        attachmentId: ref.id,
        kind: 'image',
        tokens,
        where: { message: true },
        part,
        leftOutLine: `[The picture of "${ref.name}" (${ref.id}) is not repeated from here on, to keep within the turn's allowance for files. Look again with ${VIEW_TOOL} if needed.]`,
      });
      images++;
      continue;
    }

    const asDocument =
      ref.kind === 'pdf' &&
      context.pdfAsDocument &&
      documents < PROVIDER_MAX_DOCUMENTS &&
      (ref.pages ?? Infinity) <= PDF_DOCUMENT_MAX_PAGES &&
      ref.bytes <= PDF_DOCUMENT_MAX_BYTES;
    if (asDocument) {
      const tokens = pdfDocumentTokens(ref.pages);
      if (guard.admits(tokens)) {
        const content = await store.load(ref.id, owner, 'document');
        if (content.ok && 'bytes' in content) {
          const part: FilePart = { type: 'file', mediaType: 'application/pdf', data: content.bytes, filename: `document ${documents + 1}` };
          parts.push({ type: 'text', text: `${attachmentReferenceLine(ref)} The document follows.` }, part);
          guard.add({
            key,
            attachmentId: ref.id,
            kind: 'pdf',
            tokens,
            pdfPages: ref.pages,
            where: { message: true },
            part,
            leftOutLine: `[The document "${ref.name}" (${ref.id}) is not repeated from here on, to keep within the turn's allowance for files. Read it with ${READ_TOOL} if needed.]`,
          });
          documents++;
          continue;
        }
      }
      // Too costly, or unavailable as a document: its text, under the text rule.
    }

    if (ref.kind === 'text' || ref.kind === 'pdf') {
      const limit = Math.min(TEXT_CHARS_PER_FILE, textLeft);
      if (limit <= 0) {
        notGiven(ref, `the message's text from files is full; read it with ${READ_TOOL}.`);
        continue;
      }
      const content = await store.load(ref.id, owner, 'text', { offset: 0, limit });
      if (!content.ok || !('text' in content)) {
        notGiven(ref, content.ok ? 'it has no text.' : (content.message ?? `it is ${content.reason}.`));
        continue;
      }
      const text = content.text.slice(0, limit);
      const tokens = textTokens(text.length);
      if (!guard.admits(tokens)) {
        guard.refuse({ key, attachmentId: ref.id, kind: 'text', tokens, textChars: text.length });
        notGiven(ref, `the turn's allowance for files is used up; read it with ${READ_TOOL} in a later turn.`);
        continue;
      }
      const part: TextPart = { type: 'text', text: textBlock(ref, text, content.totalChars) };
      parts.push(part);
      guard.add({
        key,
        attachmentId: ref.id,
        kind: 'text',
        tokens,
        textChars: text.length,
        where: { message: true },
        part,
        leftOutLine: `[The text of "${ref.name}" (${ref.id}) is not repeated from here on, to keep within the turn's allowance for files. Read it with ${READ_TOOL} if needed.]`,
      });
      textLeft -= text.length;
      continue;
    }

    // Any other file: what it is. Actions that take a file use it by its id.
    notes.push(attachmentReferenceLine(ref));
  }
  return { parts, notes };
}

/** The turn's user message (the last one) with its files: notes after its text, then the parts. */
export function withTurnAttachments(messages: ModelMessage[], files: TurnAttachments): ModelMessage[] {
  if (files.parts.length === 0 && files.notes.length === 0) return messages;
  const index = lastUserIndex(messages);
  if (index < 0) return messages;
  const message = messages[index] as Extract<ModelMessage, { role: 'user' }>;
  const content: Part[] = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : [...(message.content as Part[])];
  if (files.notes.length > 0) content.push({ type: 'text', text: files.notes.join('\n') });
  content.push(...files.parts);
  return [...messages.slice(0, index), { ...message, content }, ...messages.slice(index + 1)];
}

function lastUserIndex(messages: readonly ModelMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return i;
  return -1;
}

type ToolMessage = Extract<ModelMessage, { role: 'tool' }>;

/**
 * The messages of the next step with the parts the guard has left out
 * replaced by their lines: on the user message, the part itself; in a tool
 * call's result, the result's picture or text.
 */
export function withoutLeftOut(messages: ModelMessage[], leftOut: readonly GuardedPart[]): ModelMessage[] {
  if (leftOut.length === 0) return messages;
  const inMessage = leftOut.filter((p) => 'message' in p.where);
  const inTools = new Map(leftOut.flatMap((p) => ('toolCallId' in p.where ? [[p.where.toolCallId, p] as const] : [])));
  const same = (part: Part, guarded: GuardedPart): boolean => {
    const original = guarded.part as Part | undefined;
    if (!original) return false;
    if (part === original) return true;
    if (part.type === 'file' && original.type === 'file') return part.data === original.data;
    if (part.type === 'text' && original.type === 'text') return part.text === original.text;
    return false;
  };
  return messages.map((message) => {
    if (message.role === 'user' && Array.isArray(message.content) && inMessage.length > 0) {
      let changed = false;
      const content = (message.content as Part[]).map((part) => {
        const guarded = inMessage.find((g) => same(part, g));
        if (!guarded) return part;
        changed = true;
        return { type: 'text' as const, text: guarded.leftOutLine };
      });
      return changed ? { ...message, content } : message;
    }
    if (message.role === 'tool' && inTools.size > 0) {
      let changed = false;
      const content = (message as ToolMessage).content.map((part) => {
        if (part.type !== 'tool-result') return part;
        const guarded = inTools.get(part.toolCallId);
        if (!guarded) return part;
        changed = true;
        return { ...part, output: { type: 'text' as const, value: JSON.stringify({ leftOut: guarded.leftOutLine }) } };
      });
      return changed ? ({ ...message, content } as ToolMessage) : message;
    }
    return message;
  });
}

/** A user message of history with its files' reference lines after its text. */
export function withReferenceLines(text: string, refs: readonly AttachmentRef[] | undefined): string {
  if (!refs?.length) return text;
  const lines = refs.map(attachmentReferenceLine).join('\n');
  return text ? `${text}\n\n${lines}` : lines;
}

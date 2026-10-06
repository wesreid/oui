/**
 * The turn's files as the model is given them (ADR-0252 §2.11): through the
 * host's store, for the turn's own conversation, capped by the guard, and as
 * reference lines everywhere else.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ModelMessage } from 'ai';
import type { AttachmentRef } from '@ouispec/agent-core';
import { AttachmentGuard } from '../attachments/guard.js';
import { turnAttachmentParts, withReferenceLines, withTurnAttachments, withoutLeftOut } from '../attachments/content.js';
import type { AttachmentContent, AttachmentStore } from '../attachments/store.js';

const owner = { userId: 'u1', accountId: 'a1', conversationId: 'c1' };
const png: AttachmentRef = { id: 'att_logo00001', name: 'logo.png', mediaType: 'image/png', kind: 'image', bytes: 400_000, width: 1200, height: 800 };
const notes: AttachmentRef = { id: 'att_notes0001', name: 'notes.md', mediaType: 'text/markdown', kind: 'text', bytes: 30_000 };
const deck: AttachmentRef = { id: 'att_deck00001', name: 'deck.pdf', mediaType: 'application/pdf', kind: 'pdf', bytes: 2_000_000, pages: 12 };
const zip: AttachmentRef = { id: 'att_zip000001', name: 'fonts.zip', mediaType: 'application/zip', kind: 'other', bytes: 9_000_000 };
const bytes = new Uint8Array([137, 80, 78, 71]);

function store(files: AttachmentRef[], text = 'x'.repeat(30_000)) {
  const load = vi.fn(async (id: string, _o: unknown, as: string, range?: { offset: number; limit: number }): Promise<AttachmentContent> => {
    if (as === 'image' || as === 'document') return { ok: true, mediaType: as === 'image' ? 'image/png' : 'application/pdf', bytes };
    const slice = text.slice(range?.offset ?? 0, (range?.offset ?? 0) + (range?.limit ?? text.length));
    return { ok: true, text: slice, totalChars: text.length };
  });
  const s: AttachmentStore = {
    describe: vi.fn(async (ids: readonly string[], who) => (who.conversationId === 'c1' ? files.filter((f) => ids.includes(f.id)) : [])),
    load,
    list: vi.fn(async () => files),
  };
  return { s, load };
}

describe('the turn’s files', () => {
  it('gives a picture as the platform’s rendition, a file part after a line that says what it is', async () => {
    const { s, load } = store([png]);
    const out = await turnAttachmentParts([png], { store: s, owner, guard: new AttachmentGuard(), pdfAsDocument: false });
    expect(load).toHaveBeenCalledWith('att_logo00001', owner, 'image');
    expect(out.parts).toEqual([
      { type: 'text', text: '[Attachment att_logo00001: "logo.png", image/png, 391 KB, 1200×800 px] The picture follows.' },
      { type: 'file', mediaType: 'image/png', data: bytes },
    ]);
  });

  it('gives a text file’s text up to 20,000 characters, closed, and says how much more there is', async () => {
    const { s, load } = store([notes]);
    const out = await turnAttachmentParts([notes], { store: s, owner, guard: new AttachmentGuard(), pdfAsDocument: false });
    expect(load).toHaveBeenCalledWith('att_notes0001', owner, 'text', { offset: 0, limit: 20_000 });
    const text = (out.parts[0] as { text: string }).text;
    expect(text.startsWith('<attachment id="att_notes0001" name="notes.md" type="text/markdown">\n')).toBe(true);
    expect(text).toContain('</attachment>\n[10000 more characters of "notes.md" were not given: read them with attachment_read.]');
  });

  it('gives a PDF as its text unless the host turns document parts on; then a short one as a document', async () => {
    const { s, load } = store([deck]);
    await turnAttachmentParts([deck], { store: s, owner, guard: new AttachmentGuard(), pdfAsDocument: false });
    expect(load).toHaveBeenLastCalledWith('att_deck00001', owner, 'text', { offset: 0, limit: 20_000 });
    const asDoc = await turnAttachmentParts([deck], { store: s, owner, guard: new AttachmentGuard(), pdfAsDocument: true });
    expect(asDoc.parts[1]).toMatchObject({ type: 'file', mediaType: 'application/pdf' });
  });

  it('keeps all text files of a turn to 40,000 characters', async () => {
    const a = { ...notes, id: 'att_notesA001' };
    const b = { ...notes, id: 'att_notesB001' };
    const c = { ...notes, id: 'att_notesC001' };
    const { s } = store([a, b, c]);
    const out = await turnAttachmentParts([a, b, c], { store: s, owner, guard: new AttachmentGuard(), pdfAsDocument: false });
    expect(out.parts).toHaveLength(2);
    expect(out.notes).toHaveLength(1);
    expect(out.notes[0]).toContain('att_notesC001');
    expect(out.notes[0]).toMatch(/text from files is full/);
  });

  it('gives any other file as its reference line, a removed one as removed, and one of another conversation not at all', async () => {
    const removed = { ...png, id: 'att_gone00001', removed: true };
    const { s } = store([zip, removed]);
    const out = await turnAttachmentParts([zip, removed, { ...png, id: 'att_other0001' }], { store: s, owner, guard: new AttachmentGuard(), pdfAsDocument: false });
    expect(out.parts).toEqual([]);
    expect(out.notes).toEqual([
      '[Attachment att_zip000001: "fonts.zip", application/zip, 8.6 MB]',
      '[Attachment att_gone00001: "logo.png" (removed)]',
      '[Attachment att_other0001: not available in this conversation]',
    ]);
  });

  it('gives a file as its reference when the turn’s allowance would be passed, and counts it as left out', async () => {
    const { s, load } = store([png]);
    const guard = new AttachmentGuard({ turnTokens: 100 });
    const out = await turnAttachmentParts([png], { store: s, owner, guard, pdfAsDocument: false });
    expect(load).not.toHaveBeenCalled();
    expect(out.parts).toEqual([]);
    expect(out.notes[0]).toMatch(/allowance for files is used up; look at it with attachment_view/);
    expect(guard.usage()).toMatchObject({ count: 1, leftOut: 1 });
  });
});

describe('the turn’s message with its files', () => {
  it('keeps the message’s text first, then the notes, then the parts', () => {
    const messages: ModelMessage[] = [{ role: 'user', content: 'Use this as the logo' }];
    const out = withTurnAttachments(messages, { parts: [{ type: 'file', mediaType: 'image/png', data: bytes }], notes: ['[a note]'] });
    expect(out).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Use this as the logo' }, { type: 'text', text: '[a note]' }, { type: 'file', mediaType: 'image/png', data: bytes }] },
    ]);
  });

  it('replaces a part the guard left out by its line, on the message and in a tool result', () => {
    const part = { type: 'file' as const, mediaType: 'image/png', data: bytes };
    const messages: ModelMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'Look' }, { ...part }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-1', toolName: 'attachment_read', output: { type: 'text', value: '{"text":"long"}' } }] },
    ];
    const out = withoutLeftOut(messages, [
      { key: 'm', attachmentId: 'att_logo00001', kind: 'image', tokens: 10, where: { message: true }, part, leftOutLine: '[picture not repeated]' },
      { key: 't', attachmentId: 'att_notes0001', kind: 'text', tokens: 10, where: { toolCallId: 'call-1' }, leftOutLine: 'text not repeated' },
    ]);
    expect(out[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'text', text: '[picture not repeated]' }] });
    expect((out[1] as { content: Array<{ output: unknown }> }).content[0].output).toEqual({ type: 'text', value: '{"leftOut":"text not repeated"}' });
  });

  it('puts an earlier message’s files in history as their reference lines', () => {
    expect(withReferenceLines('Here are two', [png, zip])).toBe(
      'Here are two\n\n[Attachment att_logo00001: "logo.png", image/png, 391 KB, 1200×800 px]\n[Attachment att_zip000001: "fonts.zip", application/zip, 8.6 MB]',
    );
    expect(withReferenceLines('', [zip])).toBe('[Attachment att_zip000001: "fonts.zip", application/zip, 8.6 MB]');
    expect(withReferenceLines('Plain', undefined)).toBe('Plain');
  });
});

describe('the cost guard', () => {
  it('counts what each step carries, and leaves out the costliest part once a step would pass the cap', () => {
    const guard = new AttachmentGuard({ turnTokens: 5_000 });
    guard.add({ key: 'a', attachmentId: 'att_a0000001', kind: 'image', tokens: 1_500, where: { message: true }, leftOutLine: 'a' });
    guard.add({ key: 'b', attachmentId: 'att_b0000001', kind: 'text', tokens: 500, textChars: 2_000, where: { message: true }, leftOutLine: 'b' });
    expect(guard.beforeStep()).toEqual([]); // 2,000
    expect(guard.beforeStep()).toEqual([]); // 4,000
    expect(guard.beforeStep().map((p) => p.key)).toEqual(['a']); // 4,000 + 2,000 would pass: the picture goes; 4,500
    expect(guard.beforeStep()).toEqual([]); // 4,500 + 500 is the cap exactly: 5,000
    expect(guard.beforeStep().map((p) => p.key)).toEqual(['b']); // nothing more fits
    expect(guard.usage()).toMatchObject({ count: 2, estimatedTokens: 5_000, leftOut: 2 });
  });

  it('takes the conversation’s earlier use off what the turn may give', () => {
    const guard = new AttachmentGuard({ turnTokens: 30_000, conversationTokens: 300_000, conversationUsed: 299_000 });
    expect(guard.admits(1_000)).toBe(true);
    expect(guard.admits(1_001)).toBe(false);
  });
});

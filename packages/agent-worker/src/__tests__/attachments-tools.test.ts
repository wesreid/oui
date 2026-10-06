/**
 * The attachment tools (ADR-0252 §2.12): a file by its id, through the host's
 * store for the turn's own conversation, each counted by the cost guard.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AttachmentRef } from '@ouispec/agent-core';
import { AttachmentGuard } from '../attachments/guard.js';
import { attachmentTools, ATTACHMENT_TOOL_CLASS } from '../attachments/tools.js';
import type { AttachmentStore } from '../attachments/store.js';

const owner = { userId: 'u1', accountId: 'a1', conversationId: 'c1' };
const png: AttachmentRef = { id: 'att_logo00001', name: 'logo.png', mediaType: 'image/png', kind: 'image', bytes: 400_000, width: 1200, height: 800 };
const notes: AttachmentRef = { id: 'att_notes0001', name: 'notes.md', mediaType: 'text/markdown', kind: 'text', bytes: 30_000 };
const zip: AttachmentRef = { id: 'att_zip000001', name: 'fonts.zip', mediaType: 'application/zip', kind: 'other', bytes: 9_000_000 };
const gone: AttachmentRef = { ...png, id: 'att_gone00001', removed: true };
const text = 'abcdefghij'.repeat(5_000);

function tools(guard = new AttachmentGuard()) {
  const store: AttachmentStore = {
    describe: vi.fn(async (ids: readonly string[]) => [png, notes, zip, gone].filter((f) => ids.includes(f.id))),
    load: vi.fn(async (_id, _o, as, range) =>
      as === 'image'
        ? { ok: true as const, mediaType: 'image/webp', bytes: new Uint8Array([1, 2, 3]) }
        : { ok: true as const, text: text.slice(range!.offset, range!.offset + range!.limit), totalChars: text.length },
    ),
    list: vi.fn(async () => [png, notes, gone]),
  };
  const [list, view, read] = attachmentTools({ store, owner, guard });
  const ctx = { userId: 'u1', accountId: 'a1', turnId: 't1', conversationId: 'c1', toolCallId: 'call-1' };
  return { list, view, read, store, ctx, guard };
}

describe('the attachment tools', () => {
  it('are SDK-owned backend tools of the attachment class that only read', () => {
    const { list, view, read } = tools();
    for (const t of [list, view, read]) {
      expect(t).toMatchObject({ toolClass: ATTACHMENT_TOOL_CLASS, kind: 'backend', effect: 'view' });
      expect(t.inputSchema.sideEffects).toBe(false);
    }
    expect([list.name, view.name, read.name]).toEqual(['attachment_list', 'attachment_view', 'attachment_read']);
  });

  it('list the conversation’s files with their lines, removed ones marked', async () => {
    const { list, store, ctx } = tools();
    const out = await list.execute({}, ctx);
    expect(store.list).toHaveBeenCalledWith(owner);
    expect(out).toMatchObject({ success: true, data: { count: 3 } });
    expect((out.data as { files: Array<{ line: string }> }).files.map((f) => f.line)).toEqual([
      '[Attachment att_logo00001: "logo.png", image/png, 391 KB, 1200×800 px]',
      '[Attachment att_notes0001: "notes.md", text/markdown, 29 KB]',
      '[Attachment att_gone00001: "logo.png" (removed)]',
    ]);
  });

  it('show a picture as the result’s picture, never in its text', async () => {
    const { view, ctx, guard } = tools();
    const out = await view.execute({ id: 'att_logo00001' }, ctx);
    expect(out.success).toBe(true);
    expect(out.image).toEqual({ mediaType: 'image/webp', base64: 'AQID' });
    expect(JSON.stringify(out.data)).not.toContain('AQID');
    expect(guard.usage()).toMatchObject({ images: 1 });
  });

  it('read a page of a file’s text and say where the next starts', async () => {
    const { read, ctx } = tools();
    const out = await read.execute({ id: 'att_notes0001', offset: 100, limit: 50 }, ctx);
    expect(out).toMatchObject({ success: true, data: { offset: 100, totalChars: 50_000, next: 150, text: text.slice(100, 150) } });
  });

  it('refuse what is not theirs to do: a picture to read, text to view, a file with no text, a removed file, an id of another conversation, a path', async () => {
    const { view, read, ctx } = tools();
    expect((await read.execute({ id: 'att_logo00001' }, ctx)).error).toMatch(/is a picture: look at it with attachment_view/);
    expect((await view.execute({ id: 'att_notes0001' }, ctx)).error).toMatch(/is not a picture/);
    expect((await read.execute({ id: 'att_zip000001' }, ctx)).error).toMatch(/has no text to read/);
    expect((await view.execute({ id: 'att_gone00001' }, ctx)).error).toMatch(/removed/);
    expect((await view.execute({ id: 'att_unknown01' }, ctx)).error).toMatch(/No attachment att_unknown01 in this conversation/);
    expect((await read.execute({ id: '../../etc/passwd' }, ctx)).error).toMatch(/Give the attachment’s id/);
  });

  it('count against the turn’s allowance, and say so when it is used up', async () => {
    const { view, ctx } = tools(new AttachmentGuard({ turnTokens: 10 }));
    const out = await view.execute({ id: 'att_logo00001' }, ctx);
    expect(out).toMatchObject({ success: false, error: expect.stringMatching(/allowance for files is used up/) });
  });
});

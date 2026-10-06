/**
 * Inputs that take a file the user attached (§7.3.11): the index says "file",
 * and the runtime turns each id into the file or its text through the host
 * before the handler runs, refusing what it cannot resolve or the input does
 * not accept.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSurfaceRuntime, defineSurface } from '../../src/core/index.js';
import { attachmentIdsIn, attachmentInputOf, summarizeInput, isAttachmentId, OUI_ATTACHMENT_FORMAT } from '../../src/spec/index.js';

const logo = { type: 'string', format: OUI_ATTACHMENT_FORMAT, 'x-oui-attachment': { as: 'file', mediaTypes: ['image/*'] } } as const;
const svg = { type: 'string', format: OUI_ATTACHMENT_FORMAT, 'x-oui-attachment': { as: 'text', mediaTypes: ['image/svg+xml'] } } as const;

function surface(handler = vi.fn(async (params: Record<string, unknown>) => ({ success: true, data: { got: Object.keys(params) } }))) {
  return {
    handler,
    s: defineSurface({
      id: 'studio',
      name: 'Studio',
      description: 'graphics',
      actions: [
        { id: 'texture_set', description: 'Use a picture as the texture', input: { type: 'object', properties: { picture: logo, scale: { type: 'number' } }, required: ['picture'] }, handler },
        { id: 'svg_open', description: 'Open an SVG', input: { type: 'object', properties: { svg } }, handler },
        { id: 'gallery_add', description: 'Add pictures', input: { type: 'object', properties: { pictures: { type: 'array', items: logo } } }, handler },
      ],
    }),
  };
}

let requests = 0;
// Each request its own id: the runtime answers an id it has answered with the same answer.
const request = (actionId: string, params: Record<string, unknown>) => ({ requestId: `r-${++requests}`, surfaceId: 'studio', actionId, params, timestamp: 0 });
const settle = { quietMs: 0, timeoutMs: 20 };

describe('an input that takes an attached file', () => {
  it('is read from its schema, and its ids from the params', () => {
    expect(attachmentInputOf(logo)).toEqual({ as: 'file', mediaTypes: ['image/*'] });
    expect(attachmentInputOf({ type: 'string' })).toBeNull();
    expect(attachmentIdsIn({ type: 'object', properties: { pictures: { type: 'array', items: logo }, svg } }, { pictures: ['att_aaaaaaaa', 'att_bbbbbbbb'], svg: 'att_cccccccc' }).map((x) => x.id)).toEqual([
      'att_aaaaaaaa',
      'att_bbbbbbbb',
      'att_cccccccc',
    ]);
    expect(isAttachmentId('att_aaaaaaaa')).toBe(true);
    expect(isAttachmentId('https://evil.example/x.png')).toBe(false);
  });

  it('is described in the index as a file, with what it accepts', () => {
    expect(summarizeInput({ type: 'object', properties: { picture: logo }, required: ['picture'] })).toBe('picture: file(image/*)');
  });

  it('reaches the handler as the file, or its text, resolved through the host', async () => {
    const png = new File([new Uint8Array([1])], 'logo.png', { type: 'image/png' });
    const resolve = vi.fn(async (id: string, as: 'file' | 'text') => (as === 'text' ? '<svg/>' : png));
    const { s, handler } = surface();
    const runtime = createSurfaceRuntime({ announce: false, settle, attachments: { resolve } });
    runtime.mount(s, () => ({}));

    expect(await runtime.execute(request('texture_set', { picture: 'att_aaaaaaaa', scale: 2 }))).toMatchObject({ success: true });
    expect(handler).toHaveBeenLastCalledWith({ picture: png, scale: 2 }, {});
    await runtime.execute(request('svg_open', { svg: 'att_cccccccc' }));
    expect(handler).toHaveBeenLastCalledWith({ svg: '<svg/>' }, {});
    await runtime.execute(request('gallery_add', { pictures: ['att_aaaaaaaa', 'att_bbbbbbbb'] }));
    expect(handler).toHaveBeenLastCalledWith({ pictures: [png, png] }, {});
    expect(resolve.mock.calls.map(([id, as]) => `${id}:${as}`)).toEqual(['att_aaaaaaaa:file', 'att_cccccccc:text', 'att_aaaaaaaa:file', 'att_bbbbbbbb:file']);
    runtime.dispose();
  });

  it('is refused, and the handler not run, when the file cannot be had, is not a type it takes, or the page has no way to open files', async () => {
    const pdf = new File([new Uint8Array([1])], 'deck.pdf', { type: 'application/pdf' });
    const { s, handler } = surface();
    const runtime = createSurfaceRuntime({
      announce: false,
      settle,
      attachments: { resolve: async (id) => (id === 'att_gone0001' ? Promise.reject(new Error('It was removed.')) : pdf) },
    });
    runtime.mount(s, () => ({}));
    expect(await runtime.execute(request('texture_set', { picture: 'att_gone0001' }))).toMatchObject({
      success: false,
      error: { code: 'ATTACHMENT_UNAVAILABLE', message: 'picture: It was removed.' },
    });
    expect(await runtime.execute(request('texture_set', { picture: 'att_pdf00001' }))).toMatchObject({
      success: false,
      error: { code: 'ATTACHMENT_UNAVAILABLE', message: expect.stringMatching(/deck\.pdf" is application\/pdf; this takes image\/\*/) },
    });
    expect(await runtime.execute(request('texture_set', { picture: '../secret' }))).toMatchObject({ success: false, error: { code: 'ATTACHMENT_UNAVAILABLE' } });
    expect(handler).not.toHaveBeenCalled();
    runtime.dispose();

    const bare = createSurfaceRuntime({ announce: false, settle });
    bare.mount(surface(handler).s, () => ({}));
    expect(await bare.execute(request('texture_set', { picture: 'att_aaaaaaaa' }))).toMatchObject({ success: false, error: { code: 'ATTACHMENTS_UNSUPPORTED' } });
    // An action that takes no file runs as it always did.
    bare.dispose();
  });
});

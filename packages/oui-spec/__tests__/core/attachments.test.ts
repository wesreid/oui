/**
 * Inputs that take a file the user attached (§7.3.11): the index says "file",
 * and the runtime turns each id into the file or its text through the host
 * before the handler runs, refusing what it cannot resolve or the input does
 * not accept.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSurfaceRuntime, defineSurface } from '../../src/core/index.js';
import { attachmentIdsIn, attachmentInputOf, misplacedAttachmentInputs, summarizeInput, isAttachmentId, OUI_ATTACHMENT_FORMAT } from '../../src/spec/index.js';
import { ATTACHMENT_LIST_MAX } from '../../src/core/index.js';

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
/** A file as a page receives it. `File` is not a global on Node 18, which oui-spec supports: a named Blob stands for one. */
const fileOf = (name: string, type: string) => Object.assign(new Blob([new Uint8Array([1])], { type }), { name, lastModified: 0 }) as unknown as File;

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
    const png = fileOf('logo.png', 'image/png');
    const resolve = vi.fn(async (_id: string, as: 'file' | 'text') => (as === 'text' ? { name: 'mark.svg', mediaType: 'image/svg+xml', text: '<svg/>' } : png));
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
    const pdf = fileOf('deck.pdf', 'application/pdf');
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

describe('what an attachment input is given', () => {
  it('is checked against the types it accepts when it takes text, however the host gives it', async () => {
    const { s, handler } = surface();
    const html = fileOf('page.html', 'text/html');
    const answers: Record<string, unknown> = {
      att_html0001: html,
      att_htmltext: { name: 'page.html', mediaType: 'text/html', text: '<script>alert(1)</script>' },
      att_bare0001: '<svg/>',
      att_svgfile1: Object.assign(new Blob(['<svg id="ok"/>'], { type: 'image/svg+xml' }), { name: 'ok.svg' }),
    };
    const runtime = createSurfaceRuntime({ announce: false, settle, attachments: { resolve: async (id) => answers[id] as never } });
    runtime.mount(s, () => ({}));
    expect(await runtime.execute(request('svg_open', { svg: 'att_html0001' }))).toMatchObject({
      success: false,
      error: { code: 'ATTACHMENT_UNAVAILABLE', message: 'svg: "page.html" is text/html; this takes image/svg+xml.' },
    });
    expect(await runtime.execute(request('svg_open', { svg: 'att_htmltext' }))).toMatchObject({
      success: false,
      error: { code: 'ATTACHMENT_UNAVAILABLE', message: 'svg: "page.html" is text/html; this takes image/svg+xml.' },
    });
    // Text with no type cannot be checked against what the input takes.
    expect(await runtime.execute(request('svg_open', { svg: 'att_bare0001' }))).toMatchObject({
      success: false,
      error: { code: 'ATTACHMENT_UNAVAILABLE', message: expect.stringMatching(/without its type/) },
    });
    expect(handler).not.toHaveBeenCalled();
    // A file of a type it takes is read as its text.
    expect(await runtime.execute(request('svg_open', { svg: 'att_svgfile1' }))).toMatchObject({ success: true });
    expect(handler).toHaveBeenLastCalledWith({ svg: '<svg id="ok"/>' }, {});
    runtime.dispose();
  });

  it('is refused, and the handler not run, when the action declares a file below its own properties', async () => {
    const handler = vi.fn(async () => ({ success: true }));
    const nested = {
      type: 'object',
      properties: {
        brand: { type: 'object', properties: { logo } },
        either: { anyOf: [logo, { type: 'number' }] },
        grid: { type: 'array', items: { type: 'array', items: logo } },
      },
    } as const;
    expect(misplacedAttachmentInputs(nested as never)).toEqual(['brand.logo', 'either.anyOf[0]', 'grid[][]']);
    expect(misplacedAttachmentInputs({ type: 'object', properties: { picture: logo, pictures: { type: 'array', items: logo } } } as never)).toEqual([]);
    const s = defineSurface({ id: 'studio', name: 'Studio', description: 'graphics', actions: [{ id: 'brand_set', description: 'Set the brand', input: nested as never, handler }] });
    const resolve = vi.fn();
    const runtime = createSurfaceRuntime({ announce: false, settle, attachments: { resolve } });
    runtime.mount(s, () => ({}));
    expect(await runtime.execute(request('brand_set', { brand: { logo: 'att_aaaaaaaa' } }))).toMatchObject({
      success: false,
      error: { code: 'ATTACHMENT_INPUT_UNSUPPORTED', message: expect.stringMatching(/brand\.logo, either\.anyOf\[0\], grid\[\]\[\]/) },
    });
    expect(handler).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it('resolves a file named twice once, a list a few at a time, and refuses a list over the most it takes', async () => {
    const png = fileOf('logo.png', 'image/png');
    let open = 0;
    let most = 0;
    const resolve = vi.fn(async () => {
      open++;
      most = Math.max(most, open);
      await new Promise((r) => setTimeout(r, 1));
      open--;
      return png;
    });
    const { s, handler } = surface();
    const runtime = createSurfaceRuntime({ announce: false, settle, attachments: { resolve } });
    runtime.mount(s, () => ({}));
    const ids = Array.from({ length: 12 }, (_, i) => `att_${String(i).padStart(8, '0')}`);
    expect(await runtime.execute(request('gallery_add', { pictures: [...ids, ids[0], ids[0]] }))).toMatchObject({ success: true });
    expect(resolve).toHaveBeenCalledTimes(12);
    expect(most).toBeLessThanOrEqual(4);
    expect((handler.mock.calls.at(-1)![0] as { pictures: unknown[] }).pictures).toHaveLength(14);

    resolve.mockClear();
    const tooMany = Array.from({ length: ATTACHMENT_LIST_MAX + 1 }, (_, i) => `att_${String(i).padStart(8, '0')}`);
    expect(await runtime.execute(request('gallery_add', { pictures: tooMany }))).toMatchObject({
      success: false,
      error: { code: 'ATTACHMENT_UNAVAILABLE', message: `pictures: it names ${ATTACHMENT_LIST_MAX + 1} files; a list takes at most ${ATTACHMENT_LIST_MAX}.` },
    });
    expect(resolve).not.toHaveBeenCalled();
    runtime.dispose();
  });
});

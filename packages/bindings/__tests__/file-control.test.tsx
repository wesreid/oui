/**
 * A control that takes a file (ADR-0252 §2.13): an upload zone or a file
 * button, bound as the `file` kind. Pressed by the assistant with the id of a
 * file the person attached, it runs the same handler the person's own choice
 * runs, with the file: the page resolves the id through its host first.
 */
import { act, render } from '@testing-library/react';
import { createSurfaceRuntime } from 'oui-spec/core';
import { summarizeInput } from 'oui-spec/spec';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBindingRegistry, deriveInputSchema, deriveValueSchema, validateValue, type OuiManifest } from '../src/index.js';
import { connectBindings } from '../src/oui.js';
import { AgentBindingProvider, useAgentBinding } from '../src/react.js';

const manifest: OuiManifest = {
  version: 1,
  buildId: 'test',
  surfaces: [
    {
      id: 'page:TexturesPage',
      kind: 'page',
      title: 'Textures',
      description: 'Textures for the project',
      routes: ['/textures'],
      actions: [
        {
          name: 'textures_upload',
          id: 'textures.upload',
          source: 'control',
          control: 'file',
          title: 'Upload a texture',
          description: 'Upload a picture as a texture',
          input: deriveInputSchema('file', { accept: ['image/png', 'image/jpeg'] }),
          reach: [],
        },
      ],
      observations: [],
    },
  ],
};

let disconnect: (() => void) | null = null;
afterEach(() => {
  disconnect?.();
  disconnect = null;
});

function Upload({ onFiles }: { onFiles: (file: File) => void }) {
  useAgentBinding({
    agent: { id: 'textures.upload', description: 'Upload a picture as a texture' },
    kind: 'file',
    title: 'Upload a texture',
    schemaProps: { accept: ['image/png', 'image/jpeg'] },
    run: ({ value }) => {
      onFiles(value as File);
      return { ok: true };
    },
  });
  return null;
}

describe('a file control', () => {
  it('takes an attached file’s id, described as a file of the types it accepts', () => {
    expect(deriveValueSchema('file', { accept: ['image/png'] })).toMatchObject({
      type: 'string',
      format: 'oui-attachment',
      'x-oui-attachment': { as: 'file', mediaTypes: ['image/png'] },
    });
    expect(summarizeInput(manifest.surfaces[0].actions[0].input as never)).toBe('value: file(image/png|image/jpeg)');
  });

  it('runs its handler with the file, as the person’s own choice does', async () => {
    const png = new File([new Uint8Array([1, 2])], 'brick.png', { type: 'image/png' });
    const resolve = vi.fn(async () => png);
    const registry = createBindingRegistry();
    const runtime = createSurfaceRuntime({ announce: false, settle: { quietMs: 0, timeoutMs: 50 }, attachments: { resolve } });
    disconnect = connectBindings({ registry, runtime, manifest });
    const onFiles = vi.fn();
    render(
      <AgentBindingProvider registry={registry}>
        <Upload onFiles={onFiles} />
      </AgentBindingProvider>,
    );
    await act(async () => {});
    const result = await act(() =>
      runtime.execute({ requestId: 'u1', surfaceId: 'page:TexturesPage', actionId: 'textures_upload', params: { value: 'att_brick0001' }, timestamp: 0 }),
    );
    expect(result).toMatchObject({ success: true });
    expect(resolve).toHaveBeenCalledWith('att_brick0001', 'file');
    expect(onFiles).toHaveBeenCalledWith(png);
  });

  it('refuses a file of a type it does not take, and never runs its handler', async () => {
    const pdf = new File([new Uint8Array([1])], 'deck.pdf', { type: 'application/pdf' });
    const registry = createBindingRegistry();
    const runtime = createSurfaceRuntime({ announce: false, settle: { quietMs: 0, timeoutMs: 50 }, attachments: { resolve: async () => pdf } });
    disconnect = connectBindings({ registry, runtime, manifest });
    const onFiles = vi.fn();
    render(
      <AgentBindingProvider registry={registry}>
        <Upload onFiles={onFiles} />
      </AgentBindingProvider>,
    );
    await act(async () => {});
    const result = await act(() =>
      runtime.execute({ requestId: 'u2', surfaceId: 'page:TexturesPage', actionId: 'textures_upload', params: { value: 'att_deck00001' }, timestamp: 0 }),
    );
    expect(result).toMatchObject({ success: false, error: { code: 'ATTACHMENT_UNAVAILABLE' } });
    expect(onFiles).not.toHaveBeenCalled();
  });
});

describe('a file input’s value', () => {
  it('is the file itself for an input that takes a file, and the text for one that takes text: an unresolved id or URL is neither', () => {
    const file = deriveValueSchema('file', { accept: ['image/png'] });
    const png = new File([new Uint8Array([1])], 'logo.png', { type: 'image/png' });
    expect(validateValue(file as never, png)).toBeNull();
    expect(validateValue(file as never, 'att_logo00001')).toBe('value must be an attached file');
    expect(validateValue(file as never, 'https://evil.example/logo.png')).toBe('value must be an attached file');
    const text = { type: 'string', format: 'oui-attachment', 'x-oui-attachment': { as: 'text', mediaTypes: ['image/svg+xml'] } };
    expect(validateValue(text as never, '<svg/>')).toBeNull();
    expect(validateValue(text as never, png)).toBe("value must be an attached file's text");
  });
});

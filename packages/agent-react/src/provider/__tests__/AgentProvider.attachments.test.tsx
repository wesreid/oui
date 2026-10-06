// @vitest-environment jsdom
/**
 * The composer's files (ADR-0252 §2.14): a file is uploaded the moment it is
 * attached, into the conversation (made then if there is none), refused
 * before upload when it breaks the platform's limits, and the message carries
 * the references of the ready files once the uploads still running finish.
 * No file's bytes go with the message.
 */
import React from 'react';
import { act, render, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ATTACHMENT_LIMITS, type AgentClientConfig, type AttachmentRef } from '@ouispec/agent-core';
import { createFakeSocket } from './fake-socket.js';

const { AgentProvider, useAgent } = await import('../AgentProvider.js');

let agent: ReturnType<typeof useAgent>;
function Probe() {
  agent = useAgent();
  return null;
}
afterEach(cleanup);

const file = (name: string, type: string, size: number) => new File([new Uint8Array(size)], name, { type });
const refOf = (f: File, id: string): AttachmentRef => ({ id, name: f.name, mediaType: f.type, kind: 'image', bytes: f.size });
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

function setup(overrides: Partial<AgentClientConfig> = {}) {
  const uploads: Array<{ name: string; conversationId: string; resolve: (ref: AttachmentRef) => void; reject: (e: Error) => void; signal: AbortSignal; progress?: (f: number) => void }> = [];
  const createConversation = vi.fn(async () => ({ conversationId: 'conv-1' }));
  const sendMessage = vi.fn(async (_p: { content: string; attachments?: AttachmentRef[] }) => ({ turnId: 'turn-1', socketRoom: 'chat:turn:turn-1', roomToken: 'tok' }));
  const remove = vi.fn(async () => {});
  const config: AgentClientConfig = {
    createConversation,
    sendMessage,
    realtime: { url: 'wss://rt.example', getToken: () => 'jwt', createSocket: () => createFakeSocket() },
    attachments: {
      limits: DEFAULT_ATTACHMENT_LIMITS,
      upload: (f, { conversationId, signal, onProgress }) =>
        new Promise<AttachmentRef>((resolve, reject) => uploads.push({ name: f.name, conversationId, resolve, reject, signal, progress: onProgress })),
      remove,
    },
    ...overrides,
  };
  render(React.createElement(AgentProvider, { config }, React.createElement(Probe)));
  return { uploads, createConversation, sendMessage, remove };
}

describe('the composer’s files', () => {
  it('uploads a file when it is attached, into a conversation made once for all of them', async () => {
    const { uploads, createConversation } = setup();
    expect(agent.attachments.enabled).toBe(true);
    const a = file('logo.png', 'image/png', 1000);
    const b = file('notes.txt', 'text/plain', 200);
    act(() => agent.attachments.attach([a, b]));
    await flush();
    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(uploads.map((u) => [u.name, u.conversationId])).toEqual([['logo.png', 'conv-1'], ['notes.txt', 'conv-1']]);
    expect(agent.attachments.items.map((i) => i.status)).toEqual(['uploading', 'uploading']);
    expect(agent.attachments.uploading).toBe(true);

    act(() => uploads[0].progress?.(0.5));
    expect(agent.attachments.items[0].progress).toBe(0.5);
    await act(async () => uploads[0].resolve(refOf(a, 'att_aaaaaaaa')));
    expect(agent.attachments.items[0]).toMatchObject({ status: 'ready', progress: 1, ref: { id: 'att_aaaaaaaa' } });
  });

  it('refuses a file past the limits before uploading it, and says why', async () => {
    const { uploads } = setup();
    act(() => agent.attachments.attach([file('huge.png', 'image/png', 21 * 1024 * 1024)]));
    await flush();
    expect(uploads).toEqual([]);
    expect(agent.attachments.items[0]).toMatchObject({ status: 'refused', error: expect.stringMatching(/Too large/) });
  });

  it('shows the platform’s refusal of an upload on the file', async () => {
    const { uploads } = setup();
    act(() => agent.attachments.attach([file('x.png', 'image/png', 10)]));
    await flush();
    await act(async () => uploads[0].reject(new Error('The file is not what its type says.')));
    expect(agent.attachments.items[0]).toMatchObject({ status: 'refused', error: 'The file is not what its type says.' });
  });

  it('sends the message once the uploads finish, with the ready files’ references and nothing else', async () => {
    const { uploads, sendMessage } = setup();
    const a = file('logo.png', 'image/png', 1000);
    act(() => agent.attachments.attach([a, file('huge.png', 'image/png', 21 * 1024 * 1024)]));
    await flush();
    let sent: Promise<unknown> | undefined;
    act(() => {
      sent = agent.sendMessage('Use this as the logo');
    });
    await flush();
    expect(sendMessage).not.toHaveBeenCalled();
    await act(async () => {
      uploads[0].resolve(refOf(a, 'att_aaaaaaaa'));
      await sent;
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0]).toMatchObject({ conversationId: 'conv-1', content: 'Use this as the logo', attachments: [refOf(a, 'att_aaaaaaaa')] });
    expect(agent.attachments.items).toEqual([]);
    const shown = agent.messages.find((m) => m.role === 'user');
    expect(shown).toMatchObject({ content: 'Use this as the logo', attachments: [{ id: 'att_aaaaaaaa' }] });
  });

  it('cancels an upload taken off the message, and removes an uploaded file from the file area', async () => {
    const { uploads, remove } = setup();
    const a = file('a.png', 'image/png', 10);
    act(() => agent.attachments.attach([a, file('b.png', 'image/png', 10)]));
    await flush();
    await act(async () => uploads[0].resolve(refOf(a, 'att_aaaaaaaa')));
    const [first, second] = agent.attachments.items;
    act(() => agent.attachments.remove(second.key));
    expect(uploads[1].signal.aborted).toBe(true);
    act(() => agent.attachments.remove(first.key));
    await flush();
    expect(remove).toHaveBeenCalledWith(refOf(a, 'att_aaaaaaaa'), { conversationId: 'conv-1' });
    expect(agent.attachments.items).toEqual([]);
  });

  it('takes no files when the platform has no file area', async () => {
    setup({ attachments: undefined });
    expect(agent.attachments.enabled).toBe(false);
    act(() => agent.attachments.attach([file('a.png', 'image/png', 10)]));
    expect(agent.attachments.items).toEqual([]);
  });
});

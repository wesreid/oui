// @vitest-environment jsdom
/**
 * The composer's files (ADR-0252 §2.14): a file is uploaded the moment it is
 * attached, into the conversation (made then if there is none), refused
 * before upload when it breaks the platform's limits, and the message carries
 * the references of the ready files once the uploads still running finish.
 * No file's bytes go with the message.
 */
import React from 'react';
import { act, render, renderHook, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ATTACHMENT_LIMITS, type AgentClientConfig, type AttachmentRef } from '@ouispec/agent-core';
import { createFakeSocket } from './fake-socket.js';

const { AgentProvider, useAgent } = await import('../AgentProvider.js');
const { useComposerAttachments } = await import('../attachments.js');

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
    act(() => agent.attachments.attach([a]));
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

describe('a Send that waits for its files', () => {
  async function waitingSend(text = 'Use this as the logo') {
    let sent: Promise<{ turnId: string; notSent?: { reason: string; content: string } }> | undefined;
    act(() => {
      sent = agent.sendMessage(text);
    });
    await flush();
    return () => sent!;
  }

  it('is held, keeping the draft, when a file fails after Send: the file keeps its chip and why', async () => {
    const { uploads, sendMessage } = setup();
    const a = file('logo.png', 'image/png', 1000);
    act(() => agent.attachments.attach([a, file('notes.txt', 'text/plain', 10)]));
    await flush();
    await act(async () => uploads[0].resolve(refOf(a, 'att_aaaaaaaa')));
    const sent = await waitingSend();
    expect(agent.attachments.waitingToSend).toBe(true);
    await act(async () => uploads[1].reject(new Error('The file did not pass its check.')));
    await expect(sent()).resolves.toEqual({ turnId: '', notSent: { reason: 'file_refused', content: 'Use this as the logo' } });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(agent.attachments.waitingToSend).toBe(false);
    expect(agent.attachments.items.map((i) => [i.name, i.status, i.error])).toEqual([
      ['logo.png', 'ready', undefined],
      ['notes.txt', 'refused', 'The file did not pass its check.'],
    ]);
  });

  it('is held while a refused file is on the message, until it is taken off', async () => {
    const { uploads, sendMessage } = setup();
    const a = file('logo.png', 'image/png', 1000);
    act(() => agent.attachments.attach([a, file('huge.png', 'image/png', 21 * 1024 * 1024)]));
    await flush();
    await act(async () => uploads[0].resolve(refOf(a, 'att_aaaaaaaa')));
    await expect(act(() => agent.sendMessage('Logo'))).resolves.toMatchObject({ notSent: { reason: 'file_refused', content: 'Logo' } });
    act(() => agent.attachments.remove(agent.attachments.items[1].key));
    await act(() => agent.sendMessage('Logo'));
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ attachments: [refOf(a, 'att_aaaaaaaa')] }));
  });

  it('refuses a second Send while it waits, so one message goes, once', async () => {
    const { uploads, sendMessage } = setup();
    const a = file('logo.png', 'image/png', 1000);
    act(() => agent.attachments.attach([a]));
    await flush();
    const first = await waitingSend('once');
    const second = await waitingSend('twice');
    await expect(second()).resolves.toEqual({ turnId: '', notSent: { reason: 'waiting', content: 'twice' } });
    await act(async () => {
      uploads[0].resolve(refOf(a, 'att_aaaaaaaa'));
      await first();
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0]).toMatchObject({ content: 'once' });
  });

  it('is dropped, with the draft kept, when the conversation changes while it waits; the files it uploaded are removed', async () => {
    const { uploads, sendMessage, remove } = setup();
    const a = file('logo.png', 'image/png', 1000);
    act(() => agent.attachments.attach([a, file('notes.txt', 'text/plain', 10)]));
    await flush();
    await act(async () => uploads[0].resolve(refOf(a, 'att_aaaaaaaa')));
    const sent = await waitingSend();
    act(() => agent.startNewConversation());
    await expect(sent()).resolves.toEqual({ turnId: '', notSent: { reason: 'conversation_changed', content: 'Use this as the logo' } });
    // The upload that was still running is cancelled even if it never answers; nothing went to the new conversation.
    expect(uploads[1].signal.aborted).toBe(true);
    await act(async () => uploads[1].resolve(refOf(file('notes.txt', 'text/plain', 10), 'att_bbbbbbbb')));
    await flush();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(agent.attachments.items).toEqual([]);
    // Neither file stays in the file area of the conversation that was left.
    expect(remove.mock.calls.map(([ref, where]) => [(ref as AttachmentRef).id, where])).toEqual([
      ['att_aaaaaaaa', { conversationId: 'conv-1' }],
      ['att_bbbbbbbb', { conversationId: 'conv-1' }],
    ]);
  });

  it('ends when Stop gives it up, even when the upload ignores its cancel: nothing sent, the files kept', async () => {
    const { uploads, sendMessage } = setup();
    act(() => agent.attachments.attach([file('logo.png', 'image/png', 1000)]));
    await flush();
    const sent = await waitingSend();
    await act(() => agent.stopTurn());
    await expect(sent()).resolves.toEqual({ turnId: '', notSent: { reason: 'cancelled', content: 'Use this as the logo' } });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(agent.attachments.waitingToSend).toBe(false);
    expect(agent.attachments.items).toHaveLength(1);
    expect(uploads[0].signal.aborted).toBe(false);
  });

  it('takes only the files that were on the message at Send: one attached while it waits stays for the next', async () => {
    const { uploads, sendMessage } = setup();
    const a = file('logo.png', 'image/png', 1000);
    const b = file('later.png', 'image/png', 1000);
    act(() => agent.attachments.attach([a]));
    await flush();
    const sent = await waitingSend();
    act(() => agent.attachments.attach([b]));
    await flush();
    await act(async () => {
      uploads[0].resolve(refOf(a, 'att_aaaaaaaa'));
      await sent();
    });
    expect(sendMessage.mock.calls[0][0].attachments).toEqual([refOf(a, 'att_aaaaaaaa')]);
    expect(agent.attachments.items.map((i) => [i.name, i.status])).toEqual([['later.png', 'uploading']]);
  });

  it('removes a file whose upload finished after it was taken off the message', async () => {
    const { uploads, remove } = setup();
    const a = file('logo.png', 'image/png', 1000);
    act(() => agent.attachments.attach([a]));
    await flush();
    act(() => agent.attachments.remove(agent.attachments.items[0].key));
    // The platform had it already: its answer arrives after the cancel.
    await act(async () => uploads[0].resolve(refOf(a, 'att_aaaaaaaa')));
    await flush();
    expect(remove).toHaveBeenCalledExactlyOnceWith(refOf(a, 'att_aaaaaaaa'), { conversationId: 'conv-1' });
    expect(agent.attachments.items).toEqual([]);
  });
});

describe('a file attached while the tab restores its conversation', () => {
  const KEY = 'agent-sdk.activeConversation';
  afterEach(() => window.sessionStorage.clear());

  function restoring() {
    let finish!: () => void;
    const getConversation = vi.fn(
      (id: string) =>
        new Promise<{ conversationId: string; messages: [] }>((resolve) => {
          finish = () => resolve({ conversationId: id, messages: [] });
        }),
    );
    window.sessionStorage.setItem(KEY, 'conv-R');
    const t = setup({ getConversation: getConversation as never });
    return { ...t, getConversation, finish: () => act(async () => finish()) };
  }

  it('goes into the conversation being restored, not a new one, and is sent with the message to it', async () => {
    const { uploads, createConversation, sendMessage, finish } = restoring();
    const png = file('pasted.png', 'image/png', 100);
    act(() => agent.attachments.attach([png]));
    await flush();
    // Nothing is uploaded, and no conversation made, until the restore has said which conversation this is.
    expect(uploads).toEqual([]);
    await finish();
    await flush();
    expect(createConversation).not.toHaveBeenCalled();
    expect(uploads.map((u) => u.conversationId)).toEqual(['conv-R']);
    await act(async () => uploads[0].resolve(refOf(png, 'att_pasted01')));
    await act(() => agent.sendMessage('This one'));
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ conversationId: 'conv-R', attachments: [refOf(png, 'att_pasted01')] }));
  });

  it('is never sent with a message to a conversation other than the one it went into', async () => {
    let open: string | null = 'conv-A';
    const uploads: Array<(ref: AttachmentRef) => void> = [];
    const { result } = renderHook(() =>
      useComposerAttachments({
        config: () => ({
          createConversation: vi.fn(),
          sendMessage: vi.fn(),
          realtime: { url: '' },
          attachments: { limits: DEFAULT_ATTACHMENT_LIMITS, upload: () => new Promise<AttachmentRef>((resolve) => uploads.push(resolve)) },
        }) as unknown as AgentClientConfig,
        ensureConversation: async () => open!,
        conversationId: () => open,
        messages: () => [],
        log: () => {},
      }),
    );
    const png = file('logo.png', 'image/png', 100);
    act(() => result.current.attach([png]));
    await flush();
    await act(async () => uploads[0](refOf(png, 'att_logo0001')));
    // The open conversation is another one now, and the composer was not cleared for it.
    open = 'conv-B';
    expect(result.current.takeForSend()).toEqual({ notSent: 'conversation_changed' });
    expect(result.current.items).toHaveLength(1);
    open = 'conv-A';
    expect(result.current.takeForSend()).toEqual({ refs: [refOf(png, 'att_logo0001')] });
  });
});

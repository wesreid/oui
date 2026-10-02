// @vitest-environment jsdom
/**
 * The user's conversations outlive the page: a reload returns the tab to its
 * conversation, and the user can go back to an earlier one or start anew.
 */
import React from 'react';
import { act, render, cleanup, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentClientConfig, AgentStoredConversation } from '@ouispec/agent-core';
import type { FakeSocket } from './fake-socket.js';

// ─── A fake Socket.IO client ─────────────────────────────────────────────────

let socket: FakeSocket;

vi.mock('socket.io-client', async () => {
  const { createFakeSocket } = await import('./fake-socket.js');
  return {
    io: () => {
      socket = createFakeSocket();
      return socket;
    },
  };
});

const { AgentProvider, useAgent } = await import('../AgentProvider.js');
const { storedToAgentMessages } = await import('../stored-messages.js');
const { AGENT_SOCKET_EVENTS } = await import('@ouispec/agent-core');

// ─── Harness ─────────────────────────────────────────────────────────────────

// The SDK's own default: it names no product (ADR-0227 §2.2).
const KEY = 'agent-sdk.activeConversation';

const STORED: Record<string, AgentStoredConversation> = {
  'conv-old': {
    conversationId: 'conv-old',
    title: null,
    messages: [
      { id: 'm1', role: 'user', content: 'Add the text INTRO', createdAt: '2026-09-29T10:00:00Z' },
      {
        id: 'm2',
        role: 'assistant',
        content: 'Adding it.',
        toolCalls: [{ id: 'call-1', name: 'canvas_add_text', arguments: { text: 'INTRO' } }],
        createdAt: '2026-09-29T10:00:01Z',
      },
      { id: 'm3', role: 'tool', content: '{"ok":true}', createdAt: '2026-09-29T10:00:02Z' },
      { id: 'm4', role: 'assistant', content: 'INTRO is on the artboard.', createdAt: '2026-09-29T10:00:03Z' },
    ],
  },
  'conv-other': {
    conversationId: 'conv-other',
    title: 'Other',
    messages: [{ id: 'o1', role: 'user', content: 'Something else', createdAt: '2026-09-28T09:00:00Z' }],
  },
};

let agent: ReturnType<typeof useAgent>;
function Probe() {
  agent = useAgent();
  return null;
}

let createConversation: ReturnType<typeof vi.fn>;
let getConversation: ReturnType<typeof vi.fn>;
let listConversations: ReturnType<typeof vi.fn>;
let sendMessage: ReturnType<typeof vi.fn>;

function config(overrides: Partial<AgentClientConfig> = {}): AgentClientConfig {
  return {
    createConversation,
    sendMessage,
    getConversation,
    listConversations,
    realtime: { url: 'wss://rt', getToken: () => 'jwt' },
    ...overrides,
  } as AgentClientConfig;
}

function mount(overrides: Partial<AgentClientConfig> = {}) {
  return render(React.createElement(AgentProvider, { config: config(overrides) }, React.createElement(Probe)));
}

beforeEach(() => {
  window.sessionStorage.clear();
  createConversation = vi.fn(async () => ({ conversationId: 'conv-new' }));
  sendMessage = vi.fn(async () => ({ turnId: 'turn-1', socketRoom: 'agent:turn:turn-1', roomToken: 'tok' }));
  getConversation = vi.fn(async (id: string) => {
    const found = STORED[id];
    if (!found) throw new Error('Conversation not found');
    return found;
  });
  listConversations = vi.fn(async () => ({
    conversations: [
      { conversationId: 'conv-old', title: null, preview: 'Add the text INTRO', createdAt: '2026-09-29T10:00:00Z', updatedAt: '2026-09-29T10:00:03Z' },
      { conversationId: 'conv-other', title: 'Other', preview: 'Something else', createdAt: '2026-09-28T09:00:00Z', updatedAt: '2026-09-28T09:00:00Z' },
    ],
    total: 2,
  }));
});
afterEach(cleanup);

// ─── Restore after a reload ──────────────────────────────────────────────────

describe('after a reload', () => {
  it("returns the tab to its conversation, with the stored messages as the panel showed them", async () => {
    window.sessionStorage.setItem(KEY, 'conv-old');
    mount();
    expect(agent.isLoadingConversation).toBe(true);
    await waitFor(() => expect(agent.conversationId).toBe('conv-old'));
    expect(agent.isLoadingConversation).toBe(false);
    expect(getConversation).toHaveBeenCalledWith('conv-old');
    expect(agent.messages.map(m => [m.role, m.content ?? m.toolCall?.name])).toEqual([
      ['user', 'Add the text INTRO'],
      ['assistant', 'Adding it.'],
      ['tool', 'canvas_add_text'],
      ['assistant', 'INTRO is on the artboard.'],
    ]);
  });

  it('continues that conversation: the next message goes to it, not to a new one', async () => {
    window.sessionStorage.setItem(KEY, 'conv-old');
    mount();
    // Sent before the restore finished: it waits for it.
    await act(async () => {
      await agent.sendMessage('Make it red');
    });
    expect(createConversation).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'conv-old', content: 'Make it red' }));
    expect(agent.messages.at(-1)).toMatchObject({ role: 'user', content: 'Make it red' });
  });

  it('starts fresh, and forgets it, when the conversation cannot be loaded', async () => {
    window.sessionStorage.setItem(KEY, 'conv-deleted');
    mount();
    await waitFor(() => expect(agent.isLoadingConversation).toBe(false));
    expect(agent.conversationId).toBeNull();
    expect(agent.messages).toEqual([]);
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    expect(agent.history.error).toBeNull();
  });

  it('remembers a conversation from its first message', async () => {
    mount();
    await act(async () => {
      await agent.sendMessage('hello');
    });
    expect(window.sessionStorage.getItem(KEY)).toBe('conv-new');
  });

  it('uses the platform key, and remembers nothing when it is turned off or cannot load', async () => {
    const custom = mount({ activeConversationKey: 'studio.pa' });
    await act(async () => {
      await agent.sendMessage('hello');
    });
    expect(window.sessionStorage.getItem('studio.pa')).toBe('conv-new');
    custom.unmount();

    window.sessionStorage.clear();
    const off = mount({ activeConversationKey: false });
    await act(async () => {
      await agent.sendMessage('hello');
    });
    expect(window.sessionStorage.length).toBe(0);
    off.unmount();

    window.sessionStorage.setItem(KEY, 'conv-old');
    mount({ getConversation: undefined });
    expect(agent.isLoadingConversation).toBe(false);
    expect(agent.conversationId).toBeNull();
    expect(agent.history.available).toBe(false);
  });
});

// ─── History ─────────────────────────────────────────────────────────────────

describe('earlier conversations', () => {
  it('lists them, newest first, as the platform returns them', async () => {
    mount();
    expect(agent.history.available).toBe(true);
    await act(async () => {
      await agent.history.refresh();
    });
    expect(listConversations).toHaveBeenCalledWith({ limit: 20, offset: 0 });
    expect(agent.history.conversations.map(c => c.conversationId)).toEqual(['conv-old', 'conv-other']);
    expect(agent.history.total).toBe(2);
  });

  it('says so when they cannot be listed', async () => {
    listConversations.mockRejectedValueOnce(new Error('500'));
    mount();
    await act(async () => {
      await agent.history.refresh();
    });
    expect(agent.history.error).toBe('Your conversations could not be loaded.');
  });

  it('switches to one, shows its messages and remembers it for the tab', async () => {
    mount();
    await act(async () => {
      await agent.sendMessage('hello');
    });
    act(() => {
      socket.fire('agent:turn_complete', { turnId: 'turn-1' });
    });
    await act(async () => {
      await agent.switchConversation('conv-other');
    });
    expect(agent.conversationId).toBe('conv-other');
    expect(agent.messages.map(m => m.content)).toEqual(['Something else']);
    expect(window.sessionStorage.getItem(KEY)).toBe('conv-other');
  });

  it('does not switch while a turn is streaming', async () => {
    mount();
    await act(async () => {
      await agent.sendMessage('hello');
    });
    expect(agent.isStreaming).toBe(true);
    await act(async () => {
      await agent.switchConversation('conv-other');
    });
    expect(getConversation).not.toHaveBeenCalled();
    expect(agent.conversationId).toBe('conv-new');
  });

  it('keeps the current conversation, and says so, when one cannot be opened', async () => {
    window.sessionStorage.setItem(KEY, 'conv-old');
    mount();
    await waitFor(() => expect(agent.conversationId).toBe('conv-old'));
    await act(async () => {
      await agent.switchConversation('conv-deleted');
    });
    expect(agent.conversationId).toBe('conv-old');
    expect(agent.history.error).toBe('That conversation could not be opened.');
  });

  it('starts a new conversation: an empty panel, forgotten by the tab, created by the next message', async () => {
    window.sessionStorage.setItem(KEY, 'conv-old');
    mount();
    await waitFor(() => expect(agent.conversationId).toBe('conv-old'));
    act(() => agent.startNewConversation());
    expect(agent.conversationId).toBeNull();
    expect(agent.messages).toEqual([]);
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    await act(async () => {
      await agent.sendMessage('fresh');
    });
    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(agent.conversationId).toBe('conv-new');
  });

  it('a new conversation started during a restore is not overwritten by it', async () => {
    let release!: () => void;
    getConversation.mockImplementationOnce(
      (id: string) => new Promise(resolve => (release = () => resolve(STORED[id]))),
    );
    window.sessionStorage.setItem(KEY, 'conv-old');
    mount();
    act(() => agent.startNewConversation());
    await act(async () => release());
    expect(agent.conversationId).toBeNull();
    expect(agent.messages).toEqual([]);
  });
});

// ─── Stored messages ─────────────────────────────────────────────────────────

describe('managing conversations', () => {
  const summary = (id: string, over: Record<string, unknown> = {}) => ({
    conversationId: id,
    title: null,
    createdAt: '2026-09-29T10:00:00Z',
    updatedAt: '2026-09-29T10:00:00Z',
    scope: null,
    archivedAt: null,
    ...over,
  });

  it('lists with a filter, keeps it for later refreshes, and queries a page without touching the list', async () => {
    mount();
    await act(async () => {
      await agent.history.refresh({ scopeId: 'proj-1' });
    });
    expect(listConversations).toHaveBeenLastCalledWith({ limit: 20, offset: 0, scopeId: 'proj-1' });
    expect(agent.history.filter).toEqual({ scopeId: 'proj-1' });
    await act(async () => {
      await agent.history.refresh();
    });
    expect(listConversations).toHaveBeenLastCalledWith({ limit: 20, offset: 0, scopeId: 'proj-1' });

    const listed = agent.history.conversations;
    let page: Awaited<ReturnType<typeof agent.history.query>> | undefined;
    await act(async () => {
      page = await agent.history.query({ limit: 50, offset: 50, search: 'intro', status: 'all' });
    });
    expect(listConversations).toHaveBeenLastCalledWith({ limit: 50, offset: 50, search: 'intro', status: 'all' });
    expect(page?.total).toBe(2);
    expect(agent.history.conversations).toBe(listed);
  });

  it('says what the platform lets the user do', () => {
    mount();
    expect(agent.history.manage).toEqual({ rename: false, update: false, remove: false });
    cleanup();
    mount({
      renameConversation: vi.fn(),
      updateConversations: vi.fn(),
      deleteConversations: vi.fn(),
    });
    expect(agent.history.manage).toEqual({ rename: true, update: true, remove: true });
  });

  it('renames in place, and asks the platform to name it with null', async () => {
    const renameConversation = vi.fn(async (id: string, title: string | null) =>
      summary(id, { title: title ?? 'Named by the platform' }),
    );
    mount({ renameConversation });
    await act(async () => {
      await agent.history.refresh();
    });
    const before = agent.history.revision;
    await act(async () => {
      await agent.history.rename('conv-old', 'Intro text');
    });
    expect(agent.history.conversations[0]).toMatchObject({ conversationId: 'conv-old', title: 'Intro text' });
    await act(async () => {
      await agent.history.rename('conv-old', null);
    });
    expect(renameConversation).toHaveBeenLastCalledWith('conv-old', null);
    expect(agent.history.conversations[0].title).toBe('Named by the platform');
    expect(agent.history.revision).toBe(before + 2);
  });

  it('drops archived and refiled conversations the list no longer shows', async () => {
    const updateConversations = vi.fn(async (ids: string[], changes: { archived?: boolean; scopeId?: string | null }) =>
      ids.map(id =>
        summary(id, {
          archivedAt: changes.archived ? '2026-09-30T10:00:00Z' : null,
          scope: changes.scopeId ? { id: changes.scopeId, name: 'Launch' } : null,
        }),
      ),
    );
    mount({ updateConversations });
    await act(async () => {
      await agent.history.refresh();
    });
    await act(async () => {
      await agent.history.update(['conv-old'], { archived: true });
    });
    expect(updateConversations).toHaveBeenCalledWith(['conv-old'], { archived: true });
    expect(agent.history.conversations.map(c => c.conversationId)).toEqual(['conv-other']);
    expect(agent.history.total).toBe(1);

    // Filed in another project while the list shows one project: it leaves the list.
    await act(async () => {
      await agent.history.refresh({ scopeId: null });
    });
    await act(async () => {
      await agent.history.update(['conv-other'], { scopeId: 'proj-2' });
    });
    expect(agent.history.conversations.map(c => c.conversationId)).toEqual(['conv-old']);
  });

  it('deletes, and deleting the open conversation starts a new one; never while it answers', async () => {
    const deleteConversations = vi.fn(async () => undefined);
    window.sessionStorage.setItem(KEY, 'conv-old');
    mount({ deleteConversations });
    await waitFor(() => expect(agent.conversationId).toBe('conv-old'));
    await act(async () => {
      await agent.history.refresh();
    });

    await act(async () => {
      await agent.sendMessage('Make it red');
    });
    expect(agent.isStreaming).toBe(true);
    await expect(agent.history.remove(['conv-old'])).rejects.toThrow('is answering');
    expect(deleteConversations).not.toHaveBeenCalled();

    // Another conversation can go while this one answers.
    await act(async () => {
      await agent.history.remove(['conv-other']);
    });
    expect(agent.history.conversations.map(c => c.conversationId)).toEqual(['conv-old']);
    expect(agent.conversationId).toBe('conv-old');

    act(() => {
      socket.fire(AGENT_SOCKET_EVENTS.TURN_COMPLETE, { turnId: 'turn-1' });
    });
    await waitFor(() => expect(agent.isStreaming).toBe(false));
    await act(async () => {
      await agent.history.remove(['conv-old']);
    });
    expect(deleteConversations).toHaveBeenLastCalledWith(['conv-old']);
    expect(agent.conversationId).toBeNull();
    expect(agent.messages).toEqual([]);
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    expect(agent.history.total).toBe(0);
  });

  it('rejects when the platform cannot do it, and passes on the platform\'s reason', async () => {
    mount({ updateConversations: vi.fn(async () => { throw new Error('2 of the 2 conversations were not found'); }) });
    await expect(agent.history.rename('conv-old', 'x')).rejects.toThrow('cannot rename');
    await expect(agent.history.update(['a', 'b'], { archived: true })).rejects.toThrow('were not found');
    await expect(agent.history.remove(['a'])).rejects.toThrow('cannot delete');
  });
});

describe('storedToAgentMessages', () => {
  it("fills each call's result from the tool message after it, so a choice renders again", () => {
    const messages = storedToAgentMessages([
      {
        id: 'a',
        role: 'assistant',
        content: null,
        toolCalls: [
          { id: 'c1', name: 'canvas_add_text' },
          { id: 'c2', name: 'present_options' },
        ],
        createdAt: '2026-09-29T10:00:00Z',
      },
      { id: 't1', role: 'tool', content: '{"ok":true}', createdAt: '2026-09-29T10:00:01Z' },
      {
        id: 't2',
        role: 'tool',
        content: '{"__present_options":true,"prompt":"Pick","options":[{"label":"A","value":"a"}]}',
        createdAt: '2026-09-29T10:00:01Z',
      },
    ]);
    expect(messages.map(m => m.toolCall?.name)).toEqual(['canvas_add_text', 'present_options']);
    expect(messages[0].toolCall?.result).toEqual({ ok: true });
    expect(messages[1].toolCall?.result).toMatchObject({ __present_options: true, prompt: 'Pick' });
    expect(messages.every(m => m.toolCall?.status === 'complete')).toBe(true);
  });

  it('matches a result by toolCallId when the platform keeps it, and keeps text that is not JSON', () => {
    const messages = storedToAgentMessages([
      {
        id: 'a',
        role: 'assistant',
        content: 'Two things.',
        toolCalls: [
          { id: 'c1', name: 'first' },
          { id: 'c2', name: 'second' },
        ],
        createdAt: '2026-09-29T10:00:00Z',
      },
      { id: 't2', role: 'tool', toolCallId: 'c2', content: 'plain result', createdAt: '2026-09-29T10:00:01Z' },
    ]);
    expect(messages.find(m => m.toolCall?.id === 'c2')?.toolCall?.result).toBe('plain result');
    expect(messages.find(m => m.toolCall?.id === 'c1')?.toolCall?.result).toBeUndefined();
  });

  it('leaves out messages with no text and no calls', () => {
    expect(
      storedToAgentMessages([{ id: 'x', role: 'assistant', content: '', createdAt: '2026-09-29T10:00:00Z' }]),
    ).toEqual([]);
  });
});

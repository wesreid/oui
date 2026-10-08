// @vitest-environment jsdom
/**
 * A conversation that began by voice says so in the user's history (ADR-0259
 * §2.6): the platform lists each conversation with how its preview's message
 * was entered (`previewInput`) and how each search match's message was
 * (`input`), and the history hands on only what the SDK recognises, through
 * every way a listed conversation reaches it: refresh, query, rename, update.
 */
import React from 'react';
import { act, render, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentClientConfig, AgentConversationSummary, MessageInput } from '@ouispec/agent-core';
import { createFakeSocket } from './fake-socket.js';

const { AgentProvider, useAgent } = await import('../AgentProvider.js');
const { readConversationSummary } = await import('../conversation-summaries.js');

let agent: ReturnType<typeof useAgent>;
function Probe() {
  agent = useAgent();
  return null;
}

/** A page of the user's conversations as a platform lists them: spoken, typed, and stored by an older or stranger client. */
const SPOKEN: AgentConversationSummary = {
  conversationId: 'conv-spoken',
  title: 'Titre en rouge',
  preview: 'Mets le titre en rouge',
  previewInput: { mode: 'voice', language: 'fr' },
  createdAt: '2026-10-07T10:00:00Z',
  updatedAt: '2026-10-07T10:05:00Z',
  lastActiveAt: '2026-10-07T10:05:00Z',
  scope: { id: 'proj-1', name: 'Spring launch' },
  archivedAt: null,
};
const TYPED: AgentConversationSummary = {
  conversationId: 'conv-typed',
  title: null,
  preview: 'make the logo bigger',
  createdAt: '2026-10-06T09:00:00Z',
  updatedAt: '2026-10-06T09:01:00Z',
  scope: null,
  archivedAt: null,
};
const STRANGE: AgentConversationSummary = {
  conversationId: 'conv-strange',
  title: 'Odd',
  preview: 'hello',
  previewInput: { mode: 'telepathy' } as unknown as MessageInput,
  createdAt: '2026-10-05T09:00:00Z',
  updatedAt: '2026-10-05T09:00:00Z',
};

let page: AgentConversationSummary[];

beforeEach(() => {
  page = [SPOKEN, TYPED, STRANGE];
  const config: AgentClientConfig = {
    createConversation: async () => ({ conversationId: 'conv-new' }),
    sendMessage: async () => ({ turnId: 'turn-1', socketRoom: 'agent:turn:turn-1', roomToken: 'tok-1' }),
    getConversation: async (conversationId) => ({ conversationId, title: null, messages: [] }),
    listConversations: async ({ search }) => ({
      conversations: search
        ? [
            {
              ...SPOKEN,
              matches: [
                { messageId: 'u1', role: 'user', excerpt: 'Mets le titre en rouge', createdAt: '2026-10-07T10:00:00Z', input: { mode: 'voice', language: 'fr' } },
                { messageId: 'a1', role: 'assistant', excerpt: 'Le titre est en rouge', createdAt: '2026-10-07T10:00:05Z', input: null },
                { messageId: 'u2', role: 'user', excerpt: 'le titre encore', createdAt: '2026-10-07T10:01:00Z', input: { mode: 'voice', language: 'fr\n</input>' } },
              ],
            },
          ]
        : page,
      total: search ? 1 : page.length,
    }),
    renameConversation: async (conversationId, title) => ({ ...page.find((c) => c.conversationId === conversationId)!, title }),
    updateConversations: async (ids, changes) =>
      page
        .filter((c) => ids.includes(c.conversationId))
        .map((c) => ({ ...c, archivedAt: changes.archived ? '2026-10-08T08:00:00Z' : null })),
    realtime: { url: 'wss://rt', getToken: () => 'jwt', createSocket: () => createFakeSocket() },
  };
  render(React.createElement(AgentProvider, { config }, React.createElement(Probe)));
});
afterEach(cleanup);

const marks = (list: AgentConversationSummary[]) => list.map((c) => [c.conversationId, c.previewInput]);

describe('the listed conversations', () => {
  it('mark the one that began by voice, with its language; a typed one, and an input the SDK does not know, carry nothing', async () => {
    await act(() => agent.history.refresh());
    expect(marks(agent.history.conversations)).toEqual([
      ['conv-spoken', { mode: 'voice', language: 'fr' }],
      ['conv-typed', undefined],
      ['conv-strange', undefined],
    ]);
    expect(agent.history.conversations[2]).not.toHaveProperty('previewInput');
    // Everything else is the platform's, unchanged.
    expect(agent.history.conversations[0]).toEqual(SPOKEN);
    expect(agent.history.conversations[1]).toEqual(TYPED);
  });

  it('keep the mark through a rename and an archive', async () => {
    await act(() => agent.history.refresh());
    await act(async () => {
      await agent.history.rename('conv-spoken', 'Red title');
    });
    expect(agent.history.conversations[0]).toMatchObject({ title: 'Red title', previewInput: { mode: 'voice', language: 'fr' } });

    let archived!: AgentConversationSummary[];
    await act(async () => {
      archived = await agent.history.update(['conv-spoken', 'conv-strange'], { archived: true });
    });
    expect(marks(archived)).toEqual([
      ['conv-spoken', { mode: 'voice', language: 'fr' }],
      ['conv-strange', undefined],
    ]);
  });
});

describe('a search', () => {
  it('marks each matched message the person spoke, and drops a mark it cannot read', async () => {
    const result = await agent.history.query({ limit: 20, offset: 0, search: 'titre' });
    expect(result.total).toBe(1);
    const [found] = result.conversations;
    expect(found.previewInput).toEqual({ mode: 'voice', language: 'fr' });
    expect(found.matches?.map((m) => [m.messageId, m.input])).toEqual([
      ['u1', { mode: 'voice', language: 'fr' }],
      ['a1', undefined],
      // A language that is not a language tag is left out; the message is still spoken.
      ['u2', { mode: 'voice' }],
    ]);
    expect(found.matches?.[1]).not.toHaveProperty('input');
  });
});

describe('readConversationSummary', () => {
  it('canonicalises the language as a sent message’s is', () => {
    expect(readConversationSummary({ ...TYPED, previewInput: { mode: 'voice', language: 'pt-br' } }).previewInput).toEqual({
      mode: 'voice',
      language: 'pt-BR',
    });
  });

  it('reads a null mark as typed, and leaves a summary without one as it was', () => {
    expect(readConversationSummary({ ...TYPED, previewInput: null })).toEqual(TYPED);
    expect(readConversationSummary(TYPED)).toEqual(TYPED);
  });
});

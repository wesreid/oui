/**
 * What the model is told, where the host has a say: the rule on text written
 * before a tool call (it is shown and spoken, and nothing clears it), the
 * persona's own rendering of the turn's context, the voice's direction tags on
 * a spoken reply, and the turn every policy hook is told of. The artifact
 * checked is the prompt the model receives, through the real `ai` loop.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildAgentSystemPrompt, getBaseRules, type AgentPersonaConfig } from '../prompt/index.js';
import { spokenReplyText } from '../prompt/spoken-reply.js';
import { runAgentTurn } from '../orchestrator.js';
import { createToolRegistry } from '../tools/types.js';
import type { TurnPolicy } from '../turn-policy.js';
import { respondingOpenAI } from './support/replay.js';

const persona: AgentPersonaConfig = { name: 'Deos', identity: 'You are Deos, the assistant at a car dealership.' };

describe('the rule on text written before a tool call', () => {
  const rules = getBaseRules('Deos');

  it('says what is true: it is shown and spoken, and nothing removes it', () => {
    expect(rules).not.toMatch(/CLEARED|cleared from the user|wiped|treated as preamble/i);
    expect(rules).toContain('That includes text you write BEFORE a tool call. Nothing you write is removed or hidden afterwards.');
    expect(rules).toContain('it is shown in the chat, or spoken aloud on a call');
  });

  it('keeps it to one brief line for the user, or nothing, and never reasoning', () => {
    expect(rules).toContain('before a tool call, write at most one brief line meant for the user ("Let me check that for you."), or nothing at all');
    expect(rules).toContain('Never write your reasoning, plans, guesses, corrections of yourself or notes about the user there');
    expect(rules).toContain('Write your substantive answer once, after the tools you need have returned.');
  });

  it('is in every persona’s prompt', () => {
    expect(buildAgentSystemPrompt(persona)).toContain('Nothing you write is removed or hidden afterwards.');
  });
});

describe('the persona’s own rendering of the turn’s context', () => {
  const context = { userId: 'u1', accountId: 'a1', context: { rooftop: 'Toyota of Quillhaven', oui: { surfaces: [] }, input: { mode: 'voice' } } };

  it('renders the SDK’s page context when the persona has none', () => {
    const prompt = buildAgentSystemPrompt(persona, context);
    expect(prompt).toContain('## CURRENT UI CONTEXT');
    expect(prompt).toContain('"rooftop": "Toyota of Quillhaven"');
  });

  it('replaces it with what the persona renders, given the context without what the client’s UI sent for the worker', () => {
    const renderContext = vi.fn(({ context: c }: { context?: Record<string, unknown> | null }) => `## THE STORE\nYou answer for ${String(c?.rooftop)}.`);
    const prompt = buildAgentSystemPrompt({ ...persona, renderContext }, context);
    expect(prompt).not.toContain('CURRENT UI CONTEXT');
    expect(prompt.endsWith('## THE STORE\nYou answer for Toyota of Quillhaven.')).toBe(true);
    expect(renderContext).toHaveBeenCalledExactlyOnceWith({ userId: 'u1', accountId: 'a1', context: { rooftop: 'Toyota of Quillhaven' } });
  });

  it('renders no section when the persona answers null or blank', () => {
    for (const rendered of [null, '   ']) {
      const prompt = buildAgentSystemPrompt({ ...persona, renderContext: () => rendered }, context);
      expect(prompt).not.toContain('CURRENT UI CONTEXT');
      expect(prompt).not.toContain('Toyota of Quillhaven');
      expect(prompt.trimEnd()).toBe(buildAgentSystemPrompt({ ...persona, renderContext: () => null }).trimEnd());
    }
  });
});

describe('the voice’s direction tags on a spoken reply', () => {
  const voiceDirections = { engine: 'fish-s2', tags: ['[laughs]', '[whispering]'], guidance: 'Use a tag only where a person would, at most one a reply.' };

  it('are offered after the rules for the ear, with the service’s guidance, as tags the voice performs', () => {
    const text = spokenReplyText({ mode: 'voice', voiceDirections });
    expect(text).toContain('Use no markdown, lists, headings, links, code or emoji.');
    expect(text).toContain('The voice that reads your reply (fish-s2) can be directed with these inline tags, written exactly as shown, where they apply: [laughs] [whispering].');
    expect(text).toContain('They are not markdown: the voice performs them and does not read them out. Use no other tags.');
    expect(text.endsWith('Use a tag only where a person would, at most one a reply.</output>')).toBe(true);
    expect(spokenReplyText({ mode: 'voice' })).not.toContain('inline tags');
  });

  it('reach the model after the conversation, never in the cached prefix', async () => {
    const m = respondingOpenAI(() => ({ text: 'Ha, yes we do.' }));
    await runAgentTurn(
      { tools: createToolRegistry([]), emit: { emit: async () => {} }, systemPrompt: 'You help.', model: m.model },
      {
        turnId: 't1',
        conversationId: 'c1',
        userId: 'u1',
        accountId: 'a1',
        socketRoom: 'r',
        content: 'Do you sell trucks?',
        context: { output: { mode: 'voice', voiceDirections } },
      },
    );
    const texts = m.requests[0].messages.map((msg) => (typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)));
    expect(texts.at(-1)).toContain('can be directed with these inline tags');
    expect(texts.slice(0, -1).join('\n')).not.toContain('inline tags');
  });
});

describe('the turn every policy hook is told of', () => {
  it('is the turn’s id, its channel and how its message was entered', async () => {
    const classifyTurn = vi.fn(() => 'browse');
    const prepareStep = vi.fn(async () => ({}));
    const onTurnClassified = vi.fn(async () => {});
    const policy: TurnPolicy = { classifyTurn, prepareStep, onTurnClassified };
    const m = respondingOpenAI(() => ({ text: 'Sure.' }));
    await runAgentTurn(
      { tools: createToolRegistry([]), emit: { emit: async () => {} }, systemPrompt: 'You help.', model: m.model, turnPolicy: policy },
      {
        turnId: 'call-turn-7',
        conversationId: 'c1',
        userId: 'u1',
        accountId: 'a1',
        socketRoom: 'r',
        content: 'I want to talk to someone',
        context: { input: { mode: 'voice', language: 'pt-br' } },
        channel: 'live-call',
      },
    );
    const turn = { id: 'call-turn-7', channel: 'live-call', inputMode: 'voice', language: 'pt-BR', approvalChannel: 'ui' };
    expect(classifyTurn).toHaveBeenCalledWith('I want to talk to someone', [], turn);
    expect(onTurnClassified).toHaveBeenCalledWith(expect.objectContaining({ turnClass: 'browse', turn }));
    expect(prepareStep).toHaveBeenCalledWith(expect.objectContaining({ turnClass: 'browse', turn }));
  });
});

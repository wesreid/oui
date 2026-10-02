/**
 * The knowledge a UI client sends with a turn (`context.uiKnowledge`, oui-bindings'
 * `ResolvedKnowledge`): what its generator emitted for the page the user is on.
 * The SDK renders it into the system prompt after the host's own prompt, so a
 * product gets its generated knowledge to the model without writing any code
 * for it, and the host's prompt (persona or callback) never sees it as context.
 */
import { describe, expect, it } from 'vitest';
import { resolveKnowledge } from '@ouispec/bindings';
import { buildAgentSystemPrompt } from '../prompt/builder.js';
import { CLIENT_KNOWLEDGE_KEY, readClientKnowledge, renderClientKnowledge, withClientKnowledge } from '../ui/knowledge.js';
import { withoutClientUI } from '../ui/snapshot.js';
import { DESK_KNOWLEDGE } from './support/fixture-product.js';

const reportsPage = resolveKnowledge(DESK_KNOWLEDGE, '/reports');
const inboxPage = resolveKnowledge(DESK_KNOWLEDGE, '/inbox');

describe('reading the client knowledge', () => {
  it('is null when the turn carries none (a client with no UI)', () => {
    expect(readClientKnowledge(null)).toBeNull();
    expect(readClientKnowledge({ currentPath: '/inbox' })).toBeNull();
  });

  it('reads what a tab resolves for its page', () => {
    expect(CLIENT_KNOWLEDGE_KEY).toBe('uiKnowledge');
    expect(readClientKnowledge({ uiKnowledge: inboxPage })).toEqual(inboxPage);
  });

  it.each([
    [{ uiKnowledge: 'Inbox' }, 'context.uiKnowledge must be an object'],
    [{ uiKnowledge: { workflows: [] } }, 'context.uiKnowledge.entries must be an array'],
    [{ uiKnowledge: { entries: [] } }, 'context.uiKnowledge.workflows must be an array'],
    [{ uiKnowledge: { entries: [{ title: 'Inbox' }], workflows: [] } }, 'context.uiKnowledge.entries[0] is not a knowledge entry (title, content)'],
    [
      { uiKnowledge: { entries: [], workflows: [{ name: 'Find', trigger: 'asked', steps: 'Go' }] } },
      'context.uiKnowledge.workflows[0] is not a workflow (name, trigger, steps[])',
    ],
  ])('refuses a malformed one, naming where: %j', (context, message) => {
    expect(() => readClientKnowledge(context)).toThrow(message);
  });
});

describe('rendering it', () => {
  it('renders every entry, then every workflow with its numbered steps', () => {
    expect(renderClientKnowledge(inboxPage)).toBe(
      [
        '## Platform Knowledge (Context-Aware)',
        '',
        '### Desk',
        'Pages: Inbox (/inbox), Reports (/reports).',
        '',
        '### Inbox, in full',
        'Lists messages newest first. Reports are on the Reports page.',
        '',
        '### Reports',
        'Saved reports: export one, or email it.',
        '',
        '## Active Workflows',
        '',
        '### Find a report',
        'Trigger: The user asks for a report',
        'Steps:',
        '1. Go to /reports',
        '2. Read the reports observation',
      ].join('\n'),
    );
  });

  it('leaves out the workflows section when the page implies none', () => {
    const text = renderClientKnowledge(reportsPage);
    expect(text).toContain('### Reports, in full');
    expect(text).not.toContain('## Active Workflows');
  });

  it('renders nothing for empty knowledge', () => {
    expect(renderClientKnowledge({ entries: [], workflows: [] })).toBe('');
  });

  it('appends it once to the host prompt, and leaves a prompt alone when the turn carries none', () => {
    expect(withClientKnowledge('You are Desk.', { uiKnowledge: reportsPage })).toBe(`You are Desk.\n\n${renderClientKnowledge(reportsPage)}`);
    expect(withClientKnowledge('You are Desk.', { currentPath: '/reports' })).toBe('You are Desk.');
  });
});

describe("the host's prompt never sees it", () => {
  it('is removed, with the snapshot, from the context a prompt renders', () => {
    expect(withoutClientUI({ currentPath: '/inbox', oui: { surfaces: [] }, uiKnowledge: inboxPage })).toEqual({ currentPath: '/inbox' });
  });

  it('so a persona prompt shows it once, as knowledge, and not as UI context', () => {
    const context = { currentPath: '/inbox', oui: { surfaces: [], observations: {} }, uiKnowledge: inboxPage };
    const prompt = withClientKnowledge(
      buildAgentSystemPrompt({ name: 'Desk', identity: 'You are Desk.' }, { userId: 'ana', accountId: 'desk-1', context: withoutClientUI(context) }),
      context,
    );
    expect(prompt.split('### Inbox, in full').length).toBe(2);
    expect(prompt).toContain('"currentPath": "/inbox"');
    expect(prompt).not.toContain('uiKnowledge');
    expect(prompt.indexOf('## CURRENT UI CONTEXT')).toBeLessThan(prompt.indexOf('## Platform Knowledge'));
  });
});

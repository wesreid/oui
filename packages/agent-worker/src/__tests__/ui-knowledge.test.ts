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
import {
  CLIENT_KNOWLEDGE_KEY,
  KNOWLEDGE_PROMPT_CHARS,
  KNOWLEDGE_TOOL,
  knowledgeTool,
  readClientKnowledge,
  renderClientKnowledge,
  withClientKnowledge,
} from '../ui/knowledge.js';
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

// Session 24611234: the video editor's knowledge was 117,000 characters, most of it one page's
// detail (70,000) and 60 workflows (31,000), sent with every model call of every turn.
describe('knowledge larger than the prompt holds', () => {
  const lines = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => `- ${prefix} ${i}: what it does, and the tool in brackets [${prefix}_${i}]`).join('\n');
  const editor = {
    entries: [
      { title: 'The app’s pages', content: 'Pages: Projects (/media-projects), Editor (/media-projects/:id/editor).' },
      { title: 'Project Editor (/media-projects/:id/editor)', content: `The Project Editor page.\n${lines('action', 900)}` },
      { title: 'Project Editor: how things relate', content: lines('relation', 140) },
      { title: 'Video Studio', content: 'Every video project, and new ones.' },
    ],
    workflows: Array.from({ length: 60 }, (_, i) => ({
      name: `Use the dialog ${i}`,
      trigger: `Anything done in dialog ${i} on Project Editor`,
      steps: [`Open it with dialog_${i}_open.`, `Set what it asks for: ${lines('field', 4)}`, 'Read the page’s state.'],
    })),
  };

  it('fits the prompt’s bound, keeps the small entries whole, cuts the large ones at a line, and says how to read the rest', () => {
    const text = renderClientKnowledge(editor);
    expect(JSON.stringify(editor).length).toBeGreaterThan(90_000);
    expect(text.length).toBeLessThanOrEqual(KNOWLEDGE_PROMPT_CHARS);
    expect(text).toContain('### The app’s pages\nPages: Projects (/media-projects)');
    expect(text).toContain('### Video Studio\nEvery video project, and new ones.');
    expect(text).toMatch(/more characters of "Project Editor \(\/media-projects\/:id\/editor\)" are not shown: `ui_guide` with `entry` set to this title and `from: \d+` reads them/);
    // Cut at a line: no line is shown in part.
    expect(text).not.toMatch(/\[action_\d+$/m);
    // Every workflow by name, none with its steps.
    for (let i = 0; i < 60; i++) expect(text).toContain(`- Use the dialog ${i}\n`.trimEnd());
    expect(text).not.toContain('dialog_0_open');
  });

  it('reads the rest of an entry a page at a time, and a workflow whole, with ui_guide', async () => {
    const guide = knowledgeTool(editor);
    expect(guide.name).toBe(KNOWLEDGE_TOOL);
    expect(guide.effect).toBe('view');
    const text = renderClientKnowledge(editor);
    const from = Number(/from: (\d+)/.exec(text)![1]);
    const title = 'Project Editor (/media-projects/:id/editor)';
    const page = (await guide.execute({ entry: title, from }, {} as never)) as {
      success: boolean;
      data: { text: string; next?: number; total: number };
    };
    expect(page.success).toBe(true);
    expect(page.data.text.startsWith('\n- action') || page.data.text.startsWith('- action')).toBe(true);
    // Read to the end, it is the whole entry: nothing between pages is lost.
    let read = editor.entries[1].content.slice(0, from) + page.data.text;
    let next = page.data.next;
    while (next !== undefined) {
      const more = (await guide.execute({ entry: title, from: next }, {} as never)) as { data: { text: string; next?: number } };
      read += more.data.text;
      next = more.data.next;
    }
    expect(read).toBe(editor.entries[1].content);

    const flow = (await guide.execute({ workflow: 'use the dialog 7' }, {} as never)) as { data: { text: string } };
    expect(flow.data.text).toContain('1. Open it with dialog_7_open.');
    expect(await guide.execute({ workflow: 'No such' }, {} as never)).toMatchObject({
      success: false,
      error: expect.stringContaining('"Use the dialog 0"'),
    });
  });
});

/**
 * A turn's UI actions run one at a time, in the order the model called them.
 *
 * On dev the PA asked, in one response, to fill a document's title, fill its
 * content and press Add. The three tool calls ran concurrently, the press reached
 * the page first, found Add still disabled, and the turn went wrong. UI actions
 * now queue: each is dispatched only after the one before has answered, a failed
 * one does not hold up the rest, and each result shows the page as the actions
 * before it left it.
 */
import { describe, expect, it } from 'vitest';
import type { OUIActionRequest, OUIActionResult, OUISurface } from 'oui-spec/spec';
import type { UIActionChannel } from '../ui/channel.js';
import { buildUITools } from '../ui/ui-tools.js';
import { pageOf } from './support/page.js';
import { createUISequence } from '../ui/ui-sequence.js';
import type { ToolExecutionContext } from '../tools/types.js';

const action = (id: string) => ({ id, description: `do ${id}`, input: { type: 'object', properties: {} } });
const FORM: OUISurface = {
  id: 'page:Form',
  name: 'Form',
  description: 'A form',
  actions: [action('fill_title'), action('fill_content'), action('press_add')],
} as unknown as OUISurface;

/**
 * A page that answers each action after a delay, the first ones slowest, so a
 * concurrent run would answer them out of order. Records every dispatch and
 * answer, in order.
 */
function slowPage(outcome: (actionId: string) => Partial<OUIActionResult> = () => ({})) {
  const log: string[] = [];
  const pending = new Map<string, OUIActionRequest>();
  const delays: Record<string, number> = { fill_title: 30, fill_content: 20, press_add: 1 };
  const channel: UIActionChannel = {
    async dispatch(_room, request) {
      log.push(`dispatch ${request.actionId}`);
      pending.set(request.requestId, request);
    },
    async awaitResult(requestId) {
      const request = pending.get(requestId)!;
      await new Promise(r => setTimeout(r, delays[request.actionId] ?? 1));
      log.push(`answer ${request.actionId}`);
      return {
        requestId,
        success: true,
        surfaces: [FORM],
        ...outcome(request.actionId),
      } as OUIActionResult;
    },
  };
  return { channel, log };
}

const ctx = (id: string) =>
  ({ toolCallId: id, socketRoom: 'agent:turn:t1', userId: 'u1', accountId: 'a1', turnId: 't1' }) as ToolExecutionContext;

function tools(channel: UIActionChannel, sequence = createUISequence()) {
  const built = buildUITools(pageOf([FORM]), {
    channel,
    resultTimeoutMs: 5_000,
    currentPage: () => pageOf([FORM]),
    onResult: () => {},
    sequence,
  });
  return Object.fromEntries(built.tools.map(t => [t.name, t]));
}

describe('UI actions called in one response', () => {
  it('run one at a time, in the order they were called: the press only after both fields are filled', async () => {
    const page = slowPage();
    const t = tools(page.channel);
    // Called together, as the model's tool calls from one response are.
    const results = await Promise.all([
      t.fill_title.execute({ value: 'Hours' }, ctx('c1')),
      t.fill_content.execute({ value: 'Open 9am to 6pm' }, ctx('c2')),
      t.press_add.execute({}, ctx('c3')),
    ]);
    expect(results.map(r => r.success)).toEqual([true, true, true]);
    expect(page.log).toEqual([
      'dispatch fill_title',
      'answer fill_title',
      'dispatch fill_content',
      'answer fill_content',
      'dispatch press_add',
      'answer press_add',
    ]);
  });

  it('a failed action does not hold up the ones after it', async () => {
    const page = slowPage(id =>
      id === 'fill_content' ? { success: false, error: { code: 'INVALID_VALUE', message: 'too long' } } : {},
    );
    const t = tools(page.channel);
    const [title, content, add] = await Promise.all([
      t.fill_title.execute({}, ctx('c1')),
      t.fill_content.execute({}, ctx('c2')),
      t.press_add.execute({}, ctx('c3')),
    ]);
    expect([title.success, content.success, add.success]).toEqual([true, false, true]);
    expect(page.log.at(-1)).toBe('answer press_add');
  });

  it('keeps one order across the UI tools rebuilt during the turn', async () => {
    const page = slowPage();
    const sequence = createUISequence();
    // The page changed: the next tools are built anew, on the same turn's sequence.
    const first = tools(page.channel, sequence);
    const second = tools(page.channel, sequence);
    await Promise.all([
      first.fill_title.execute({}, ctx('c1')),
      second.press_add.execute({}, ctx('c2')),
    ]);
    expect(page.log).toEqual(['dispatch fill_title', 'answer fill_title', 'dispatch press_add', 'answer press_add']);
  });

  it('reports each result against the page the actions before it left', async () => {
    const DETAIL: OUISurface = {
      id: 'page:Detail',
      name: 'Detail',
      description: 'Detail',
      actions: [action('press_add'), action('delete')],
    } as unknown as OUISurface;
    const page = slowPage(id => (id === 'fill_title' ? { surfaces: [DETAIL] } : { surfaces: [DETAIL] }));
    const t = tools(page.channel);
    const [first, second] = await Promise.all([
      t.fill_title.execute({}, ctx('c1')),
      t.press_add.execute({}, ctx('c2')),
    ]);
    // The first action changed the page, and its answer carries the new page's index; the second starts from that page and adds nothing new.
    type Page = { page: { nowOffers?: string; noLongerOnScreen?: string[]; actionsAdded?: string[] } };
    expect((first.data as Page).page.nowOffers).toContain('- delete: ');
    expect((first.data as Page).page.noLongerOnScreen).toEqual(['Form']);
    expect((second.data as Page).page.nowOffers).toBeUndefined();
    expect((second.data as Page).page.actionsAdded).toBeUndefined();
  });
});

/**
 * Every call a turn stores is followed by its own result, and every call the
 * next turn sends the model is too.
 *
 * Found by an eval (nova-api #718): the model called one of the page's actions
 * as if it were a tool (`app_navigate`). No tool ran, so the worker had no
 * result of its own for that call; results were paired with calls by
 * position, every later result moved a call early, and the next turn's
 * history put a result before its call, which the model's SDK refuses
 * (`MissingToolResultsError`).
 */
import { describe, expect, it } from 'vitest';
import type { ModelMessage } from 'ai';
import { historyOf } from '../history.js';
import { convertHistoryToCoreMessages, convertResponseToTurnMessages, MISSING_RESULT } from '../orchestrator.js';
import type { TurnHistoryMessage, TurnMessage } from '../types.js';

const call = (toolCallId: string, toolName: string, input: Record<string, unknown> = {}) => ({ toolCallId, toolName, input });

/** Every tool call is answered before the next message that is not a result, as the model's SDK requires. */
function answeredInPlace(messages: readonly ModelMessage[]) {
  const open = new Set<string>();
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      expect([...open], 'a call was left without its result').toEqual([]);
      for (const part of m.content) if (part.type === 'tool-call') open.add(part.toolCallId);
    } else if (m.role === 'tool') {
      for (const part of m.content) {
        if (part.type !== 'tool-result') continue;
        expect(open.has(part.toolCallId), `the result of ${part.toolCallId} came before its call`).toBe(true);
        open.delete(part.toolCallId);
      }
    } else {
      expect([...open], 'a call was left without its result').toEqual([]);
    }
  }
  expect([...open]).toEqual([]);
}

describe('what a turn stores', () => {
  it('pairs each call with its own result, and stores a call no tool ran with the error the model was given', () => {
    const messages = convertResponseToTurnMessages(
      {
        steps: [
          {
            text: 'Opening it.',
            toolCalls: [call('c1', 'app_navigate', { path: '/lane' }), call('c2', 'ui_act', { action: 'app_navigate', input: { path: '/lane' } })],
            content: [{ type: 'tool-error', toolCallId: 'c1', error: new Error("Model tried to call unavailable tool 'app_navigate'.") }],
          },
          { text: '', toolCalls: [call('c3', 'ui_act', { action: 'lane_view' })] },
          { text: 'Done.', toolCalls: [] },
        ],
      },
      // The worker's own results: none for c1, and in the order the calls finished.
      [
        { toolCallId: 'c3', toolName: 'ui_act', result: '{"success":true,"view":"declined"}' },
        { toolCallId: 'c2', toolName: 'ui_act', result: '{"success":true,"navigatedTo":"/lane"}' },
      ],
    );
    expect(messages.map((m) => [m.role, m.toolCallId ?? m.toolCalls?.map((c) => c.id).join(',') ?? m.content])).toEqual([
      ['assistant', 'c1,c2'],
      ['tool', 'c1'],
      ['tool', 'c2'],
      ['assistant', 'c3'],
      ['tool', 'c3'],
      ['assistant', 'Done.'],
    ]);
    expect(JSON.parse(messages[1].content!)).toEqual({ success: false, notRun: true, error: "Model tried to call unavailable tool 'app_navigate'." });
    expect(messages[1].name).toBe('app_navigate');
    expect(JSON.parse(messages[2].content!)).toMatchObject({ navigatedTo: '/lane' });
    expect(JSON.parse(messages[4].content!)).toMatchObject({ view: 'declined' });

    // The next turn sends them in an order the model's SDK takes.
    const history: TurnHistoryMessage[] = [{ role: 'user', content: 'Show me the declined work' }, ...historyOf(messages), { role: 'user', content: 'yes please' }];
    answeredInPlace(convertHistoryToCoreMessages(history, 'yes please'));
  });

  it('stores a call with no result and no error as not run', () => {
    const [, result] = convertResponseToTurnMessages({ steps: [{ text: '', toolCalls: [call('c1', 'lookup')] }] }, []);
    expect(JSON.parse(result.content!)).toMatchObject({ success: false, notRun: true });
  });
});

describe('a history the store holds out of place', () => {
  // As the worker stored it before results were paired by id: c1 had no result, so c3's moved up into its step.
  const stored: TurnMessage[] = [
    { role: 'assistant', content: 'Opening it.', toolCalls: [{ id: 'c1', name: 'app_navigate', arguments: {} }, { id: 'c2', name: 'ui_act', arguments: {} }] },
    { role: 'tool', content: '{"navigatedTo":"/lane"}', toolCallId: 'c2', name: 'ui_act' },
    { role: 'tool', content: '{"view":"declined"}', toolCallId: 'c3', name: 'ui_act' },
    { role: 'assistant', content: null, toolCalls: [{ id: 'c3', name: 'ui_act', arguments: {} }] },
    { role: 'assistant', content: 'Done.' },
  ];

  it('is sent with every result after its call, and a call with none given one that says so', () => {
    const messages = convertHistoryToCoreMessages([{ role: 'user', content: 'Show me' }, ...historyOf(stored)], 'yes please');
    answeredInPlace(messages);
    const results = messages.flatMap((m) => (m.role === 'tool' ? m.content : [])).map((p) => (p.type === 'tool-result' ? [p.toolCallId, (p.output as { value: string }).value] : []));
    expect(results).toEqual([
      ['c1', MISSING_RESULT],
      ['c2', '{"navigatedTo":"/lane"}'],
      ['c3', '{"view":"declined"}'],
    ]);
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'yes please' });
  });
});

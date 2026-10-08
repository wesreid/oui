/**
 * What a stopped turn stores, built from the worker's own record
 * (ADR-0252 §2.3): every call paired with exactly one result, the last
 * assistant message marked, and never an empty message.
 */
import { describe, expect, it } from 'vitest';
import { turnStoppedNote } from '@ouispec/agent-core';
import { stoppedTurnMessages, type RecordedCall, type RecordedStep } from '../stop/partial.js';
import type { TurnMessage } from '../types.js';

const marker = { reason: 'user_stop', at: 1 } as const;
const call = (id: string, text: string | null, toolName = 'ui_act'): RecordedCall => ({ toolCallId: id, toolName, input: { action: id }, text });
const stepOf = (text: string, ...ids: string[]): RecordedStep => ({
  text,
  toolCalls: ids.map((id) => ({ toolCallId: id, toolName: 'ui_act', input: { action: id } })),
});

/** Every assistant tool call has exactly one result, and no result is an orphan. */
function paired(messages: TurnMessage[]) {
  const calls = messages.flatMap((m) => m.toolCalls ?? []).map((c) => c.id);
  const results = messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId);
  expect([...results].sort()).toEqual([...calls].sort());
  expect(new Set(results).size).toBe(results.length);
}

describe('a stopped turn’s messages', () => {
  it('pairs every call with one result: settled calls keep theirs, an unsettled one is stored as outcome unknown', () => {
    const messages = stoppedTurnMessages({
      steps: [stepOf('First. ', 'a')],
      calls: [call('a', '{"ok":true}'), call('b', '{"stopped":true,"notRun":true}'), call('c', null)],
      streamedText: 'First. Then ',
      marker,
    });
    paired(messages);
    expect(messages.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant', 'tool', 'tool']);
    expect(messages[1]).toMatchObject({ toolCallId: 'a', content: '{"ok":true}' });
    expect(messages[2]).toMatchObject({ content: 'Then ', toolCalls: [{ id: 'b' }, { id: 'c' }], stopped: marker });
    expect(messages[3].content).toBe('{"stopped":true,"notRun":true}');
    expect(JSON.parse(messages[4].content!)).toMatchObject({ stopped: true, outcome: 'unknown' });
    // Only the last assistant message is marked.
    expect(messages.filter((m) => m.stopped)).toHaveLength(1);
  });

  it('marks the last finished step when the turn was between steps', () => {
    const messages = stoppedTurnMessages({ steps: [stepOf('One. ', 'a'), stepOf('Two.')], calls: [call('a', '{}')], streamedText: 'One. Two.', marker });
    expect(messages.map((m) => m.content)).toEqual(['One. ', '{}', 'Two.']);
    expect(messages[2].stopped).toEqual(marker);
    expect(messages[0].stopped).toBeUndefined();
  });

  it('stores one message carrying the marker’s line for a turn that produced nothing', () => {
    for (const streamedText of ['', ' \n']) {
      expect(stoppedTurnMessages({ steps: [], calls: [], streamedText, marker })).toEqual([
        { role: 'assistant', content: turnStoppedNote(marker), stopped: marker },
      ]);
    }
  });

  it('stores nothing for a turn a take-over stopped before it produced anything: the take-over is already in the conversation (ADR-0260 §2.3)', () => {
    const takenOver = { reason: 'taken_over', at: 2 } as const;
    expect(stoppedTurnMessages({ steps: [], calls: [], streamedText: '', marker: takenOver })).toEqual([]);
    // What it had produced is kept and marked, as for any stop.
    const kept = stoppedTurnMessages({ steps: [], calls: [], streamedText: 'Let me check.', marker: takenOver });
    expect(kept).toEqual([{ role: 'assistant', content: 'Let me check.', stopped: takenOver }]);
  });

  it('drops a step whose text was empty and which made no call, and never stores an empty message', () => {
    const messages = stoppedTurnMessages({ steps: [stepOf(''), stepOf('Said.')], calls: [], streamedText: 'Said.', marker });
    expect(messages).toEqual([{ role: 'assistant', content: 'Said.', stopped: marker }]);
    for (const m of messages) expect(m.content === null ? (m.toolCalls?.length ?? 0) > 0 : m.content.trim() !== '').toBe(true);
  });

  it('stores a message that is only its calls with no text at all, not an empty one', () => {
    const messages = stoppedTurnMessages({ steps: [], calls: [call('a', '{}')], streamedText: '', marker });
    expect(messages[0]).toEqual({ role: 'assistant', content: null, toolCalls: [{ id: 'a', name: 'ui_act', arguments: { action: 'a' } }], stopped: marker });
    paired(messages);
  });

  it('does not mistake text it has not read yet for the step in flight', () => {
    // The step's end was seen before all of its text was read from the stream.
    const messages = stoppedTurnMessages({ steps: [stepOf('All of it.')], calls: [], streamedText: 'All of', marker });
    expect(messages).toEqual([{ role: 'assistant', content: 'All of it.', stopped: marker }]);
  });
});

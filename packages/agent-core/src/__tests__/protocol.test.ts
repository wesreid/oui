import { describe, it, expect } from 'vitest';
import { AGENT_SOCKET_EVENTS, ALL_AGENT_SOCKET_EVENTS, parseSocketEvent } from '../protocol/index.js';
import { TURN_END_REASONS, isTurnEndReason } from '../protocol/index.js';
import { TURN_STOP_REASONS, TURN_STOPPED_REASONS, isTurnStopReason, isTurnStoppedReason, turnStoppedNote } from '../turns/index.js';

describe('Agent Protocol', () => {
  it('TURN_ERROR should be in AGENT_SOCKET_EVENTS', () => {
    expect(AGENT_SOCKET_EVENTS.TURN_ERROR).toBe('agent:turn_error');
  });

  it('TURN_ERROR should be included in ALL_AGENT_SOCKET_EVENTS', () => {
    expect(ALL_AGENT_SOCKET_EVENTS).toContain('agent:turn_error');
  });

  it('parseSocketEvent should map agent:turn_error to an error event', () => {
    const result = parseSocketEvent('agent:turn_error', {
      turnId: 'turn-123',
      error: { code: 'RATE_LIMIT', message: 'Bedrock rate limit exceeded', recoverable: true },
    }, 'fallback-turn');

    expect(result).not.toBeNull();
    expect(result!.type).toBe('error');
    const errEvent = result as { type: 'error'; code: string; message: string; recoverable: boolean };
    expect(errEvent.code).toBe('RATE_LIMIT');
    expect(errEvent.message).toBe('Bedrock rate limit exceeded');
    expect(errEvent.recoverable).toBe(true);
  });

  it('parseSocketEvent should handle agent:turn_error with minimal payload', () => {
    const result = parseSocketEvent('agent:turn_error', { turnId: 'turn-456' }, 'fallback');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('error');
  });

  it('every AGENT_SOCKET_EVENTS member should have a parseSocketEvent handler (no unintentional null)', () => {
    // TURN_STARTED deliberately maps to null — assert it explicitly
    const turnStarted = parseSocketEvent(AGENT_SOCKET_EVENTS.TURN_STARTED, { turnId: 't' }, 't');
    expect(turnStarted).toBeNull(); // deliberate

    // Every other event MUST map to a non-null protocol event
    const nonNullEvents = ALL_AGENT_SOCKET_EVENTS.filter(e => e !== AGENT_SOCKET_EVENTS.TURN_STARTED);
    for (const eventName of nonNullEvents) {
      const result = parseSocketEvent(eventName, { turnId: 'test-turn', text: 'test', name: 'test_tool', toolUseId: 'tc1', reasoningId: 'r1', step: 0, calledTools: false, final: true }, 'fallback');
      expect(result, `parseSocketEvent('${eventName}', ...) returned null — missing handler`).not.toBeNull();
    }
  });
});

describe('a stopped turn', () => {
  it('reads why a turn was stopped from its completion', () => {
    for (const stopReason of ['user_stop', 'superseded'] as const) {
      expect(parseSocketEvent('agent:turn_complete', { turnId: 't1', stopReason }, 'fallback')).toEqual({
        type: 'done',
        turnId: 't1',
        messageId: undefined,
        usage: undefined,
        stopReason,
      });
    }
  });

  it('says nothing of stopping for a turn that ended by itself, or for a reason it does not know', () => {
    expect(parseSocketEvent('agent:turn_complete', { turnId: 't1' }, 'fallback')).not.toHaveProperty('stopReason');
    expect(parseSocketEvent('agent:turn_complete', { turnId: 't1', stopReason: 'complete' }, 'fallback')).not.toHaveProperty(
      'stopReason',
    );
  });

  it('gives a stopped message a line of text to carry, never an empty one', () => {
    expect(turnStoppedNote({ reason: 'user_stop' })).toMatch(/person stopped this turn/);
    expect(turnStoppedNote({ reason: 'superseded' })).toMatch(/sent a new message/);
    for (const reason of TURN_STOP_REASONS) expect(turnStoppedNote({ reason }).trim()).not.toBe('');
    expect(isTurnStopReason('user_stop')).toBe(true);
    expect(isTurnStopReason('deadline')).toBe(false);
    // Nobody asks for a deadline stop; a turn that ran out of time ends on the stop path with that reason.
    expect(isTurnStoppedReason('deadline')).toBe(true);
    expect(TURN_STOPPED_REASONS).toEqual(['user_stop', 'superseded', 'deadline']);
    expect(turnStoppedNote({ reason: 'deadline' })).toMatch(/ran out of time/);
  });
});

describe("the model's thinking", () => {
  it('reads the start, each piece of the summary, and the end of a thinking block', () => {
    expect(parseSocketEvent(AGENT_SOCKET_EVENTS.REASONING_STARTED, { turnId: 't1', reasoningId: 'r1' }, 'f')).toEqual({
      type: 'reasoning',
      phase: 'start',
      id: 'r1',
      turnId: 't1',
    });
    expect(parseSocketEvent(AGENT_SOCKET_EVENTS.REASONING_DELTA, { turnId: 't1', reasoningId: 'r1', text: 'Laying out' }, 'f')).toEqual({
      type: 'reasoning',
      phase: 'delta',
      id: 'r1',
      text: 'Laying out',
      turnId: 't1',
    });
    expect(parseSocketEvent(AGENT_SOCKET_EVENTS.REASONING_ENDED, { reasoningId: 'r1' }, 'fallback')).toEqual({
      type: 'reasoning',
      phase: 'end',
      id: 'r1',
      turnId: 'fallback',
    });
  });

  it('drops a block event without its id, and a piece without text', () => {
    expect(parseSocketEvent(AGENT_SOCKET_EVENTS.REASONING_STARTED, { turnId: 't1' }, 'f')).toBeNull();
    expect(parseSocketEvent(AGENT_SOCKET_EVENTS.REASONING_DELTA, { turnId: 't1', reasoningId: 'r1', text: '' }, 'f')).toBeNull();
    expect(parseSocketEvent(AGENT_SOCKET_EVENTS.REASONING_DELTA, { turnId: 't1', reasoningId: 'r1' }, 'f')).toBeNull();
  });
});

describe('how a turn ended', () => {
  it('reads every end reason the worker sends', () => {
    for (const endReason of TURN_END_REASONS) {
      expect(parseSocketEvent(AGENT_SOCKET_EVENTS.TURN_COMPLETE, { turnId: 't1', endReason }, 'f')).toMatchObject({ type: 'done', endReason });
    }
  });

  it('says nothing for a reason it does not know, or a worker that does not say', () => {
    expect(parseSocketEvent(AGENT_SOCKET_EVENTS.TURN_COMPLETE, { turnId: 't1', endReason: 'mystery' }, 'f')).not.toHaveProperty('endReason');
    expect(parseSocketEvent(AGENT_SOCKET_EVENTS.TURN_COMPLETE, { turnId: 't1' }, 'f')).not.toHaveProperty('endReason');
    expect(isTurnEndReason('output_limit')).toBe(true);
    expect(isTurnEndReason('user_stop')).toBe(false);
  });
});

describe('the rounds of a turn', () => {
  it('reads which round a piece of text belongs to', () => {
    expect(parseSocketEvent(AGENT_SOCKET_EVENTS.TOKEN, { turnId: 't', text: 'Checking.', step: 2 }, 'f')).toEqual({
      type: 'token',
      content: 'Checking.',
      turnId: 't',
      step: 2,
    });
    // A worker that does not say, or says something that is not a round, gives no step.
    for (const step of [undefined, -1, 1.5, '2']) {
      expect(parseSocketEvent(AGENT_SOCKET_EVENTS.TOKEN, { turnId: 't', text: 'Hi', step }, 'f')).toEqual({ type: 'token', content: 'Hi', turnId: 't' });
    }
  });

  it('reads a round’s end: whether it called tools, and whether it is the turn’s last word', () => {
    expect(parseSocketEvent(AGENT_SOCKET_EVENTS.ROUND_END, { turnId: 't', step: 0, calledTools: true, final: false, timestamp: 1 }, 'f')).toEqual({
      type: 'round_end',
      step: 0,
      calledTools: true,
      final: false,
      turnId: 't',
    });
    expect(AGENT_SOCKET_EVENTS.ROUND_END).toBe('agent:round_end');
    expect(ALL_AGENT_SOCKET_EVENTS).toContain('agent:round_end');
  });

  it('drops a round’s end that does not say all three', () => {
    expect(parseSocketEvent(AGENT_SOCKET_EVENTS.ROUND_END, { turnId: 't', calledTools: true, final: false }, 'f')).toBeNull();
    expect(parseSocketEvent(AGENT_SOCKET_EVENTS.ROUND_END, { turnId: 't', step: 0, final: false }, 'f')).toBeNull();
    expect(parseSocketEvent(AGENT_SOCKET_EVENTS.ROUND_END, { turnId: 't', step: 0, calledTools: 'yes', final: true }, 'f')).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import { AGENT_SOCKET_EVENTS, ALL_AGENT_SOCKET_EVENTS, parseSocketEvent } from '../protocol/index.js';
import { TURN_STOP_REASONS, TURN_STOPPED_REASONS, isTurnStopReason, isTurnStoppedReason, turnStoppedNote } from '../turns/index.js';

describe('Agent Protocol (W1.T2 — D2 fix)', () => {
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
      const result = parseSocketEvent(eventName, { turnId: 'test-turn', text: 'test', name: 'test_tool', toolUseId: 'tc1' }, 'fallback');
      expect(result, `parseSocketEvent('${eventName}', ...) returned null — missing handler`).not.toBeNull();
    }
  });
});

describe('a stopped turn (ADR-0252)', () => {
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

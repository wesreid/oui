/**
 * A conversation's events (ADR-0260 §2.4): declared by the platform, to the
 * conversation's room each host names, with payloads the contract defines.
 */
import { describe, expect, it } from 'vitest';
import { AGENT_CONVERSATION_EVENTS, CONVERSATION_ROOM, PLATFORM_EVENTS, createEventCatalog, type EventDeclarationDocument } from '../index.js';
import { createPayloadValidator } from '../validate.js';

const catalog = createEventCatalog(PLATFORM_EVENTS);
const validator = createPayloadValidator(catalog);
const jordan = { userId: 'staff-17', displayName: 'Jordan', role: 'Toyota of Quillhaven sales' };
const hold = { conversationId: 'c-1', holder: jordan, since: 1_791_000_000_000 };

describe("the platform's conversation events", () => {
  it('are declared as notices to the conversation room, correlated by conversation', () => {
    for (const name of Object.values(AGENT_CONVERSATION_EVENTS)) {
      const event = catalog.require(name, 'this test');
      expect(event.role).toBe('notice');
      expect(event.rooms).toEqual([{ name: CONVERSATION_ROOM, pattern: null }]);
      expect(event.correlation).toEqual(['conversationId']);
      // A room each host names: any room it gives.
      expect(catalog.allowsRoom(name, 'deos:conversation:c-1')).toBe(true);
    }
  });

  it('accept the payloads the contract defines, and refuse others', () => {
    expect(validator.problems(AGENT_CONVERSATION_EVENTS.TAKEN_OVER, { conversationId: 'c-1', hold, at: 1 })).toEqual([]);
    expect(validator.problems(AGENT_CONVERSATION_EVENTS.HANDED_BACK, { conversationId: 'c-1', hold, by: 'product', at: 2 })).toEqual([]);
    const message = { id: 'm-1', role: 'staff', content: 'Jordan here.', createdAt: '2026-10-08T15:00:00.000Z', speaker: jordan };
    expect(validator.problems(AGENT_CONVERSATION_EVENTS.MESSAGE, { conversationId: 'c-1', message, at: 3 })).toEqual([]);

    expect(validator.problems(AGENT_CONVERSATION_EVENTS.TAKEN_OVER, { conversationId: 'c-1', at: 1 }).length).toBeGreaterThan(0);
    expect(validator.problems(AGENT_CONVERSATION_EVENTS.HANDED_BACK, { conversationId: 'c-1', hold, by: 'robot', at: 2 }).length).toBeGreaterThan(0);
    const unnamed = { ...message, speaker: { userId: 'staff-17' } };
    expect(validator.problems(AGENT_CONVERSATION_EVENTS.MESSAGE, { conversationId: 'c-1', message: unnamed, at: 3 }).length).toBeGreaterThan(0);
  });

  it('a turn can end because the conversation was taken over', () => {
    expect(validator.problems('agent:turn_complete', { turnId: 't-1', stopReason: 'taken_over', timestamp: 1 })).toEqual([]);
    expect(validator.problems('agent:turn_complete', { turnId: 't-1', stopReason: 'gone', timestamp: 1 }).length).toBeGreaterThan(0);
  });

  it("reserves the conversation's room name: a product cannot declare a room called conversation", () => {
    const product: EventDeclarationDocument = {
      version: 1,
      product: 'desk',
      rooms: { conversation: { pattern: 'desk:conversation:{conversationId}' } },
      events: {},
    };
    expect(() => createEventCatalog(PLATFORM_EVENTS, product)).toThrow(
      "desk: rooms/conversation is reserved for the agent conversation's room, which each host names",
    );
  });
});

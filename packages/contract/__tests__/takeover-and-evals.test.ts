/**
 * ADR-0260's two schemas: the takeover messages the realtime server, the
 * worker, the product's API and both tabs exchange, and the eval suite a
 * product writes. Each accepts what the ADR specifies and refuses what it
 * forbids, and the integrator guide documents both.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { AgentEvalSuite, ConversationTakenOverEvent, TakeOverRequest } from '../src/index.js';
import { contractProblems } from '../src/validate.js';

const jordan = { userId: 'staff-17', displayName: 'Jordan', role: 'Toyota of Quillhaven sales' };

describe('conversation-takeover.json', () => {
  it('accepts a take-over request, the hold and the three events', () => {
    const request: TakeOverRequest = { holder: jordan, rooms: ['deos:conversation:c-1'] };
    expect(contractProblems('TakeOverRequest', request)).toEqual([]);
    const hold = { conversationId: 'c-1', holder: jordan, since: 1_791_000_000_000 };
    const taken: ConversationTakenOverEvent = { conversationId: 'c-1', hold, at: 1_791_000_000_001 };
    expect(contractProblems('ConversationTakenOverEvent', taken)).toEqual([]);
    expect(contractProblems('ConversationHandedBackEvent', { conversationId: 'c-1', hold, by: 'holder', at: 1 })).toEqual([]);
    expect(
      contractProblems('ConversationMessageEvent', {
        conversationId: 'c-1',
        message: { id: 'm-9', role: 'staff', content: 'Hi, Jordan here.', createdAt: '2026-10-08T15:00:00.000Z', speaker: jordan },
        at: 2,
      }),
    ).toEqual([]);
    expect(contractProblems('HandBackResult', { ok: true, change: 'handed_back', hold, by: 'product' })).toEqual([]);
    expect(contractProblems('TakeOverResult', { ok: false, reason: 'held', hold })).toEqual([]);
  });

  it('refuses a holder with no name, a request with no rooms, and a role it does not know', () => {
    expect(contractProblems('TakeOverRequest', { holder: { userId: 'staff-17' }, rooms: ['r'] }).join(' ')).toMatch(/displayName/);
    expect(contractProblems('TakeOverRequest', { holder: jordan, rooms: [] }).length).toBeGreaterThan(0);
    expect(
      contractProblems('ConversationMessage', { id: 'm', role: 'system', content: 'x', createdAt: '2026-10-08T00:00:00Z' }).join(' '),
    ).toMatch(/must be one of "user", "assistant", "staff"/);
    expect(contractProblems('StaffSpeaker', { ...jordan, displayName: 'x'.repeat(81) }).length).toBeGreaterThan(0);
  });
});

describe('agent-evals.json', () => {
  const suite: AgentEvalSuite = {
    version: 1,
    name: 'dealer',
    channels: ['web_chat', 'sms'],
    stubs: { inventory_search: [{ when: { stock: 'T2417' }, result: { success: true, data: { price: 31995 } } }] },
    scenarios: [
      {
        id: 'price-only',
        title: 'Quotes the dealer price and no payments',
        turns: [
          {
            user: 'Is T2417 still available?',
            expect: {
              says: ['31,995'],
              mustNotSay: [{ pattern: 'per month|APR', flags: 'i' }, { rubric: 'quotes a monthly payment' }],
              toolCalled: [{ name: 'inventory_search', args: { stock: 'T2417' } }],
              toolNotCalled: ['book_service'],
              approvalRequested: false,
              doesNotStore: ['123-45-6789'],
            },
            expectOn: { sms: { mustNotSay: ['**'] } },
          },
          { approval: 'approve', expect: { toolCalled: [{ name: 'book_service' }] } },
          { staff: { takeOver: { displayName: 'Jordan', role: 'Sales' } } },
          { staff: { say: 'Jordan here: $500 off today.' } },
          { user: 'Thanks', expect: { held: true } },
          { staff: { handBack: true } },
          { user: 'Can I book Saturday?', expect: { approvalRequested: { tool: 'book_service', readback: 'Saturday' }, refusal: true } },
        ],
      },
    ],
  };

  it('accepts a suite with every kind of turn and assertion', () => {
    expect(contractProblems('agent-evals.json', suite)).toEqual([]);
  });

  it('refuses an unknown assertion, a turn that is no kind of turn, a bad flag and an empty suite', () => {
    const turn = suite.scenarios[0].turns[0];
    const withUnknown = { ...suite, scenarios: [{ ...suite.scenarios[0], turns: [{ ...turn, expect: { sayz: ['x'] } }] }] };
    expect(contractProblems('agent-evals.json', withUnknown).join(' ')).toMatch(/sayz/);
    const noKind = { ...suite, scenarios: [{ ...suite.scenarios[0], turns: [{ assistant: 'hi' }] }] };
    expect(contractProblems('agent-evals.json', noKind).length).toBeGreaterThan(0);
    const badFlag = { ...suite, scenarios: [{ ...suite.scenarios[0], turns: [{ user: 'x', expect: { says: [{ pattern: 'x', flags: 'g' }] } }] }] };
    expect(contractProblems('agent-evals.json', badFlag).length).toBeGreaterThan(0);
    expect(contractProblems('agent-evals.json', { ...suite, scenarios: [] }).length).toBeGreaterThan(0);
    expect(contractProblems('agent-evals.json', { ...suite, version: 2 }).length).toBeGreaterThan(0);
  });
});

describe('the integrator guide', () => {
  it('documents taking a conversation over and the evals, with their schemas', () => {
    const guide = readFileSync(join(__dirname, '..', 'INTEGRATOR-GUIDE.md'), 'utf8');
    expect(guide).toContain('## Staff take over a conversation, and hand it back');
    expect(guide).toContain('## Evals: one scenario set, every channel, in CI');
    expect(guide).toContain('> **Schema:** [`conversation-takeover.json#/$defs/TakeOverRequest`]');
    expect(guide).toContain('> **Schema:** [`agent-evals.json`]');
  });
});

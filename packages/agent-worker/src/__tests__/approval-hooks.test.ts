/**
 * The host's say before an approval is asked for, through the real `ai`
 * loop: a check that refuses a call before it is read back, and a display
 * copy that redacts and localises what is stored, shown and spoken, while the
 * call that runs and its args hash stay the model's. Only the model and the
 * approval store are stand-ins; what the store is given is the artifact.
 */
import { describe, expect, it, vi } from 'vitest';
import { AGENT_SOCKET_EVENTS, argsHash, type ApprovalPreview, type ApprovalRequiredEvent, type PendingApprovalInput } from '@ouispec/agent-core';
import { runAgentTurn } from '../orchestrator.js';
import { createToolRegistry, type RegisteredTool } from '../tools/types.js';
import type { ApprovalStoreClient } from '../approvals/client.js';
import type { ApprovalHooks, ApprovalPreviewContext, ApprovalHookContext } from '../approvals/hooks.js';
import { readHostPreview, readValidation } from '../approvals/hooks.js';
import type { AgentTurnInput } from '../types.js';
import { respondingOpenAI, type ChatRequest, type ScriptedReply } from './support/replay.js';

const ARGS = { day: '2026-10-28', time: '13:30', phone: '+17184070052' };

function bookTool(execute = vi.fn(async () => ({ success: true }))): RegisteredTool {
  return {
    name: 'visit_book',
    title: 'Book this visit with the sales team',
    description: 'Books a visit.',
    effect: { kind: 'transaction' },
    inputSchema: {
      type: 'object',
      properties: { day: { type: 'string', title: 'Day' }, time: { type: 'string', title: 'Time' }, phone: { type: 'string', title: 'Phone' } },
    },
    execute,
  };
}

/** The approval store, keeping what it is given. */
function recordingStore() {
  const created: PendingApprovalInput[] = [];
  const store: ApprovalStoreClient = {
    create: async (input) => void created.push(structuredClone(input)),
    redeem: async () => ({ ok: false, reason: 'used', error: 'used' }),
    status: async () => null,
  };
  return { store, created };
}

/** The host's display copy: the phone number redacted, a Spanish readback, and one written for a voice. */
const SPANISH: ApprovalPreview = {
  title: 'Reservar esta visita con el equipo de ventas',
  arguments: [
    { name: 'day', label: 'Día', value: 'martes 28 de octubre' },
    { name: 'time', label: 'Hora', value: '13:30' },
    { name: 'phone', label: 'Teléfono', value: '••• ••• 0052' },
  ],
  readback: 'Reservar una visita el martes 28 de octubre a las 13:30. Teléfono terminado en 0052.',
  spokenReadback: 'Reservar una visita el martes veintiocho de octubre a la una y media. Teléfono terminado en cero cero cinco dos.',
};

const SPOKEN_SPANISH: Partial<AgentTurnInput> = { context: { input: { mode: 'voice', language: 'es' } }, channel: 'live-call' };

async function turnWith(replies: ScriptedReply[], hooks: ApprovalHooks, tools: RegisteredTool[], input: Partial<AgentTurnInput> = {}) {
  const m = respondingOpenAI((_request, i) => replies[i]);
  const { store, created } = recordingStore();
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const result = await runAgentTurn(
    {
      tools: createToolRegistry(tools),
      emit: { emit: async (_room, event, data) => void events.push({ event, data: data as Record<string, unknown> }) },
      systemPrompt: 'You book visits.',
      model: m.model,
      approvals: store,
      approvalHooks: hooks,
    },
    { turnId: 'turn-book', conversationId: 'c1', userId: 'ana', accountId: 'acct-1', socketRoom: 'agent:turn:turn-book', content: 'Book me in', ...input },
  );
  const approval = events.find((e) => e.event === AGENT_SOCKET_EVENTS.APPROVAL_REQUIRED)?.data as unknown as ApprovalRequiredEvent | undefined;
  return { result, created, approval, events, requests: m.requests };
}

/** What the model read as the result of the call `id`. */
function resultOf(requests: ChatRequest[], id: string): Record<string, unknown> | null {
  for (const r of requests) {
    const m = r.messages.find((msg) => msg.role === 'tool' && msg.tool_call_id === id);
    if (m) return JSON.parse(String(m.content)) as Record<string, unknown>;
  }
  return null;
}

const callBook = (id = 'call_book', args: Record<string, unknown> = ARGS): ScriptedReply => ({ toolCalls: [{ id, name: 'visit_book', args }] });

describe('the host’s display copy of an approval', () => {
  it('is what is stored, sent to the room and read back, while the stored call and its hash are the model’s own', async () => {
    const preview = vi.fn(async (_tool: RegisteredTool, _args: Record<string, unknown>, _ctx: ApprovalPreviewContext) => SPANISH);
    const { created, approval, result } = await turnWith([callBook()], { preview }, [bookTool()], SPOKEN_SPANISH);

    expect(result.stopReason).toBe('awaiting_approval');
    expect(created).toHaveLength(1);
    const [stored] = created;
    // The call that will run, exactly as the model made it, and bound to its own arguments.
    expect(stored.args).toEqual(ARGS);
    expect(stored.argsHash).toBe(await argsHash(ARGS));
    // The words are the host's.
    expect(stored.preview).toEqual(SPANISH);
    expect(approval?.preview).toEqual(SPANISH);
    expect(JSON.stringify(approval)).not.toContain('+17184070052');
    expect(JSON.stringify(stored.preview)).not.toContain('+17184070052');
  });

  it('is written knowing the turn, the person’s language and the preview the declaration gives', async () => {
    const preview = vi.fn(async () => SPANISH);
    await turnWith([callBook()], { preview }, [bookTool()], SPOKEN_SPANISH);
    expect(preview).toHaveBeenCalledOnce();
    const [tool, args, ctx] = preview.mock.calls[0] as unknown as [RegisteredTool, Record<string, unknown>, ApprovalPreviewContext];
    expect(tool.name).toBe('visit_book');
    expect(args).toEqual(ARGS);
    expect(ctx).toMatchObject({
      turn: { id: 'turn-book', channel: 'live-call', inputMode: 'voice', language: 'es' },
      channel: 'live-call',
      locale: 'es',
      userId: 'ana',
      accountId: 'acct-1',
      conversationId: 'c1',
    });
    expect(ctx.built.readback).toBe('Book this visit with the sales team: Day 2026-10-28, Time 13:30, Phone +17184070052. Books a visit.');
  });

  it('has no locale for a typed message', async () => {
    const preview = vi.fn(async (_t: RegisteredTool, _a: Record<string, unknown>, ctx: ApprovalPreviewContext) => ctx.built);
    await turnWith([callBook()], { preview }, [bookTool()]);
    expect((preview.mock.calls[0][2] as ApprovalPreviewContext).locale).toBeNull();
    expect((preview.mock.calls[0][2] as ApprovalPreviewContext).turn).toEqual({ id: 'turn-book', channel: 'direct', inputMode: 'text', language: null });
  });

  it('that throws, or is not a preview, means the approval is not asked for: nothing is stored or shown, and the call does not run', async () => {
    for (const preview of [
      async () => {
        throw new Error('translation service down');
      },
      async () => ({ title: 'Reservar', arguments: [] }) as unknown as ApprovalPreview,
      async () => ({ ...SPANISH, voice: 'nova' }) as unknown as ApprovalPreview,
    ]) {
      const execute = vi.fn(async () => ({ success: true }));
      const { created, approval, result, requests } = await turnWith([callBook(), { text: 'I could not book it.' }], { preview }, [bookTool(execute)]);
      expect(created).toEqual([]);
      expect(approval).toBeUndefined();
      expect(execute).not.toHaveBeenCalled();
      expect(result.stopReason).toBe('complete');
      expect(resultOf(requests, 'call_book')).toMatchObject({ notRun: true, error: expect.stringContaining('its preview could not be written') });
      // The SDK's own copy, with the number the host would have redacted, is never the fallback.
      expect(JSON.stringify(requests)).not.toContain('Phone +17184070052');
    }
  });
});

describe('the host’s check before an approval', () => {
  it('refuses a call before it is read back: the model gets the reason as the call’s error, and nothing is stored or shown', async () => {
    const validateBeforeApproval = vi.fn(async (_tool: RegisteredTool, args: Record<string, unknown>) =>
      args.time === '13:30' ? { ok: false as const, error: '13:30 is not a time the store offered. Offer 14:00 or 15:30.' } : { ok: true as const },
    );
    const { created, approval, result, requests, events } = await turnWith(
      [callBook(), callBook('call_book_2', { ...ARGS, time: '14:00' })],
      { validateBeforeApproval },
      [bookTool()],
      SPOKEN_SPANISH,
    );
    expect(resultOf(requests, 'call_book')).toMatchObject({
      success: false,
      notRun: true,
      refusedBeforeApproval: true,
      error: '13:30 is not a time the store offered. Offer 14:00 or 15:30.',
    });
    // The model corrected the call, and that one was asked for.
    expect(created.map((c) => c.args)).toEqual([{ ...ARGS, time: '14:00' }]);
    expect(approval?.approvalId).toBe('call_book_2');
    expect(result.stopReason).toBe('awaiting_approval');
    // The refused call reached the room as a call that failed, as every refused call does.
    expect(events.filter((e) => e.event === AGENT_SOCKET_EVENTS.TOOL_CALL_COMPLETE && e.data.toolUseId === 'call_book')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ success: false }) }),
    ]);
    const ctx = validateBeforeApproval.mock.calls[0][2] as unknown as ApprovalHookContext;
    expect(ctx).toMatchObject({ channel: 'live-call', locale: 'es', turn: { id: 'turn-book', inputMode: 'voice' } });
  });

  it('that throws refuses the call', async () => {
    const execute = vi.fn(async () => ({ success: true }));
    const { created, requests } = await turnWith(
      [callBook(), { text: 'Sorry.' }],
      {
        validateBeforeApproval: async () => {
          throw new Error('calendar unreachable');
        },
      },
      [bookTool(execute)],
    );
    expect(created).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    expect(resultOf(requests, 'call_book')).toMatchObject({ notRun: true, error: 'It could not be checked, so it was not asked for.' });
  });

  it('keeps one approval per turn: a second call in the same response waits for the first’s check, and runs as first if it is refused', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const validateBeforeApproval = vi.fn(async (_tool: RegisteredTool, args: Record<string, unknown>) => {
      if (args.time === '13:30') {
        await gate;
        return { ok: false as const, error: 'Not offered.' };
      }
      return { ok: true as const };
    });
    setTimeout(release, 50);
    const both: ScriptedReply = {
      toolCalls: [
        { id: 'call_a', name: 'visit_book', args: ARGS },
        { id: 'call_b', name: 'visit_book', args: { ...ARGS, time: '15:30' } },
      ],
    };
    const { created, result } = await turnWith([both], { validateBeforeApproval }, [bookTool()]);
    const stored = (id: string, r: typeof result) => JSON.parse(r.newMessages.find((msg) => msg.role === 'tool' && msg.toolCallId === id)!.content!) as Record<string, unknown>;
    expect(created.map((c) => c.approvalId)).toEqual(['call_b']);
    expect(stored('call_a', result)).toMatchObject({ notRun: true, refusedBeforeApproval: true, error: 'Not offered.' });
    expect(stored('call_b', result)).toMatchObject({ awaitingApproval: true, approvalId: 'call_b' });

    // Both pass: the first is asked for, and the second is not run.
    const passing = await turnWith([both], { validateBeforeApproval: async () => ({ ok: true }) }, [bookTool()]);
    expect(passing.created.map((c) => c.approvalId)).toEqual(['call_a']);
    expect(stored('call_b', passing.result)).toMatchObject({ notRun: true, error: expect.stringContaining("waiting for the user's approval") });
  });
});

describe('reading what a host’s hook answered', () => {
  it('holds a validation to its two shapes, and anything else to a refusal', () => {
    expect(readValidation({ ok: true })).toEqual({ ok: true });
    expect(readValidation({ ok: false, error: '  Not offered.  ' })).toEqual({ ok: false, error: 'Not offered.' });
    for (const odd of [null, undefined, true, { ok: false }, { ok: false, error: ' ' }, { ok: 'yes' }]) {
      expect(readValidation(odd)).toEqual({ ok: false, error: 'It could not be checked, so it was not asked for.' });
    }
    expect((readValidation({ ok: false, error: 'x'.repeat(5_000) }) as { error: string }).error).toHaveLength(2_000);
  });

  it('holds a preview to what the approval store accepts', () => {
    expect(readHostPreview(SPANISH)).toEqual({ ok: true, preview: SPANISH });
    const { spokenReadback: _s, ...withoutSpoken } = SPANISH;
    expect(readHostPreview(withoutSpoken)).toEqual({ ok: true, preview: withoutSpoken });
    for (const [bad, problem] of [
      [null, 'it is not an object'],
      [{ ...SPANISH, title: ' ' }, 'title is blank'],
      [{ ...SPANISH, readback: 7 }, 'readback must be a string'],
      [{ ...SPANISH, spokenReadback: '' }, 'spokenReadback is blank'],
      [{ ...SPANISH, title: 't'.repeat(501) }, 'title is longer than 500 characters'],
      [{ ...SPANISH, arguments: 'none' }, 'arguments must be a list'],
      [{ ...SPANISH, arguments: [{ name: 'day', label: '', value: 'x' }] }, 'arguments[0].label must be 1–500 characters'],
      [{ ...SPANISH, extra: 1 }, 'it has fields a preview does not: extra'],
    ] as const) {
      expect(readHostPreview(bad)).toEqual({ ok: false, error: problem });
    }
  });
});

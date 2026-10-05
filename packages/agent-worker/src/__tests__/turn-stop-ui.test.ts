/**
 * A UI action that is out when its turn is stopped (ADR-0252 §2.2).
 *
 * The page may already be running it. The worker looks once more for its
 * answer, on the stop's own signal: an answer is stored as the call's result,
 * so the next turn does not do it again; none is stored as "sent; outcome
 * unknown" and the page is marked unseen. A request no tab took, and an
 * action that had not been sent yet, did not run. Every request names its
 * turn, so a tab that has moved on refuses it.
 */
import { describe, expect, it } from 'vitest';
import type { OUIActionRequest, OUIActionResult, OUISurface } from 'oui-spec/spec';
import { buildUITools, createPageSight } from '../ui/ui-tools.js';
import { createUISequence } from '../ui/ui-sequence.js';
import type { UIActionChannel, UIDispatchReceipt } from '../ui/channel.js';
import type { ToolExecutionContext } from '../tools/types.js';
import { TurnStopped, stopOf, type TurnStopState } from '../stop/turn-stop.js';
import { pageOf } from './support/page.js';

const surfaces: OUISurface[] = [
  {
    id: 'draft',
    name: 'Draft',
    description: 'The draft',
    actions: [
      { id: 'draft_rename', description: 'Rename the draft', input: { type: 'object', properties: { title: { type: 'string' } } } },
      { id: 'draft_delete', description: 'Delete the draft', input: { type: 'object', properties: {} } },
    ],
    observations: [],
  } as unknown as OUISurface,
];

const answer = (requestId: string): OUIActionResult => ({ requestId, success: true, data: { renamed: true }, timestamp: 1 });

/** A page whose answers the test hands over, and a turn the test stops. */
function setup(receipt: UIDispatchReceipt | null = { acknowledged: 1, accepted: 1 }) {
  const controller = new AbortController();
  const dispatched: OUIActionRequest[] = [];
  const kept = new Map<string, OUIActionResult>();
  const waits: Array<{ requestId: string; signal?: AbortSignal; final?: boolean }> = [];
  const channel: UIActionChannel = {
    dispatch: async (_room, request) => (dispatched.push(request), receipt),
    awaitResult: async (requestId, { timeoutMs, signal, final }) => {
      waits.push({ requestId, signal, final });
      const until = Date.now() + timeoutMs;
      while (!kept.has(requestId) && Date.now() < until && !signal?.aborted) await new Promise((r) => setTimeout(r, 5));
      return kept.get(requestId) ?? null;
    },
  };
  let grace: AbortSignal | null = null;
  const stop: TurnStopState = {
    reason: () => stopOf(controller.signal)?.reason ?? null,
    graceSignal: () => (grace ??= AbortSignal.timeout(200)),
    graceMs: 60,
  };
  const sight = createPageSight();
  const sequence = createUISequence();
  const page = pageOf(surfaces);
  const { tools, read } = buildUITools(page, { channel, resultTimeoutMs: 5_000, currentPage: () => page, sequence, sight, onResult: () => {} });
  const ctx = (toolCallId: string): ToolExecutionContext => ({
    userId: 'u1',
    accountId: 'a1',
    turnId: 'turn-7',
    conversationId: 'c1',
    toolCallId,
    socketRoom: 'agent:turn:turn-7',
    abortSignal: controller.signal,
    stop,
    uiSlot: sequence.reserve(),
  });
  const tool = (name: string) => tools.find((t) => t.name === name)!;
  return {
    dispatched,
    kept,
    waits,
    sight,
    read,
    tool,
    ctx,
    stopTurn: () => controller.abort(new TurnStopped('user_stop', Date.now())),
    turnSignal: controller.signal,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe('a UI action out when its turn is stopped', () => {
  it('names its turn on every request', async () => {
    const page = setup();
    const running = page.tool('draft_rename').execute({ title: 'A' }, page.ctx('call-1'));
    await settle();
    page.kept.set('call-1', answer('call-1'));
    await running;
    expect(page.dispatched[0]).toMatchObject({ requestId: 'call-1', turnId: 'turn-7' });

    const reading = page.read.execute({ surface: 'draft', observation: 'x' }, page.ctx('call-read'));
    await settle();
    page.kept.set('call-read', { ...answer('call-read'), data: {} });
    await reading;
    expect(page.dispatched[1]).toMatchObject({ requestId: 'call-read', turnId: 'turn-7' });
  });

  it('stores the answer when it arrives within the grace: the action ran, and the next turn must not redo it', async () => {
    const page = setup();
    const running = page.tool('draft_rename').execute({ title: 'A' }, page.ctx('call-1'));
    await settle();
    page.stopTurn();
    // The page was already running it, and answers a moment after the stop.
    setTimeout(() => page.kept.set('call-1', answer('call-1')), 25);

    const result = await running;
    expect(result).toMatchObject({ success: true });
    expect(JSON.stringify(result)).toContain('renamed');
    // The last look used the stop's own signal: the turn's was already aborted.
    const last = page.waits[page.waits.length - 1];
    expect(page.turnSignal.aborted).toBe(true);
    expect(last.signal).not.toBe(page.turnSignal);
    expect(last.signal?.aborted).toBe(false);
    // The page answered, so it can still be seen.
    expect(page.sight.refuseChange()).toBeNull();
  });

  it('stores "sent; outcome unknown" when no answer comes, and marks the page unseen', async () => {
    const page = setup();
    const running = page.tool('draft_rename').execute({ title: 'A' }, page.ctx('call-1'));
    await settle();
    page.stopTurn();

    const result = await running;
    expect(result).toMatchObject({ success: false, data: { stopped: true, sent: true, outcome: 'unknown' } });
    expect(result.error).toMatch(/may have run/);
    // The next change is refused until the page is read.
    expect(page.sight.refuseChange()).not.toBeNull();
  });

  it('stores "not run" when the tabs received the request and none took it: a tab that has moved on refuses a late request', async () => {
    const page = setup({ acknowledged: 1, accepted: 0 });
    const running = page.tool('draft_rename').execute({ title: 'A' }, page.ctx('call-1'));
    await settle();
    page.stopTurn();

    const result = await running;
    expect(result).toMatchObject({ success: false, data: { stopped: true, notRun: true } });
    // It did not run, so the page is as it was seen.
    expect(page.sight.refuseChange()).toBeNull();
  });

  it('never sends an action that was waiting its place in the order: it is stored as not run, and its place is given up', async () => {
    const page = setup();
    const first = page.tool('draft_rename').execute({ title: 'A' }, page.ctx('call-1'));
    const second = page.tool('draft_delete').execute({}, page.ctx('call-2'));
    await settle();
    expect(page.dispatched.map((r) => r.requestId)).toEqual(['call-1']);
    page.stopTurn();

    expect(await first).toMatchObject({ data: { stopped: true, outcome: 'unknown' } });
    expect(await second).toMatchObject({ success: false, data: { stopped: true, notRun: true } });
    // The delete never reached the page.
    expect(page.dispatched.map((r) => r.actionId)).toEqual(['draft_rename']);
  });

  it('does not wait on a job the action started: the job goes on, and the call reads as still running', async () => {
    const page = setup();
    const running = page.tool('draft_rename').execute({ title: 'A' }, page.ctx('call-1'));
    await settle();
    // The page acknowledged: the work was started and outlives the call.
    page.kept.set('call-1', { ...answer('call-1'), interim: true, data: { status: 'started' } });
    await settle();
    page.stopTurn();

    const result = await running;
    expect(result).toMatchObject({ success: true, data: { status: 'running' } });
  });

  it('asks the page nothing more once stopped: a read is not sent', async () => {
    const page = setup();
    page.stopTurn();
    const result = await page.read.execute({ surface: 'draft', observation: 'x' }, page.ctx('call-read'));
    expect(result).toMatchObject({ success: false, data: { stopped: true, notRun: true } });
    expect(page.dispatched).toEqual([]);
  });
});

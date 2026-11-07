/**
 * The provider's decision to resume after work (resume-after-work.ts): which settlements start a turn
 * by themselves, gathered how, and bounded how.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RESUME_GATHER_MS, RESUME_MAX_IN_A_ROW, RESUME_MAX_REQUESTS, type SettledWork } from '@ouispec/agent-core';
import { createWorkResumer, type TabResumeState } from '../resume-after-work.js';

const idle: TabResumeState = {
  conversationId: 'conv-1',
  turnBusy: false,
  loading: false,
  approvalWaiting: false,
  choiceWaiting: false,
  heldByStaff: false,
};

const work = (requestId: string, turnId: string | null = 'turn-1', success = true): SettledWork => ({
  requestId,
  ...(turnId ? { turnId } : {}),
  surfaceId: 'room:image-studio',
  actionId: 'image_studio_variants_across_backgrounds',
  success,
  at: Date.now(),
});

function setup(state: Partial<TabResumeState> = {}) {
  const tab = { ...idle, ...state };
  const resume = vi.fn();
  const log = vi.fn();
  const resumer = createWorkResumer({ state: () => tab, resume, log });
  const logged = () => log.mock.calls.map((c) => c[0] as string);
  return { tab, resume, log, logged, resumer };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('resuming after work', () => {
  it('resumes for work of an ended turn of the open conversation, once the work has gathered', () => {
    const { resume, logged, resumer } = setup();
    resumer.turnStarted('turn-1', 'conv-1');
    resumer.turnEnded('turn-1', { kind: 'ended', reason: 'complete' });
    resumer.settled(work('call_1'));
    vi.advanceTimersByTime(RESUME_GATHER_MS - 1);
    expect(resume).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(resume).toHaveBeenCalledExactlyOnceWith(['call_1']);
    expect(logged().at(-1)).toMatch(/Resuming after work/);
  });

  it.each([
    ['handed back for time', { kind: 'ended', reason: 'time_limit' }],
    ['failed', { kind: 'failed' }],
    ['ran out of time', { kind: 'stopped', reason: 'deadline' }],
    ['asked a choice the person has since answered or dismissed', { kind: 'ended', reason: 'present_options' }],
  ] as const)('resumes for a turn that %s', (_name, end) => {
    const { resume, resumer } = setup();
    resumer.turnStarted('turn-1', 'conv-1');
    resumer.turnEnded('turn-1', end);
    resumer.settled(work('call_1', 'turn-1', false));
    vi.advanceTimersByTime(RESUME_GATHER_MS);
    expect(resume).toHaveBeenCalledExactlyOnceWith(['call_1']);
  });

  it.each([
    ['the person stopped', { kind: 'stopped', reason: 'user_stop' }, /the person stopped/],
    ['a newer message superseded', { kind: 'stopped', reason: 'superseded' }, /newer message superseded/],
    ['a person on the staff took over', { kind: 'stopped', reason: 'taken_over' }, /took the conversation over/],
    ['ended waiting for approval', { kind: 'ended', reason: 'awaiting_approval' }, /waiting for the person's approval/],
  ] as const)('does not resume for a turn %s, and says why', (_name, end, why) => {
    const { resume, logged, resumer } = setup();
    resumer.turnStarted('turn-1', 'conv-1');
    resumer.turnEnded('turn-1', end);
    resumer.settled(work('call_1'));
    vi.advanceTimersByTime(RESUME_GATHER_MS);
    expect(resume).not.toHaveBeenCalled();
    expect(logged()).toEqual([expect.stringMatching(why)]);
  });

  it.each([
    ['a turn runs or starts', { turnBusy: true }, /a turn is running or starting/],
    ['a conversation loads', { loading: true }, /a conversation is loading/],
    ['an approval card waits', { approvalWaiting: true }, /approval card waits/],
    ['a choice waits', { choiceWaiting: true }, /a choice waits/],
    ['a person on the staff holds the conversation', { heldByStaff: true }, /staff holds/],
  ] as const)('does not resume while %s', (_name, state, why) => {
    const { resume, logged, resumer } = setup(state);
    resumer.turnStarted('turn-1', 'conv-1');
    resumer.turnEnded('turn-1', { kind: 'ended', reason: 'complete' });
    resumer.settled(work('call_1'));
    vi.advanceTimersByTime(RESUME_GATHER_MS);
    expect(resume).not.toHaveBeenCalled();
    expect(logged()).toEqual([expect.stringMatching(why)]);
  });

  it('does not resume for a turn still running, one it never ran, one that named no turn, or one of another conversation', () => {
    const { tab, resume, logged, resumer } = setup();
    resumer.turnStarted('turn-1', 'conv-1');
    resumer.settled(work('call_running'));
    resumer.settled(work('call_other_tab', 'turn-9'));
    resumer.settled(work('call_no_turn', null));
    resumer.turnEnded('turn-1', { kind: 'ended' });
    tab.conversationId = 'conv-2';
    resumer.settled(work('call_elsewhere'));
    vi.advanceTimersByTime(RESUME_GATHER_MS);
    expect(resume).not.toHaveBeenCalled();
    expect(logged()).toEqual([
      expect.stringMatching(/has not ended/),
      expect.stringMatching(/not started by a turn this tab ran/),
      expect.stringMatching(/named no turn/),
      expect.stringMatching(/not started by a turn this tab ran in the open conversation/),
    ]);
  });

  it('forgets the turns, the gathered work and the count when the conversation changes', () => {
    const { tab, resume, logged, resumer } = setup();
    resumer.turnStarted('turn-1', 'conv-1');
    resumer.turnEnded('turn-1', { kind: 'ended' });
    resumer.settled(work('call_1'));
    resumer.conversationChanged();
    vi.advanceTimersByTime(RESUME_GATHER_MS);
    expect(resume).not.toHaveBeenCalled();
    expect(logged().at(-1)).toMatch(/the open conversation changed/);
    // Back in the same conversation: its earlier turns are not known any more.
    tab.conversationId = 'conv-1';
    resumer.settled(work('call_2'));
    vi.advanceTimersByTime(RESUME_GATHER_MS);
    expect(resume).not.toHaveBeenCalled();
  });

  it('gathers work that ends close together into one turn, each request once', () => {
    const { resume, resumer } = setup();
    resumer.turnStarted('turn-1', 'conv-1');
    resumer.turnStarted('turn-2', 'conv-1');
    resumer.turnEnded('turn-1', { kind: 'ended' });
    resumer.turnEnded('turn-2', { kind: 'ended', reason: 'time_limit' });
    resumer.settled(work('call_1', 'turn-1'));
    vi.advanceTimersByTime(RESUME_GATHER_MS - 100);
    resumer.settled(work('call_2', 'turn-2'));
    resumer.settled(work('call_2', 'turn-2'));
    vi.advanceTimersByTime(RESUME_GATHER_MS - 1);
    expect(resume).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(resume).toHaveBeenCalledExactlyOnceWith(['call_1', 'call_2']);
  });

  it('starts at once with a full turn of requests', () => {
    const { resume, resumer } = setup();
    resumer.turnStarted('turn-1', 'conv-1');
    resumer.turnEnded('turn-1', { kind: 'ended' });
    for (let i = 0; i < RESUME_MAX_REQUESTS; i++) resumer.settled(work(`call_${i}`));
    expect(resume).toHaveBeenCalledOnce();
    expect(resume.mock.calls[0][0]).toHaveLength(RESUME_MAX_REQUESTS);
  });

  it('judges the gathered work again when the turn would start: a turn begun meanwhile carries it', () => {
    const { tab, resume, logged, resumer } = setup();
    resumer.turnStarted('turn-1', 'conv-1');
    resumer.turnEnded('turn-1', { kind: 'ended' });
    resumer.settled(work('call_1'));
    tab.turnBusy = true;
    vi.advanceTimersByTime(RESUME_GATHER_MS);
    expect(resume).not.toHaveBeenCalled();
    expect(logged().at(-1)).toMatch(/a turn is running or starting/);
  });

  it(`resumes at most ${RESUME_MAX_IN_A_ROW} turns in a row, and counts again once the person writes`, () => {
    const { resume, logged, resumer } = setup();
    const round = (n: number) => {
      const turnId = `turn-${n}`;
      resumer.turnStarted(turnId, 'conv-1');
      resumer.turnEnded(turnId, { kind: 'ended' });
      resumer.settled(work(`call_${n}`, turnId));
      vi.advanceTimersByTime(RESUME_GATHER_MS);
    };
    for (let n = 1; n <= RESUME_MAX_IN_A_ROW + 1; n++) round(n);
    expect(resume).toHaveBeenCalledTimes(RESUME_MAX_IN_A_ROW);
    expect(logged().at(-1)).toMatch(/3 turns were already resumed in a row without a message from the person/);

    resumer.personWrote();
    round(10);
    expect(resume).toHaveBeenCalledTimes(RESUME_MAX_IN_A_ROW + 1);
  });

  it('keeps the first end recorded: a completion after the person’s stop does not make the turn resumable', () => {
    const { resume, resumer } = setup();
    resumer.turnStarted('turn-1', 'conv-1');
    resumer.turnEnded('turn-1', { kind: 'stopped', reason: 'user_stop' });
    resumer.turnEnded('turn-1', { kind: 'ended', reason: 'complete' });
    resumer.settled(work('call_1'));
    vi.advanceTimersByTime(RESUME_GATHER_MS);
    expect(resume).not.toHaveBeenCalled();
  });

  it('drops what it gathered when the tab stops listening', () => {
    const { resume, resumer } = setup();
    resumer.turnStarted('turn-1', 'conv-1');
    resumer.turnEnded('turn-1', { kind: 'ended' });
    resumer.settled(work('call_1'));
    resumer.dispose();
    vi.advanceTimersByTime(RESUME_GATHER_MS);
    expect(resume).not.toHaveBeenCalled();
  });
});

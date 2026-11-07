/**
 * `ui_wait`: the model waits, at its choice, for work an action started that was still running when the action's
 * call answered, and hears its outcome in the same turn.
 *
 * Found on dev (2026-11-06): the PA started a 60 s image job in the Image Studio ("Variants Across Backgrounds"). The
 * call answered "running" after its 20 s wait, the PA had no way to wait longer, so it ended its turn asking the
 * person to tell it when the job was done, and nothing told it: a job's end starts no turn. With `ui_wait` it waits
 * for the outcome (bounded by the time the turn must answer, and the action's own limit) and goes on with it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OUIAction, OUIActionResult, OUISurface } from "oui-spec/spec";

import { buildUITools, UI_WAIT_TOOL } from "../ui/ui-tools.js";
import { createStepClock } from "../time-hand-back.js";
import type { ToolExecutionContext } from "../tools/types.js";
import type { UIActionChannel } from "../ui/channel.js";
import { pageOf } from "./support/page.js";

const variants: OUIAction = {
  id: "image_studio_variants_across_backgrounds",
  description: "Places one subject on each of several backgrounds",
  input: { type: "object", properties: {} },
  async: true,
  polling: { intervalMs: 1000, maxDurationMs: 360_000 },
};
const select: OUIAction = { ...variants, id: "image_studio_select_subject", description: "Selects the subject" };
const surface: OUISurface = {
  id: "room:image-studio",
  name: "Image Studio",
  description: "a layered picture editor",
  actions: [variants, select],
};

const started = (requestId: string, jobId: string): OUIActionResult => ({
  requestId,
  success: true,
  interim: true,
  data: { status: "started", jobId },
  timestamp: 1,
});
const complete = (requestId: string, jobId: string): OUIActionResult => ({
  requestId,
  success: true,
  interim: false,
  data: { status: "complete", jobId, made: [{ background: "beach", group: "g1" }], failed: [] },
  observations: { "room:image-studio": { document: { layers: [{ id: "g1", name: "Ruth in beach", kind: "group" }] } } },
  timestamp: 2,
});

/**
 * A page whose actions start jobs: each request's job ends `jobMs[requestId]` after it was sent, or never. A final
 * answer arrives when the job ends within the wait, as the realtime service's long poll gives it; null when not.
 */
function jobPage(jobMs: Record<string, number>) {
  const sentAt = new Map<string, number>();
  const jobIdOf = (requestId: string) => `local:${requestId}`;
  const awaitResult = vi.fn(
    (requestId: string, opts: { final?: boolean; timeoutMs: number; signal?: AbortSignal }) =>
      new Promise<OUIActionResult | null>((resolve) => {
        if (!opts.final) return resolve(started(requestId, jobIdOf(requestId)));
        const endsAt = (sentAt.get(requestId) ?? 0) + (jobMs[requestId] ?? Infinity);
        const wait = Math.max(0, endsAt - Date.now());
        const timer = setTimeout(
          () => resolve(wait <= opts.timeoutMs ? complete(requestId, jobIdOf(requestId)) : null),
          Math.min(wait, opts.timeoutMs),
        );
        opts.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve(null);
        });
      }),
  );
  const dispatch = vi.fn(async (_room: string, request: { requestId: string }) => {
    if (!sentAt.has(request.requestId)) sentAt.set(request.requestId, Date.now());
  });
  return { channel: { dispatch, awaitResult } satisfies UIActionChannel, jobIdOf };
}

const ctxOf = (toolCallId: string, extra: Partial<ToolExecutionContext> = {}): ToolExecutionContext => ({
  userId: "u1",
  accountId: "a1",
  turnId: "t1",
  conversationId: "c1",
  toolCallId,
  socketRoom: "agent:turn:t1",
  ...extra,
});

function tools(channel: UIActionChannel, waitDeadline?: () => number) {
  const page = pageOf([surface]);
  const built = buildUITools(page, {
    channel,
    resultTimeoutMs: 1000,
    currentPage: () => page,
    onResult: () => {},
    ...(waitDeadline ? { waitDeadline } : {}),
  });
  const act = (id: string, callId: string) => built.tools.find((t) => t.name === id)!.execute({}, ctxOf(callId));
  const wait = (input: Record<string, unknown> = {}, extra: Partial<ToolExecutionContext> = {}) =>
    built.wait.execute(input, ctxOf(`wait-${Math.random()}`, extra));
  return { built, act, wait };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("ui_wait", () => {
  it("is a tool of its own, that changes nothing on the page", () => {
    const { built } = tools(jobPage({}).channel);
    expect(built.wait).toMatchObject({ name: UI_WAIT_TOOL, kind: "ui", effect: "view" });
    expect(UI_WAIT_TOOL).toBe("ui_wait");
  });

  it("the dev case: a 60 s job reported running at 20 s is waited for, and its outcome and the page after it are the answer", async () => {
    const { channel, jobIdOf } = jobPage({ "call-1": 60_000 });
    const turnStart = Date.now();
    const { act, wait } = tools(channel, () => turnStart + 195_000);

    const running = act(variants.id, "call-1");
    await vi.advanceTimersByTimeAsync(20_000);
    const first = await running;
    // The call's answer says it is running, and how to wait for it.
    expect(first.data).toMatchObject({ status: "running", result: { status: "started", jobId: jobIdOf("call-1") } });
    expect(String((first.data as { note: string }).note)).toMatch(/not done/);
    expect(String((first.data as { note: string }).note)).toMatch(/ui_wait/);
    expect(String((first.data as { note: string }).note)).toMatch(/If it finishes after this turn, you are brought back to report it in this chat/);

    const waiting = wait({ jobId: jobIdOf("call-1") });
    let settled = false;
    void waiting.finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(39_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const outcome = await waiting;
    expect(outcome).toMatchObject({
      success: true,
      data: {
        action: variants.id,
        jobId: jobIdOf("call-1"),
        result: { status: "complete", made: [{ background: "beach", group: "g1" }] },
        state: expect.anything(),
      },
    });
    expect((outcome.data as Record<string, unknown>).status).toBeUndefined();
    // It waited on the call's own final answer, up to when the turn must answer.
    const finalWait = channel.awaitResult.mock.calls.at(-1)!;
    expect(finalWait[0]).toBe("call-1");
    expect(finalWait[1]).toMatchObject({ final: true, userId: "u1" });
    expect(finalWait[1].timeoutMs).toBe(175_000);

    // Settled work is not waited for again.
    expect(await wait({ jobId: jobIdOf("call-1") })).toMatchObject({ success: false, error: expect.stringMatching(/Nothing this turn started is still running/) });
  });

  it("reports work still running, never done, when the turn must answer first", async () => {
    const { channel } = jobPage({ "call-1": 600_000 });
    const turnStart = Date.now();
    const { act, wait } = tools(channel, () => turnStart + 100_000);
    const running = act(variants.id, "call-1");
    await vi.advanceTimersByTimeAsync(20_000);
    await running;
    const waiting = wait();
    await vi.advanceTimersByTimeAsync(80_000);
    const result = await waiting;
    expect(result).toMatchObject({ success: true, data: { action: variants.id, status: "running" } });
    expect(String((result.data as { note: string }).note)).toMatch(/the turn must answer now/);
    expect(String((result.data as { note: string }).note)).toMatch(/never say it is done/);
    // And it can still be waited for, by a later call in the same turn.
    expect(await wait({ action: variants.id }, { abortSignal: AbortSignal.abort() })).toMatchObject({ success: true, data: { status: "running" } });
  });

  it("waits no longer than the action's own limit", async () => {
    const quick: OUIAction = { ...variants, polling: { intervalMs: 1000, maxDurationMs: 30_000 } };
    const page = pageOf([{ ...surface, actions: [quick] }]);
    const { channel } = jobPage({ "call-1": 600_000 });
    const built = buildUITools(page, { channel, resultTimeoutMs: 1000, currentPage: () => page, onResult: () => {}, waitDeadline: () => Date.now() + 200_000 });
    const running = built.tools[0].execute({}, ctxOf("call-1"));
    await vi.advanceTimersByTimeAsync(20_000);
    await running;
    const waiting = built.wait.execute({}, ctxOf("w1"));
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await waiting;
    expect(channel.awaitResult.mock.calls.at(-1)![1].timeoutMs).toBe(10_000);
    expect(String((result.data as { note: string }).note)).toMatch(/passed its own limit/);
  });

  it("finds the work by job id, by action, or the work started last; and says what is running when it names none of it", async () => {
    const { channel, jobIdOf } = jobPage({ "call-1": 25_000, "call-2": 30_000 });
    const { act, wait } = tools(channel, () => Date.now() + 200_000);
    const first = act(variants.id, "call-1");
    await vi.advanceTimersByTimeAsync(20_000);
    await first;
    const second = act(select.id, "call-2");
    await vi.advanceTimersByTimeAsync(20_000);
    await second;

    expect(await wait({ jobId: "local:nope" })).toMatchObject({
      success: false,
      error: expect.stringMatching(/as job "local:nope".*What is: image_studio_variants_across_backgrounds \(job local:call-1\), image_studio_select_subject \(job local:call-2\)/),
    });
    // call-1 ended at 25 s, before the wait: its stored final answer is the outcome.
    const byAction = wait({ action: variants.id });
    await vi.advanceTimersByTimeAsync(0);
    expect(await byAction).toMatchObject({ success: true, data: { jobId: jobIdOf("call-1"), result: { status: "complete" } } });
    // With neither, the work started last.
    const last = wait();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await last).toMatchObject({ success: true, data: { action: select.id, result: { status: "complete" } } });
    expect(await wait()).toMatchObject({ success: false, error: expect.stringMatching(/Nothing this turn started is still running\. Work that ended in its own call/) });
  });

  it("ends when the turn is stopped, and says the work may still be running", async () => {
    const { channel } = jobPage({ "call-1": 600_000 });
    const { act, wait } = tools(channel, () => Date.now() + 200_000);
    const running = act(variants.id, "call-1");
    await vi.advanceTimersByTimeAsync(20_000);
    await running;
    const abort = new AbortController();
    let reason: string | null = null;
    const stop = { reason: () => reason, graceMs: 0, graceSignal: () => abort.signal } as unknown as ToolExecutionContext["stop"];
    const waiting = wait({}, { abortSignal: abort.signal, stop });
    await vi.advanceTimersByTimeAsync(5_000);
    reason = "user_stop";
    abort.abort();
    const result = await waiting;
    expect(result).toMatchObject({ success: false, data: { stopped: true, status: "unknown" } });
    expect(result.error).toMatch(/stopped while waiting for "image_studio_variants_across_backgrounds"/);
  });
});

describe("the turn's step clock and ui_wait", () => {
  it("does not count a wait the model chose as a step's length, so one long wait does not end the turn early", () => {
    const start = 1_000_000;
    const clock = createStepClock({ deadlineAt: start + 240_000, turnDeadlineMs: 240_000 });
    clock.stepStarting(start);
    // A step that waited 70 s for a job, and took 5 s otherwise.
    clock.waited(70_000);
    const next = clock.stepStarting(start + 75_000);
    expect(next.longestStepMs).toBe(5_000);
    expect(next.handBack).toBe(false);
    // A step's own calls still count.
    const after = clock.stepStarting(start + 150_000);
    expect(after.longestStepMs).toBe(75_000);
    expect(after.handBack).toBe(true);
  });
});

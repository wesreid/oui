/**
 * A UI action that starts work (a GPU job, an export) is answered twice: acknowledged, then finished. The
 * tool waits a short while for the finished answer, so work that ends quickly is reported done in the same
 * call. It waits no longer than `jobWaitMs` (20 s by default), the action's own limit, or the time the turn
 * must answer, whichever is first: work still going then is reported still running, never done, and the
 * turn goes on and ends. Its outcome reaches the conversation through the page state of a later turn.
 */
import { describe, expect, it, vi } from "vitest";
import type { OUIAction, OUIActionResult, OUISurface } from "oui-spec/spec";

import { buildUITools, DEFAULT_JOB_WAIT_MS } from "../ui/ui-tools.js";
import { pageOf } from "./support/page.js";
import type { UIActionChannel } from "../ui/channel.js";

const generate: OUIAction = {
  id: "clips_generate",
  description: "Generate the clip",
  input: { type: "object", properties: {} },
  async: true,
  polling: { intervalMs: 1000, maxDurationMs: 300_000 },
};
const rename: OUIAction = {
  id: "clips_name",
  description: "Name the clip",
  input: { type: "object", properties: {} },
};
const page: OUISurface = {
  id: "page:ClipCreator",
  name: "Clip Creator",
  description: "clips",
  actions: [generate, rename],
};

const started: OUIActionResult = {
  requestId: "call-1",
  success: true,
  interim: true,
  data: { status: "started", jobId: "job-1" },
  timestamp: 1,
};
const complete: OUIActionResult = {
  requestId: "call-1",
  success: true,
  interim: false,
  data: {
    status: "complete",
    jobId: "job-1",
    contentUrl: "https://cdn/clip.mp4",
  },
  timestamp: 2,
};

/** A channel whose first answer and final answer are given. */
function channel(first: OUIActionResult | null, final: OUIActionResult | null) {
  const awaitResult = vi.fn(
    async (_id: string, opts: { final?: boolean; timeoutMs: number }) =>
      opts.final ? final : first
  );
  return {
    dispatch: vi.fn(async () => {}),
    awaitResult,
  } satisfies UIActionChannel;
}

function run(
  ch: UIActionChannel,
  action: OUIAction,
  waitDeadline?: () => number,
  jobWaitMs?: number
) {
  // The page offers the action under test in place of its own generate.
  const offered: OUISurface = { ...page, actions: [action, rename] };
  const { tools } = buildUITools(pageOf([offered]), {
    channel: ch,
    resultTimeoutMs: 1000,
    currentPage: () => pageOf([offered]),
    onResult: () => {},
    ...(waitDeadline ? { waitDeadline } : {}),
    ...(jobWaitMs !== undefined ? { jobWaitMs } : {}),
  });
  const tool = tools.find((t) => t.name === action.id)!;
  return tool.execute(
    {},
    {
      userId: "u1",
      accountId: "a1",
      turnId: "t1",
      conversationId: "c1",
      toolCallId: "call-1",
      socketRoom: "agent:turn:t1",
    }
  );
}

describe("a UI action that starts work", () => {
  it("returns the work’s outcome once it is done, waiting no longer than the call’s budget", async () => {
    const ch = channel(started, complete);
    const result = await run(ch, generate);
    expect(result).toMatchObject({
      success: true,
      data: {
        result: { status: "complete", contentUrl: "https://cdn/clip.mp4" },
      },
    });
    expect((result.data as Record<string, unknown>).status).toBeUndefined();
    expect(ch.awaitResult).toHaveBeenCalledTimes(2);
    const [, finalOpts] = ch.awaitResult.mock.calls[1];
    expect(finalOpts).toMatchObject({ userId: "u1", final: true });
    // The action allows 5 min; the call waits 20 s of it.
    expect(DEFAULT_JOB_WAIT_MS).toBe(20_000);
    expect(finalOpts.timeoutMs).toBeLessThanOrEqual(20_000);
    expect(finalOpts.timeoutMs).toBeGreaterThan(19_000);
  });

  it("reports a failed outcome as a failure, with its reason", async () => {
    const failed: OUIActionResult = {
      ...complete,
      success: false,
      data: undefined,
      error: { code: "FAILED", message: "CUDA out of memory" },
    };
    const result = await run(channel(started, failed), generate);
    expect(result).toMatchObject({
      success: false,
      error: "CUDA out of memory",
    });
  });

  it("says it is still running, never done, when it has not finished in time", async () => {
    const result = await run(channel(started, null), generate);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      status: "running",
      result: { status: "started", jobId: "job-1" },
    });
    expect(String((result.data as Record<string, unknown>).note)).toMatch(
      /not done/
    );
  });

  it("stops waiting when the turn must answer, and says it is still running", async () => {
    const ch = channel(started, complete);
    const result = await run(ch, generate, () => Date.now() - 1);
    expect(result.data).toMatchObject({ status: "running" });
    expect(ch.awaitResult).toHaveBeenCalledTimes(1);
  });

  it("waits no longer than the turn allows when that is sooner than the call’s budget", async () => {
    const ch = channel(started, complete);
    await run(ch, generate, () => Date.now() + 5_000);
    expect(ch.awaitResult.mock.calls[1][1].timeoutMs).toBeLessThanOrEqual(
      5_000
    );
  });

  it("treats an acknowledgment handed back as the final answer as still running", async () => {
    const result = await run(channel(started, started), generate);
    expect(result.data).toMatchObject({ status: "running" });
  });

  it("asks once for an action that answers at once", async () => {
    const done: OUIActionResult = {
      requestId: "call-1",
      success: true,
      data: { name: "Harbour" },
      timestamp: 1,
    };
    const ch = channel(done, null);
    const result = await run(ch, rename);
    expect(result).toMatchObject({
      success: true,
      data: { result: { name: "Harbour" } },
    });
    expect(ch.awaitResult).toHaveBeenCalledTimes(1);
  });
});

/** A job that takes `jobMs`: its final answer arrives then, or the wait ends first. */
function jobChannel(jobMs: number) {
  const awaitResult = vi.fn(
    (_id: string, opts: { final?: boolean; timeoutMs: number }) =>
      new Promise<OUIActionResult | null>((resolve) => {
        if (!opts.final) return resolve(started);
        if (jobMs <= opts.timeoutMs) setTimeout(() => resolve(complete), jobMs);
        else setTimeout(() => resolve(null), opts.timeoutMs);
      })
  );
  return { dispatch: vi.fn(async () => {}), awaitResult } satisfies UIActionChannel;
}

describe("how long the call waits for started work", () => {
  const slow: OUIAction = {
    ...generate,
    id: "clips_generate",
    // A picture queued behind a live conversation: up to 16 min.
    polling: { intervalMs: 1000, maxDurationMs: 960_000 },
  };
  const unlimited: OUIAction = { ...generate, polling: { intervalMs: 1000 } };

  it("settles a 3 s job in the call", async () => {
    vi.useFakeTimers();
    try {
      const pending = run(jobChannel(3_000), slow);
      await vi.advanceTimersByTimeAsync(3_000);
      const result = await pending;
      expect(result).toMatchObject({ success: true, data: { result: { status: "complete" } } });
      expect((result.data as Record<string, unknown>).status).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a 60 s job still running after 20 s, though the action allows 16 min", async () => {
    vi.useFakeTimers();
    try {
      const ch = jobChannel(60_000);
      let settled = false;
      const pending = run(ch, slow).finally(() => (settled = true));
      await vi.advanceTimersByTimeAsync(19_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(result.data).toMatchObject({ status: "running", result: { status: "started" } });
      expect(ch.awaitResult.mock.calls[1][1].timeoutMs).toBe(20_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits the same budget for an action that declares no limit", async () => {
    const ch = channel(started, complete);
    await run(ch, unlimited);
    expect(ch.awaitResult.mock.calls[1][1].timeoutMs).toBeLessThanOrEqual(DEFAULT_JOB_WAIT_MS);
    expect(ch.awaitResult.mock.calls[1][1].timeoutMs).toBeGreaterThan(DEFAULT_JOB_WAIT_MS - 1_000);
  });

  it("takes its budget from the host, and never past the action’s own limit", async () => {
    const ch = channel(started, complete);
    await run(ch, slow, undefined, 45_000);
    expect(ch.awaitResult.mock.calls[1][1].timeoutMs).toBeGreaterThan(44_000);
    expect(ch.awaitResult.mock.calls[1][1].timeoutMs).toBeLessThanOrEqual(45_000);

    const quick: OUIAction = { ...generate, polling: { intervalMs: 1000, maxDurationMs: 5_000 } };
    const ch2 = channel(started, complete);
    await run(ch2, quick, undefined, 45_000);
    expect(ch2.awaitResult.mock.calls[1][1].timeoutMs).toBeLessThanOrEqual(5_000);

    // A budget of 0 reports started work running at once.
    const ch3 = channel(started, complete);
    const result = await run(ch3, slow, undefined, 0);
    expect(result.data).toMatchObject({ status: "running" });
    expect(ch3.awaitResult).toHaveBeenCalledTimes(1);
  });
});

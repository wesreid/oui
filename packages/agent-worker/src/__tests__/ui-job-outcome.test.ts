/**
 * A UI action that starts work (a GPU job, an export) is answered twice: acknowledged, then finished. The
 * tool waits for the finished answer, so the model tells the person the work is done only once it is, in
 * the same turn; when it has not finished by the action's own limit or by the time the turn must answer,
 * the tool says it is still running, never done.
 */
import { describe, expect, it, vi } from "vitest";
import type { OUIAction, OUIActionResult, OUISurface } from "oui-spec/spec";

import { buildUITools } from "../ui/ui-tools.js";
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
  waitDeadline?: () => number
) {
  const { tools } = buildUITools([page], {
    channel: ch,
    resultTimeoutMs: 1000,
    currentSurfaces: () => [page],
    onResult: () => {},
    ...(waitDeadline ? { waitDeadline } : {}),
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
  it("returns the work’s outcome once it is done, waiting no longer than the action’s own limit", async () => {
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
    expect(finalOpts.timeoutMs).toBeLessThanOrEqual(300_000);
    expect(finalOpts.timeoutMs).toBeGreaterThan(290_000);
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

  it("waits no longer than the turn allows when that is sooner than the action’s limit", async () => {
    const ch = channel(started, complete);
    await run(ch, generate, () => Date.now() + 60_000);
    expect(ch.awaitResult.mock.calls[1][1].timeoutMs).toBeLessThanOrEqual(
      60_000
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

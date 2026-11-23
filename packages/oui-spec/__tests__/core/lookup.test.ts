/**
 * The runtime's lookup (§7.3.10): `oui.find` and `oui.guide`, answered from
 * what the host knows of its app, and named in the snapshot only when there is
 * a lookup to answer them.
 *
 * On 2026-11-23 the PA said a picture's object could not be removed, because it
 * knew only the page it was on; the editor that removes objects was one page
 * away. The lookup lets an agent search the whole app and read any page's
 * knowledge from the tab, which holds the build's manifest and knowledge.
 */
import { describe, expect, it } from "vitest";
import { createSurfaceRuntime } from "../../src/core/surface-runtime.js";
import {
  OUI_FIND_ACTION,
  OUI_GUIDE_ACTION,
  OUI_LOOKUP_ACTIONS,
  OUI_RUNTIME_SURFACE,
} from "../../src/spec/index-form.js";
import type { OUIActionRequest } from "../../src/spec/types.js";

function request(actionId: string, params: Record<string, unknown>): OUIActionRequest {
  return {
    requestId: `req-${Math.random()}`,
    surfaceId: OUI_RUNTIME_SURFACE,
    actionId,
    params,
    timestamp: Date.now(),
  };
}

const found = {
  results: [
    {
      tool: "image_studio_generative_remove",
      title: "Remove",
      page: { title: "Image Editor", route: "/image/:imageId" },
    },
  ],
};

describe("the runtime's lookup", () => {
  it("names find and guide as the lookup actions, in that order", () => {
    expect(OUI_LOOKUP_ACTIONS).toEqual([OUI_FIND_ACTION, OUI_GUIDE_ACTION]);
  });

  it("answers find and guide from the host's lookup, with the params as sent", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const runtime = createSurfaceRuntime({
      form: "index",
      announce: false,
      lookup: {
        find: (params) => {
          seen.push(params);
          return { success: true, data: found };
        },
        guide: async (params) => ({ success: true, data: { page: params.page, text: "Image Editor (/image/:imageId)" } }),
      },
    });
    const find = await runtime.execute(request(OUI_FIND_ACTION, { query: "remove an object", limit: 3 }));
    expect(find.success).toBe(true);
    expect(find.data).toEqual(found);
    expect(find.settled).toBe(true);
    expect(typeof find.surfacesHash).toBe("string");
    expect(seen).toEqual([{ query: "remove an object", limit: 3 }]);

    const guide = await runtime.execute(request(OUI_GUIDE_ACTION, { page: "/image/:imageId" }));
    expect(guide.success).toBe(true);
    expect(guide.data).toEqual({ page: "/image/:imageId", text: "Image Editor (/image/:imageId)" });
  });

  it("names in the snapshot only what the lookup answers, and nothing without one", () => {
    const none = createSurfaceRuntime({ form: "index", announce: false });
    expect(none.snapshot()).not.toHaveProperty("lookup");

    const findOnly = createSurfaceRuntime({
      form: "index",
      announce: false,
      lookup: { find: () => ({ success: true, data: found }) },
    });
    expect(findOnly.snapshot().lookup).toEqual(["find"]);

    const full = createSurfaceRuntime({
      announce: false,
      lookup: { find: () => ({ success: true, data: found }), guide: () => ({ success: true, data: {} }) },
    });
    expect(full.snapshot().lookup).toEqual(["find", "guide"]);
  });

  it("takes a lookup later, tells its subscribers, and can take it away", async () => {
    const runtime = createSurfaceRuntime({ form: "index", announce: false });
    let told = 0;
    runtime.subscribe(() => told++);
    runtime.setLookup({ find: () => ({ success: true, data: found }) });
    expect(told).toBe(1);
    expect(runtime.snapshot().lookup).toEqual(["find"]);
    expect((await runtime.execute(request(OUI_FIND_ACTION, { query: "remove" }))).success).toBe(true);

    runtime.setLookup(null);
    expect(told).toBe(2);
    expect(runtime.snapshot()).not.toHaveProperty("lookup");
    const refused = await runtime.execute(request(OUI_FIND_ACTION, { query: "remove" }));
    expect(refused.success).toBe(false);
    expect(refused.error?.code).toBe("ACTION_NOT_FOUND");
    expect(refused.error?.message).toContain('no lookup that answers "find"');
  });

  it("passes on a lookup's own refusal, and answers a lookup that throws with its message", async () => {
    const runtime = createSurfaceRuntime({
      form: "index",
      announce: false,
      lookup: {
        find: () => ({ success: false, error: { code: "INVALID_PARAMS", message: "find takes query: words" } }),
        guide: () => {
          throw new Error("no page is named Nowhere");
        },
      },
    });
    const find = await runtime.execute(request(OUI_FIND_ACTION, {}));
    expect(find).toMatchObject({ success: false, error: { code: "INVALID_PARAMS", message: "find takes query: words" } });
    const guide = await runtime.execute(request(OUI_GUIDE_ACTION, { page: "Nowhere" }));
    expect(guide).toMatchObject({ success: false, error: { code: "LOOKUP_FAILED", message: "no page is named Nowhere" } });
  });

  it("refuses an answer larger than a frame, saying to ask for fewer", async () => {
    const runtime = createSurfaceRuntime({
      form: "index",
      announce: false,
      budgets: { answerBytes: 32 * 1024 },
      lookup: { find: () => ({ success: true, data: { text: "x".repeat(40 * 1024) } }) },
    });
    const answer = await runtime.execute(request(OUI_FIND_ACTION, { query: "x" }));
    expect(answer.success).toBe(false);
    expect(answer.error?.code).toBe("TOO_LARGE");
    expect(answer.error?.message).toContain("ask for fewer");
  });

  it("lists the lookup actions it answers when asked for one it does not have", async () => {
    const runtime = createSurfaceRuntime({
      form: "index",
      announce: false,
      lookup: { find: () => ({ success: true, data: found }), guide: () => ({ success: true, data: {} }) },
    });
    const answer = await runtime.execute(request("search", {}));
    expect(answer.success).toBe(false);
    expect(answer.error?.message).toBe(
      'The runtime answers "describe", "read", "find" and "guide"; it has no "search".',
    );
  });
});

/**
 * The index form, definitions on demand, and frames that always fit
 * (§7.3.8, §7.3.9, §7.3.10).
 *
 * On a studio page a client's action definitions weighed 604 KB: more than a
 * relay's 512 KB frame, and about 154,000 tokens for an agent's model on every
 * call. An answer carrying them was refused, and sent again without the page's
 * state, so the agent worked blind. Now a client sends an index of its actions,
 * an agent runtime fetches the definition it needs, and what a client sends is
 * shortened to a byte budget before it is sent, saying where.
 */
import { describe, expect, it } from "vitest";
import { createSurfaceRuntime } from "../../src/core/surface-runtime.js";
import { defineSurface } from "../../src/core/define-surface.js";
import {
  firstSentence,
  indexEntry,
  jsonBytes,
  summarizeInput,
  surfaceIndex,
  INDEX_DESCRIPTION_CHARS,
  INDEX_INPUT_CHARS,
  OUI_RUNTIME_SURFACE,
} from "../../src/spec/index-form.js";
import { atPointer, fitObservations } from "../../src/spec/fit.js";
import { surfacesHash } from "../../src/spec/surfaces-hash.js";
import type {
  JSONSchema,
  OUIAction,
  OUIActionRequest,
  OUIActionResult,
} from "../../src/spec/types.js";
import { createMockSocket, wait } from "../helpers/mock-socket.js";

const FAST = { quietMs: 20, timeoutMs: 400 };

function request(
  surfaceId: string,
  actionId: string,
  extra: Partial<OUIActionRequest> = {},
  requestId = `req-${Math.random()}`,
): OUIActionRequest {
  return {
    requestId,
    surfaceId,
    actionId,
    params: {},
    timestamp: Date.now(),
    ...extra,
  };
}

/** An effect catalogue as a room declares it: one member per effect, told apart by `effect`. */
function effectUnion(effects: number, paramsEach: number): JSONSchema {
  return {
    oneOf: Array.from({ length: effects }, (_, e) => ({
      type: "object",
      required: ["effect", "layerId"],
      properties: {
        effect: { const: `effect-${e}` },
        layerId: {
          type: "string",
          description: "The layer the effect is added to.",
        },
        ...Object.fromEntries(
          Array.from({ length: paramsEach }, (_, p) => [
            `param_${p}`,
            {
              type: "number",
              minimum: 0,
              maximum: 100,
              "x-unit": "px",
              description: `Parameter ${p} of effect ${e}: how far it reaches at the playhead, in the document's unit.`,
            },
          ]),
        ),
      },
    })),
  };
}

/** A studio room: `actions` plain actions, and one that takes a whole catalogue. */
function studioRoom(id: string, actions: number, effects = 60) {
  return defineSurface<{ ran: (id: string) => void }>({
    id,
    name: `Studio ${id}`,
    description: "A room with a large catalogue of actions.",
    observations: [
      {
        id: "layers",
        description: "The layers of the document.",
        schema: { type: "array" },
      },
    ],
    actions: [
      {
        id: `${id}_effect_add`,
        title: "Add an effect",
        description:
          "Adds an effect to a layer. Each effect takes its own parameters. The stack draws top to bottom.",
        effect: "edit",
        input: effectUnion(effects, 12),
        handler: async (_p, ctx) => {
          ctx.ran("effect_add");
          return { success: true };
        },
      },
      ...Array.from({ length: actions }, (_, a) => ({
        id: `${id}_action_${a}`,
        title: `Action ${a}`,
        description: `Sets property ${a} of the selection. It is one undo step.`,
        input: {
          type: "object",
          required: ["value"],
          properties: {
            value: {
              type: "number",
              minimum: 0,
              maximum: 1000,
              "x-unit": "px",
            },
          },
        } as JSONSchema,
        handler: async (
          _p: Record<string, unknown>,
          ctx: { ran: (id: string) => void },
        ) => {
          ctx.ran(`action_${a}`);
          return { success: true, data: { applied: a } };
        },
      })),
    ],
  });
}

describe("an action’s index entry", () => {
  it("says what an action takes in one line, by rule", () => {
    expect(summarizeInput(undefined)).toBe("none");
    expect(summarizeInput({ type: "object" })).toBe("none");
    expect(summarizeInput({ type: "object", properties: {} })).toBe("none");
    expect(
      summarizeInput({
        type: "object",
        required: ["value"],
        properties: {
          value: { type: "number", minimum: 0, maximum: 100, "x-unit": "px" },
        },
      }),
    ).toBe("value: number 0–100 px");
    // Required first, optional marked, enums shown up to four, the rest counted.
    expect(
      summarizeInput({
        type: "object",
        required: ["clipId"],
        properties: {
          start: { type: "number", minimum: 0 },
          clipId: { type: "string" },
          mode: { enum: ["a", "b", "c", "d", "e", "f"] },
          when: { type: "string", format: "date" },
          tags: { type: "array", items: { type: "string" } },
          style: { type: "object", properties: { fill: {}, stroke: {} } },
          extra1: { type: "boolean" },
          extra2: { type: "boolean" },
        },
      }),
    ).toBe(
      "clipId: string, start?: number ≥0, mode?: a|b|c|d|…(6), when?: string(date), tags?: list of string, style?: object(2),…",
    );
    expect(summarizeInput(effectUnion(60, 12))).toBe(
      "one of 60 shapes by effect",
    );
    expect(
      summarizeInput({ anyOf: [{ type: "string" }, { type: "number" }] }),
    ).toBe("one of 2 shapes");
    for (const schema of [
      effectUnion(60, 12),
      {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 40 }, (_, i) => [
            `a_long_property_name_${i}`,
            { type: "string" },
          ]),
        ),
      },
    ]) {
      expect(summarizeInput(schema as JSONSchema).length).toBeLessThanOrEqual(
        INDEX_INPUT_CHARS,
      );
    }
  });

  it("keeps the first sentence of a description, on one line", () => {
    expect(
      firstSentence(
        "Adds an effect to a layer. Each effect takes its own parameters.",
      ),
    ).toBe("Adds an effect to a layer.");
    expect(firstSentence("Sets the opacity to 0.5 by default\nand more")).toBe(
      "Sets the opacity to 0.5 by default and more",
    );
    expect(firstSentence("x".repeat(500)).length).toBe(INDEX_DESCRIPTION_CHARS);
    expect(firstSentence("x".repeat(500)).endsWith("…")).toBe(true);
  });

  it("carries what choosing the action needs, and names its definition without carrying it", () => {
    const room = studioRoom("room", 2);
    const action = room.toManifest().actions[0] as OUIAction;
    const entry = indexEntry(JSON.parse(JSON.stringify(action)));
    expect(entry).toEqual({
      id: "room_effect_add",
      title: "Add an effect",
      description: "Adds an effect to a layer.",
      effect: "edit",
      input: "one of 60 shapes by effect",
      definitionHash: expect.stringMatching(/^[0-9a-f]{16}$/),
      definitionBytes: jsonBytes(JSON.parse(JSON.stringify(action))),
    });
    expect(entry.definitionBytes).toBeGreaterThan(90_000);
    expect(jsonBytes(entry)).toBeLessThan(512);
    // The hash is the definition's: any change to it is another hash.
    const changed = {
      ...JSON.parse(JSON.stringify(action)),
      description: "Adds an effect to a layer! Now.",
    };
    expect(indexEntry(changed).definitionHash).not.toBe(entry.definitionHash);
  });

  it("reports an async action’s limit, and that an action confirms", () => {
    const entry = indexEntry({
      id: "render",
      description: "Renders the clip.",
      input: { type: "object" },
      async: true,
      confirm: true,
      estimatedDuration: "30-120s",
      polling: { intervalMs: 1000, maxDurationMs: 300_000 },
    });
    expect(entry).toMatchObject({
      async: true,
      confirm: true,
      estimatedDuration: "30-120s",
      maxDurationMs: 300_000,
      input: "none",
    });
  });
});

describe("a client sends its actions as an index", () => {
  it("snapshots without a definition, small enough for any frame, under a hash of the index", () => {
    const runtime = createSurfaceRuntime({
      form: "index",
      announce: false,
      settle: FAST,
    });
    const full = createSurfaceRuntime({
      form: "index",
      announce: false,
      settle: FAST,
      form: "full",
    });
    // The editor with the vector studio docked: 427 actions.
    const rooms = [
      studioRoom("editor", 305, 50),
      studioRoom("vector", 120, 60),
    ];
    for (const room of rooms) {
      runtime.mount(room, () => ({ ran: () => {} }));
      full.mount(room, () => ({ ran: () => {} }));
    }
    const snap = runtime.snapshot();
    expect(snap).not.toHaveProperty("surfaces");
    expect(snap.index!.map((s) => [s.id, s.index.length])).toEqual([
      ["editor", 306],
      ["vector", 121],
    ]);
    expect(snap.index![0].observations).toEqual([
      {
        id: "layers",
        description: "The layers of the document.",
        schema: { type: "array" },
      },
    ]);
    expect(JSON.stringify(snap)).not.toContain('"properties"');
    expect(snap.surfacesHash).toBe(surfacesHash(snap.index!));

    // What the same page weighs with its definitions, and without.
    expect(jsonBytes(full.snapshot())).toBeGreaterThan(200 * 1024);
    expect(jsonBytes(snap)).toBeLessThan(128 * 1024);
    runtime.dispose();
    full.dispose();
  });

  it("answers with the index only when the agent runtime does not hold it", async () => {
    const runtime = createSurfaceRuntime({
      form: "index",
      announce: false,
      settle: FAST,
    });
    runtime.mount(studioRoom("room", 3), () => ({ ran: () => {} }));
    const known = runtime.snapshot().surfacesHash!;

    const first = await runtime.execute(request("room", "room_action_0"));
    expect(first.index).toEqual(runtime.snapshot().index);
    expect(first).not.toHaveProperty("surfaces");

    const next = await runtime.execute(
      request("room", "room_action_1", { knownSurfaces: known }),
    );
    expect(next).not.toHaveProperty("index");
    expect(next).toMatchObject({
      success: true,
      data: { applied: 1 },
      surfacesHash: known,
    });
    runtime.dispose();
  });

  it("gives up the index first when an answer is refused, and keeps what the page shows", async () => {
    const socket = createMockSocket();
    const runtime = createSurfaceRuntime({
      form: "index",
      socket,
      announce: false,
      settle: FAST,
    });
    const mounted = runtime.mount(studioRoom("room", 2), () => ({
      ran: () => {},
    }));
    mounted.pushObservation("layers", [{ id: "l1" }]);
    socket.receive("oui:dispatch", request("room", "room_action_0", {}, "r-1"));
    await wait(FAST.quietMs + 80);
    const sent = () =>
      socket.emitted.filter((e) => e.event === "oui:action:result");
    sent()[0].ack!({ ok: false, error: "payload larger than 524288 bytes" });
    const second = sent()[1].data as OUIActionResult;
    expect(second.delivery).toEqual({
      trimmed: true,
      reason: "payload larger than 524288 bytes",
      omitted: ["index"],
    });
    expect(second).not.toHaveProperty("index");
    expect(second.observations).toEqual({ room: { layers: [{ id: "l1" }] } });
    runtime.dispose();
  });

  it("refuses a surface defined with the runtime’s own id", () => {
    expect(() =>
      defineSurface({
        id: OUI_RUNTIME_SURFACE,
        name: "x",
        description: "x",
        actions: [],
      }),
    ).toThrow(/surface runtime's own id/);
  });
});

describe("oui.describe: a definition when it is needed", () => {
  function mounted() {
    const runtime = createSurfaceRuntime({
      form: "index",
      announce: false,
      settle: { quietMs: 400, timeoutMs: 2000 },
    });
    const ran: string[] = [];
    runtime.mount(studioRoom("room", 3), () => ({ ran: (id) => ran.push(id) }));
    return { runtime, ran };
  }

  it("returns the live definitions asked for, at once, with nothing of the page", async () => {
    const { runtime, ran } = mounted();
    const startedAt = Date.now();
    const result = await runtime.execute(
      request(OUI_RUNTIME_SURFACE, "describe", {
        params: {
          actions: [
            { surface: "room", action: "room_effect_add" },
            { surface: "room", action: "room_action_1" },
          ],
        },
      }),
    );
    // No waiting for the UI to settle: reading changes nothing.
    expect(Date.now() - startedAt).toBeLessThan(200);
    expect(result.success).toBe(true);
    const data = result.data as {
      definitions: Array<{ surface: string; action: OUIAction }>;
    };
    expect(data.definitions.map((d) => [d.surface, d.action.id])).toEqual([
      ["room", "room_effect_add"],
      ["room", "room_action_1"],
    ]);
    expect(data.definitions[0].action.input.oneOf).toHaveLength(60);
    expect(data.definitions[1].action.input).toEqual({
      type: "object",
      required: ["value"],
      properties: {
        value: { type: "number", minimum: 0, maximum: 1000, "x-unit": "px" },
      },
    });
    expect(result).not.toHaveProperty("index");
    expect(result).not.toHaveProperty("observations");
    expect(result.surfacesHash).toBe(runtime.snapshot().surfacesHash);
    expect(ran).toEqual([]);
    runtime.dispose();
  });

  it("names what is not on screen, and what must be asked for again", async () => {
    const runtime = createSurfaceRuntime({
      form: "index",
      announce: false,
      settle: FAST,
      budgets: { answerBytes: 150 * 1024 },
    });
    runtime.mount(studioRoom("a", 0), () => ({ ran: () => {} }));
    runtime.mount(studioRoom("b", 0), () => ({ ran: () => {} }));
    const result = await runtime.execute(
      request(OUI_RUNTIME_SURFACE, "describe", {
        params: {
          actions: [
            { surface: "a", action: "a_effect_add" },
            { surface: "gone", action: "x" },
            { surface: "a", action: "nope" },
            { surface: "b", action: "b_effect_add" },
          ],
        },
      }),
    );
    const data = result.data as Record<
      string,
      Array<{ surface: string; action: unknown }>
    >;
    // Two 90 KB definitions do not fit one 150 KB frame: the second waits.
    expect(data.definitions.map((d) => d.surface)).toEqual(["a"]);
    expect(data.missing).toEqual([
      { surface: "gone", action: "x" },
      { surface: "a", action: "nope" },
    ]);
    expect(data.deferred).toEqual([{ surface: "b", action: "b_effect_add" }]);
    runtime.dispose();
  });

  it("refuses a request that names no action", async () => {
    const { runtime } = mounted();
    for (const params of [
      {},
      { actions: [] },
      { actions: ["room_effect_add"] },
    ]) {
      const result = await runtime.execute(
        request(OUI_RUNTIME_SURFACE, "describe", { params }),
      );
      expect(result).toMatchObject({
        success: false,
        error: { code: "INVALID_PARAMS" },
      });
    }
    const unknown = await runtime.execute(request(OUI_RUNTIME_SURFACE, "nope"));
    expect(unknown).toMatchObject({
      success: false,
      error: { code: "ACTION_NOT_FOUND" },
    });
    runtime.dispose();
  });
});

describe("a frame fits its byte budget, and says where it was cut (§7.3.9)", () => {
  const layers = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `layer-${i}`,
      name: `Layer ${i}`,
      x: i,
      y: i * 2,
      text: "Lorem ipsum dolor sit amet ".repeat(4),
    }));

  it("leaves observations that fit as they are", () => {
    const observations = { room: { layers: layers(3) } };
    const fitted = fitObservations(observations, 64 * 1024);
    expect(fitted.observations).toBe(observations);
    expect(fitted.cuts).toEqual([]);
  });

  it("cuts the long lists first, a step at a time, and reports each once with its full length", () => {
    const observations = {
      room: { layers: layers(1000), selection: ["layer-3"] },
      shell: { projects: layers(30) },
    };
    const before = JSON.stringify(observations);
    const fitted = fitObservations(observations, 24 * 1024);
    expect(jsonBytes(fitted.observations)).toBeLessThanOrEqual(24 * 1024);
    expect((fitted.observations.room.layers as unknown[]).length).toBe(50);
    expect(fitted.observations.shell.projects).toHaveLength(30);
    expect(fitted.observations.room.selection).toEqual(["layer-3"]);
    expect(fitted.cuts).toEqual([
      {
        surface: "room",
        observation: "layers",
        path: "",
        kind: "list",
        total: 1000,
        kept: 50,
      },
    ]);
    // The client's own state is never changed by fitting it.
    expect(JSON.stringify(observations)).toBe(before);
  });

  it("then cuts long texts, then leaves whole values out, the largest first", () => {
    const text = fitObservations(
      { doc: { body: "a".repeat(50_000), title: "T" } },
      8 * 1024,
    );
    expect(text.observations.doc).toEqual({
      body: "a".repeat(2000),
      title: "T",
    });
    expect(text.cuts).toEqual([
      {
        surface: "doc",
        observation: "body",
        path: "",
        kind: "text",
        total: 50_000,
        kept: 2000,
      },
    ]);

    const dense = Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => [`k${i}`, "v".repeat(100)]),
    );
    const dropped = fitObservations(
      { doc: { big: dense, small: { a: 1 } } },
      1024,
    );
    expect(dropped.observations.doc).toEqual({ big: null, small: { a: 1 } });
    expect(dropped.cuts).toEqual([
      {
        surface: "doc",
        observation: "big",
        path: "",
        kind: "value",
        total: jsonBytes(dense),
        kept: 0,
      },
    ]);
  });

  it("reports a list inside a value by its JSON Pointer", () => {
    const fitted = fitObservations(
      {
        page: {
          state: { lists: { "clips/all": layers(300) }, values: { a: 1 } },
        },
      },
      20 * 1024,
    );
    expect(fitted.cuts).toEqual([
      {
        surface: "page",
        observation: "state",
        path: "/lists/clips~1all",
        kind: "list",
        total: 300,
        kept: 50,
      },
    ]);
    expect(
      atPointer({ lists: { "clips/all": [1, 2] } }, "/lists/clips~1all/1"),
    ).toBe(2);
  });

  it("an answer on a page with a thousand rows fits, keeps the action’s data whole, and says what to read", async () => {
    const runtime = createSurfaceRuntime({
      form: "index",
      announce: false,
      settle: FAST,
      budgets: { answerBytes: 64 * 1024 },
    });
    const mounted = runtime.mount(studioRoom("room", 3), () => ({
      ran: () => {},
    }));
    mounted.pushObservation("layers", layers(1000));
    const known = runtime.snapshot().surfacesHash!;
    const result = await runtime.execute(
      request("room", "room_action_2", { knownSurfaces: known }),
    );
    expect(jsonBytes(result)).toBeLessThanOrEqual(64 * 1024);
    expect(result.data).toEqual({ applied: 2 });
    expect(result.fit).toEqual({
      observations: [
        {
          surface: "room",
          observation: "layers",
          path: "",
          kind: "list",
          total: 1000,
          kept: 200,
        },
      ],
    });
    expect((result.observations!.room.layers as unknown[]).length).toBe(200);
    runtime.dispose();
  });

  it("leaves out data that alone outweighs the frame, and says how large it was", async () => {
    const runtime = createSurfaceRuntime({
      form: "index",
      announce: false,
      settle: FAST,
      budgets: { answerBytes: 64 * 1024 },
    });
    const surface = defineSurface({
      id: "export",
      name: "Export",
      description: "e",
      actions: [
        {
          id: "dump",
          description: "Returns the whole document.",
          input: { type: "object" },
          handler: async () => ({
            success: true,
            data: { document: "d".repeat(200_000) },
          }),
        },
      ],
    });
    const mounted = runtime.mount(surface, () => ({}));
    mounted.pushObservation("status", { ready: true });
    const result = await runtime.execute(request("export", "dump"));
    expect(result.success).toBe(true);
    expect(result).not.toHaveProperty("data");
    expect(result.fit!.data!.bytes).toBeGreaterThan(200_000);
    expect(result.fit!.data!.limit).toBeLessThan(64 * 1024);
    expect(result.observations).toEqual({
      export: { status: { ready: true } },
    });
    expect(jsonBytes(result)).toBeLessThanOrEqual(64 * 1024);
    runtime.dispose();
  });

  it("a snapshot fits its own budget", () => {
    const runtime = createSurfaceRuntime({
      form: "index",
      announce: false,
      settle: FAST,
      budgets: { snapshotBytes: 48 * 1024 },
    });
    const mounted = runtime.mount(studioRoom("room", 3), () => ({
      ran: () => {},
    }));
    mounted.pushObservation("layers", layers(1000));
    const snap = runtime.snapshot();
    expect(jsonBytes(snap)).toBeLessThanOrEqual(48 * 1024 + 512);
    expect(snap.fit!.observations![0]).toMatchObject({
      surface: "room",
      observation: "layers",
      kind: "list",
      total: 1000,
    });
    runtime.dispose();
  });
});

describe("a full-form page whose definitions outweigh the frame (session 618701bb)", () => {
  it("keeps what the page shows once its definitions are left out, where it used to lose both", async () => {
    const socket = createMockSocket();
    // Two rooms' definitions, about 200 KB, against a 128 KB frame.
    const runtime = createSurfaceRuntime({
      socket,
      announce: false,
      settle: FAST,
      budgets: { answerBytes: 128 * 1024 },
    });
    const editor = runtime.mount(studioRoom("editor", 5, 60), () => ({
      ran: () => {},
    }));
    runtime.mount(studioRoom("vector", 5, 60), () => ({ ran: () => {} }));
    editor.pushObservation("layers", [{ id: "clip-1", kind: "graphic" }]);

    socket.receive(
      "oui:dispatch",
      request("editor", "editor_action_0", {}, "insert"),
    );
    await wait(FAST.quietMs + 80);
    const sent = () =>
      socket.emitted.filter((e) => e.event === "oui:action:result");
    const first = sent()[0].data as OUIActionResult;
    expect(jsonBytes(first)).toBeGreaterThan(128 * 1024);
    // The relay refuses it; the client sends it again without the definitions.
    sent()[0].ack!({ ok: false, error: "payload larger than 131072 bytes" });
    const second = sent()[1].data as OUIActionResult;
    expect(second.delivery!.omitted).toEqual(["surfaces"]);
    expect(second.observations).toEqual({
      editor: { layers: [{ id: "clip-1", kind: "graphic" }] },
    });
    expect(second.data).toEqual({ applied: 0 });
    expect(jsonBytes(second)).toBeLessThan(128 * 1024);
    runtime.dispose();
  });
});

describe("oui.read: the part of the page that did not fit", () => {
  function page() {
    const runtime = createSurfaceRuntime({
      form: "index",
      announce: false,
      settle: FAST,
    });
    const mounted = runtime.mount(studioRoom("room", 1), () => ({
      ran: () => {},
    }));
    mounted.pushObservation(
      "layers",
      Array.from({ length: 500 }, (_, i) => ({ id: `layer-${i}` })),
    );
    mounted.pushObservation("state", {
      lists: { clips: [{ id: "c1" }, { id: "c2" }, { id: "c3" }] },
      values: { title: "Intro" },
    });
    const read = (params: Record<string, unknown>) =>
      runtime.execute(request(OUI_RUNTIME_SURFACE, "read", { params }));
    return { runtime, read };
  }

  it("returns a page of a list, with where the next begins", async () => {
    const { runtime, read } = page();
    const first = await read({
      surface: "room",
      observation: "layers",
      offset: 200,
      limit: 3,
    });
    expect(first).toMatchObject({
      success: true,
      data: {
        rows: [{ id: "layer-200" }, { id: "layer-201" }, { id: "layer-202" }],
        total: 500,
        offset: 200,
        more: true,
        next: 203,
      },
    });
    expect(first).not.toHaveProperty("observations");
    const last = await read({
      surface: "room",
      observation: "layers",
      offset: 498,
    });
    expect(last.data).toEqual({
      rows: [{ id: "layer-498" }, { id: "layer-499" }],
      total: 500,
      offset: 498,
    });
    const byDefault = await read({ surface: "room", observation: "layers" });
    expect((byDefault.data as { rows: unknown[] }).rows).toHaveLength(50);
    runtime.dispose();
  });

  it("reads inside a value by JSON Pointer", async () => {
    const { runtime, read } = page();
    expect(
      (
        await read({
          surface: "room",
          observation: "state",
          path: "/values/title",
        })
      ).data,
    ).toEqual({ value: "Intro" });
    expect(
      (
        await read({
          surface: "room",
          observation: "state",
          path: "/lists/clips",
          limit: 2,
        })
      ).data,
    ).toEqual({
      rows: [{ id: "c1" }, { id: "c2" }],
      total: 3,
      offset: 0,
      more: true,
      next: 2,
    });
    runtime.dispose();
  });

  it("says what is not there, and what it was asked wrongly", async () => {
    const { runtime, read } = page();
    expect(await read({ surface: "gone", observation: "x" })).toMatchObject({
      success: false,
      error: { code: "NOT_FOUND" },
    });
    const unknown = await read({ surface: "room", observation: "nope" });
    expect(unknown).toMatchObject({
      success: false,
      error: { code: "NOT_FOUND" },
    });
    expect(unknown.error!.message).toContain("layers, state");
    expect(
      await read({
        surface: "room",
        observation: "state",
        path: "/values/missing",
      }),
    ).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
    expect(
      await read({ surface: "room", observation: "state", path: "values" }),
    ).toMatchObject({ success: false, error: { code: "INVALID_PARAMS" } });
    expect(
      await read({ surface: "room", observation: "layers", limit: 0 }),
    ).toMatchObject({ success: false, error: { code: "INVALID_PARAMS" } });
    expect(await read({ surface: "room" })).toMatchObject({
      success: false,
      error: { code: "INVALID_PARAMS" },
    });
    runtime.dispose();
  });
});

describe("the index of a surface", () => {
  it("is the same wherever it is derived from the same manifest", () => {
    const manifest = JSON.parse(
      JSON.stringify(studioRoom("room", 4).toManifest()),
    );
    expect(surfaceIndex(manifest)).toEqual(
      surfaceIndex(JSON.parse(JSON.stringify(manifest))),
    );
    expect(surfacesHash([surfaceIndex(manifest)])).toMatch(
      /^fnv1a64:[0-9a-f]{16}$/,
    );
  });
});

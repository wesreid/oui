/**
 * A shared surface mounted on the page is the page's, in the page state over budget: it ranks with the page and
 * its rooms, inside that rank by mount order, and the shells still go first and the acting surface never.
 *
 * On Closure Studio's video editor the Storyboard became a shared surface (the Storyboard Studio renders the same
 * components), and ranked below the docked vector studio's room it was left out of the first page state whole:
 * the PA could not see the Storyboard it was asked about until it acted on it.
 */
import { describe, expect, it } from "vitest";
import {
  boundObservations,
  pageStateFit,
  surfaceRank,
} from "../ui/observations.js";

const rows = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({
    key: `${prefix}-${i}`,
    title: `${prefix} row ${i}`,
  }));
const text = (n: number) => "x".repeat(n);

/** In mount order, as the tab reports it: the frame, the page, the shared document, then a room docked later. */
const observations = {
  "shell:StudioShell": {
    state: {
      values: { "shell.theme": text(1_500) },
      lists: { "shell.project.choose": rows("p", 4) },
    },
  },
  "page:EditorPage": {
    state: { values: { "editor.panels": "timeline, storyboard" } },
  },
  "shared:StoryboardDocument": {
    state: {
      values: { "editor.storyboard.brief": text(1_800) },
      lists: { "editor.storyboard.line": rows("l", 4) },
    },
  },
  "room:vector-studio": { document: { name: "Graphic", note: text(1_800) } },
};

describe("a shared surface in the page state", () => {
  it("ranks with the page and its rooms; the acting surface first, the shells last", () => {
    expect(surfaceRank("shared:StoryboardDocument", undefined)).toBe(
      surfaceRank("page:EditorPage", undefined),
    );
    expect(surfaceRank("shared:StoryboardDocument", undefined)).toBe(
      surfaceRank("room:vector-studio", undefined),
    );
    expect(
      surfaceRank("shared:StoryboardDocument", "shared:StoryboardDocument"),
    ).toBe(0);
    expect(surfaceRank("shell:StudioShell", undefined)).toBeGreaterThan(
      surfaceRank("shared:StoryboardDocument", undefined),
    );
  });

  it("is kept over a room mounted after it, once the shells are gone", () => {
    const fit = pageStateFit(observations, 3_000);
    expect(fit.outcome).toBe("fitted");
    // The frame goes first, then the room mounted last; the page and the shared document it mounted stay.
    expect(fit.omitted).toEqual(["shell:StudioShell", "room:vector-studio"]);
  });

  it("is left out after a room mounted before it, inside the same rank", () => {
    const roomFirst = {
      "shell:StudioShell": observations["shell:StudioShell"],
      "page:EditorPage": observations["page:EditorPage"],
      "room:vector-studio": observations["room:vector-studio"],
      "shared:StoryboardDocument": observations["shared:StoryboardDocument"],
    };
    expect(pageStateFit(roomFirst, 3_000).omitted).toEqual([
      "shell:StudioShell",
      "shared:StoryboardDocument",
    ]);
  });

  it("never leaves out the surface the action acted on, even mounted last", () => {
    const bounded = boundObservations(
      observations,
      3_000,
      "room:vector-studio",
    ) as { values: Record<string, unknown> };
    const kept = Object.keys(bounded.values);
    // The acting room first; the shared document, the same rank and mounted before it, goes instead.
    expect(kept[0]).toBe("room:vector-studio");
    expect(kept).not.toContain("shared:StoryboardDocument");
    expect(kept).not.toContain("shell:StudioShell");
    expect(kept).toContain("page:EditorPage");
  });
});

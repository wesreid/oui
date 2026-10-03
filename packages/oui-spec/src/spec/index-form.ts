/**
 * The index form of a surface (§7.3.8): each action as one entry that says what
 * it is and what it takes in outline, in place of its definition.
 *
 * Everything here is derived from the action's own definition, by rule, so two
 * clients with the same definition produce the same entry and the same hash.
 */
import { fnv1a64, sortedJson } from "./surfaces-hash.js";
import type {
  JSONSchema,
  OUIAction,
  OUIActionIndexEntry,
  OUISurface,
  OUISurfaceIndex,
} from "./types.js";

/** The longest description an index entry carries. */
export const INDEX_DESCRIPTION_CHARS = 160;
/** The longest input line an index entry carries. */
export const INDEX_INPUT_CHARS = 120;
/** How many of an input's properties its line names before "+N more". */
export const INDEX_INPUT_PROPERTIES = 6;
/** How many of an enum's values a line shows before it says how many there are. */
const INDEX_ENUM_VALUES = 4;

/** The surface id the runtime itself answers (§7.3.10). No surface may be defined with it. */
export const OUI_RUNTIME_SURFACE = "oui";
/** `oui.describe`: the full definitions of the actions asked for. */
export const OUI_DESCRIBE_ACTION = "describe";
/** `oui.read`: part of an observation's value, by path, a page of a list at a time. */
export const OUI_READ_ACTION = "read";

/** The bytes `text` takes as UTF-8, which is what a frame's size limit counts. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // A surrogate pair is one code point of four bytes.
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** The bytes `value` takes as JSON on the wire; 0 for what JSON drops. */
export function jsonBytes(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : utf8Length(json);
}

/** `text` cut to `max` characters, ending in "…" when it was cut. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** A description's first sentence, on one line, at most `INDEX_DESCRIPTION_CHARS` characters. */
export function firstSentence(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  // A sentence ends at ". ", "! " or "? ": a full stop inside "0.5" or "e.g." followed by a letter is not one.
  const end = line.search(/[.!?](?= [A-Z0-9"'([])/);
  return clip(
    end >= 0 ? line.slice(0, end + 1) : line,
    INDEX_DESCRIPTION_CHARS,
  );
}

function typeOf(schema: JSONSchema): string {
  const t = schema.type;
  return Array.isArray(t) ? t.join("|") : (t ?? "");
}

function unitOf(schema: JSONSchema): string {
  const unit = schema["x-unit"];
  return typeof unit === "string" && unit ? ` ${unit}` : "";
}

/** The members of a schema's union, when it is one. */
function unionOf(schema: JSONSchema): JSONSchema[] | null {
  const members = schema.oneOf ?? schema.anyOf;
  return members && members.length > 0 ? members : null;
}

/**
 * The property every member of a union fixes to its own constant, which is
 * what tells the members apart: `effect` in `{ effect: "glow", … } | { effect:
 * "blur", … }`. Null when the members share no such property.
 */
export function discriminatorOf(members: readonly JSONSchema[]): string | null {
  const first = members[0]?.properties;
  if (!first) return null;
  for (const name of Object.keys(first)) {
    const constants = members.map((m) => constantOf(m.properties?.[name]));
    if (
      constants.every((c) => c !== undefined) &&
      new Set(constants).size === members.length
    )
      return name;
  }
  return null;
}

/** The one value a schema allows, when it allows one. */
export function constantOf(
  schema: JSONSchema | undefined,
): string | number | boolean | undefined {
  if (!schema) return undefined;
  if (
    typeof schema.const === "string" ||
    typeof schema.const === "number" ||
    typeof schema.const === "boolean"
  ) {
    return schema.const;
  }
  return schema.enum?.length === 1 ? schema.enum[0] : undefined;
}

/** A value's type in a few words: "number 0–100 px", "a|b|c|d|…(12)", "list of string". */
function valueSummary(schema: JSONSchema): string {
  const constant = constantOf(schema);
  if (constant !== undefined && !schema.enum) return JSON.stringify(constant);
  if (schema.enum) {
    const shown = schema.enum.slice(0, INDEX_ENUM_VALUES).map(String).join("|");
    return schema.enum.length > INDEX_ENUM_VALUES
      ? `${shown}|…(${schema.enum.length})`
      : shown;
  }
  const union = unionOf(schema);
  if (union) return `one of ${union.length}`;
  const type = typeOf(schema);
  if (type === "number" || type === "integer") {
    const { minimum: min, maximum: max } = schema;
    const range =
      min !== undefined && max !== undefined
        ? ` ${min}–${max}`
        : min !== undefined
          ? ` ≥${min}`
          : max !== undefined
            ? ` ≤${max}`
            : "";
    return `${type}${range}${unitOf(schema)}`;
  }
  if (type === "string")
    return schema.format ? `string(${schema.format})` : "string";
  if (type === "array")
    return schema.items ? `list of ${valueSummary(schema.items)}` : "list";
  if (type === "object") {
    const n = Object.keys(schema.properties ?? {}).length;
    return n > 0 ? `object(${n})` : "object";
  }
  return type || "any";
}

/**
 * What an action takes, in one line of at most `INDEX_INPUT_CHARS` characters:
 * - "none" for an action that takes nothing;
 * - each property with its type, required ones first, optional ones marked
 *   "?", the first `INDEX_INPUT_PROPERTIES` of them, then "+N more";
 * - "one of N shapes by <property>" for a union.
 */
export function summarizeInput(schema: JSONSchema | undefined): string {
  if (!schema) return "none";
  const union = unionOf(schema);
  if (union) {
    const by = discriminatorOf(union);
    return clip(
      `one of ${union.length} shapes${by ? ` by ${by}` : ""}`,
      INDEX_INPUT_CHARS,
    );
  }
  const properties = schema.properties ?? {};
  const names = Object.keys(properties);
  if (names.length === 0)
    return typeOf(schema) && typeOf(schema) !== "object"
      ? valueSummary(schema)
      : "none";
  const required = new Set(schema.required ?? []);
  const ordered = [
    ...names.filter((n) => required.has(n)),
    ...names.filter((n) => !required.has(n)),
  ];
  const shown = ordered.slice(0, INDEX_INPUT_PROPERTIES);
  const more = ordered.length - shown.length;
  const parts = shown.map(
    (n) => `${n}${required.has(n) ? "" : "?"}: ${valueSummary(properties[n])}`,
  );
  if (more > 0) parts.push(`+${more} more`);
  return clip(parts.join(", "), INDEX_INPUT_CHARS);
}

/** The longest lead-in before a quoted title that is still a lead-in ("Turn on or off", "Choose the face of"). */
const TITLE_LEAD_IN_CHARS = 32;

/**
 * A description without the opening that only repeats the action's title.
 *
 * An entry carries the title beside the description, and descriptions are
 * commonly written to stand alone: `Add artboard: Adds an artboard…`, or, for
 * a control, `Press "Save": Saves the project`. In an index that names the
 * title twice for every action, and an index is hundreds of actions. So an
 * opening of the title followed by ": ", or of a short lead-in, the title in
 * double quotes and ": ", is left out: what the entry keeps is what the title
 * does not already say. A description that does not open that way is kept as
 * it is, and one that is only its title is kept too.
 */
export function withoutTitleLeadIn(
  description: string,
  title: string | undefined,
): string {
  const line = description.replace(/\s+/g, " ").trim();
  if (!title) return line;
  const name = title.replace(/\s+/g, " ").trim();
  if (!name) return line;
  let rest: string | undefined;
  if (line.startsWith(`${name}: `)) rest = line.slice(name.length + 2);
  else {
    const quoted = `"${name}": `;
    const at = line.indexOf(quoted);
    // A lead-in is a few words with no sentence in them: "Press", "Type into", "Turn on or off".
    if (
      at >= 0 &&
      at <= TITLE_LEAD_IN_CHARS &&
      !/[.:!?"]/.test(line.slice(0, at))
    )
      rest = line.slice(at + quoted.length);
  }
  const kept = rest?.trim();
  return kept ? kept : line;
}

/** The hash of an action's definition, as an index entry's `definitionHash` carries it. */
export function definitionHash(action: OUIAction): string {
  return fnv1a64(sortedJson(action));
}

/** An action's index entry (§7.3.8). */
export function indexEntry(action: OUIAction): OUIActionIndexEntry {
  return {
    id: action.id,
    ...(action.title ? { title: action.title } : {}),
    description: firstSentence(
      withoutTitleLeadIn(action.description, action.title),
    ),
    ...(action.effect !== undefined ? { effect: action.effect } : {}),
    ...(action.confirm ? { confirm: true } : {}),
    ...(action.async ? { async: true } : {}),
    ...(action.estimatedDuration
      ? { estimatedDuration: action.estimatedDuration }
      : {}),
    ...(action.polling?.maxDurationMs !== undefined
      ? { maxDurationMs: action.polling.maxDurationMs }
      : {}),
    input: summarizeInput(action.input),
    definitionHash: definitionHash(action),
    definitionBytes: jsonBytes(action),
  };
}

/** A surface in index form (§7.3.8). */
export function surfaceIndex(surface: OUISurface): OUISurfaceIndex {
  return {
    id: surface.id,
    name: surface.name,
    description: surface.description,
    ...(surface.version !== undefined ? { version: surface.version } : {}),
    ...(surface.observations ? { observations: surface.observations } : {}),
    index: surface.actions.map(indexEntry),
  };
}

/**
 * An action input that takes a file the person attached (OUI spec §7.3.11,
 * ADR-0252 §2.13).
 *
 * The agent passes an attachment's id. The client resolves it, through its
 * host's file area, to what the input declares it takes, before the action's
 * handler runs:
 *
 * - `file`: a `File`, exactly what the person's own file choice produces;
 * - `text`: the file's text, for an input that takes markup or JSON.
 *
 * Declared on a string schema:
 * `{ type: 'string', format: 'oui-attachment', 'x-oui-attachment': { as: 'file', mediaTypes: ['image/png'] } }`.
 * The request stays small: only the id travels.
 */
import type { JSONSchema } from "./types.js";

/** The JSON Schema `format` of an input that takes an attachment's id. */
export const OUI_ATTACHMENT_FORMAT = "oui-attachment";

/** What an attachment input takes once resolved, and which files it accepts. */
export interface OUIAttachmentInput {
  as: "file" | "text";
  /** The media types it accepts; any when absent. A type ending in `/*` accepts the family. */
  mediaTypes?: string[];
}

/** Whether a string is an attachment id: opaque, 8 to 64 of A–Z, a–z, 0–9, `_` and `-`. */
export function isAttachmentId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(value);
}

/** The same rule as a pattern, for a validator's format. */
export const ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** The attachment declaration of a schema, when it is an attachment input. */
export function attachmentInputOf(
  schema: JSONSchema | undefined,
): OUIAttachmentInput | null {
  if (!schema || schema.format !== OUI_ATTACHMENT_FORMAT) return null;
  const declared = schema["x-oui-attachment"] as
    Partial<OUIAttachmentInput> | undefined;
  const as = declared?.as === "text" ? "text" : "file";
  const mediaTypes = Array.isArray(declared?.mediaTypes)
    ? declared.mediaTypes.filter((t): t is string => typeof t === "string")
    : undefined;
  return { as, ...(mediaTypes?.length ? { mediaTypes } : {}) };
}

/** Whether a media type is one an attachment input accepts. */
export function acceptsMediaType(
  input: OUIAttachmentInput,
  mediaType: string,
): boolean {
  if (!input.mediaTypes?.length) return true;
  const type = mediaType.split(";")[0].trim().toLowerCase();
  return input.mediaTypes.some((accepted) => {
    const a = accepted.toLowerCase();
    return a.endsWith("/*") ? type.startsWith(a.slice(0, -1)) : a === type;
  });
}

/**
 * Every attachment input of an action's input schema, by where its id sits in
 * the params: a property (`["logo"]`), or each item of a list property
 * (`["images", "*"]`). Only the input's own properties and their list items
 * are looked at: a file is an argument of the action, not buried in its data.
 */
export function attachmentInputs(
  schema: JSONSchema | undefined,
): Array<{ path: [string] | [string, "*"]; input: OUIAttachmentInput }> {
  const found: Array<{
    path: [string] | [string, "*"];
    input: OUIAttachmentInput;
  }> = [];
  for (const [name, property] of Object.entries(schema?.properties ?? {})) {
    const direct = attachmentInputOf(property);
    if (direct) {
      found.push({ path: [name], input: direct });
      continue;
    }
    const item =
      property.type === "array" ? attachmentInputOf(property.items) : null;
    if (item) found.push({ path: [name, "*"], input: item });
  }
  return found;
}

/** Every attachment id an action's params name, with the input that takes it. */
export function attachmentIdsIn(
  schema: JSONSchema | undefined,
  params: Record<string, unknown>,
): Array<{ id: string; property: string; input: OUIAttachmentInput }> {
  const ids: Array<{
    id: string;
    property: string;
    input: OUIAttachmentInput;
  }> = [];
  for (const { path, input } of attachmentInputs(schema)) {
    const value = params[path[0]];
    const values =
      path.length === 2 ? (Array.isArray(value) ? value : []) : [value];
    for (const v of values)
      if (typeof v === "string") ids.push({ id: v, property: path[0], input });
  }
  return ids;
}

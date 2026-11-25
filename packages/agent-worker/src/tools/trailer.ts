/**
 * The note trailer: an answerless tool the model writes into its response, as
 * text after its reply, instead of calling it.
 *
 * An answerless tool (`RegisteredTool.answerless`) ends a turn on the step
 * that writes the reply and makes only answerless calls. Some models (Claude
 * Sonnet 5.5 and Opus 5.5) make such a call alone, in a step of its own: a
 * response ends at the tool call (`stop_reason: tool_use`), so no text can
 * follow it, and the reply then costs one more model call that reads the
 * whole conversation again. No wording of the prompt changed that. A trailer
 * is text, so it never ends a response: the reply and the note arrive in one.
 *
 * - **What is sent.** A trailer tool's definition is not sent to the provider
 *   (`trailerParams`): the step's system prompt teaches the trailer instead
 *   (`trailerRule`), generated from the tool's own description and schema. The
 *   tool stays one of `ai`'s, so the call the trailer becomes runs as any call.
 * - **What is read.** The model's text passes through `createTrailerStream`,
 *   which cuts each `<oui:name>{json}</oui:name>` out of it and gives `ai` a
 *   tool call in its place. Nothing of a trailer reaches the reply: not the
 *   room's tokens, a voice, a round's end, the stored text or an eval.
 * - **What is stored.** Exactly what a step that wrote its reply and called the
 *   tool stores: the reply as the step's text, the call, its result.
 * - **What is sent again.** A trailer tool's call, in any prompt (a step's, or
 *   a later turn's history), is written back as the text the model was taught
 *   (`asTrailers`), so no prompt names a tool its request does not declare.
 *
 * A host opts in per tool (`RegisteredTool.trailer`); a host that does not is
 * given exactly what it was before: no transform, no rule, no rewrite.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '@ouispec/agent-core';
import { effectKind, requiresApproval } from '@ouispec/bindings';
import type { RegisteredTool } from './types.js';
import type { ToolRule } from '../prompt/step-tools.js';

/** Every call a trailer becomes has an id that starts with this. */
export const TRAILER_CALL_ID_PREFIX = 'oui_trailer_';

/** A trailer tool's name: what its tags are written with. */
export const TRAILER_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,40}$/;

/** The most trailers one response may carry. Every one past it is read as one that could not be read. */
export const MAX_TRAILERS_PER_STEP = 5;

/**
 * The most characters one trailer's JSON may take. A note is a line: a
 * product's note tool takes a few hundred characters at most, and even with
 * every field at its limit and every character escaped it stays well under
 * this. A trailer past it is read as one that could not be read, and nothing
 * of it is kept or shown.
 */
export const MAX_TRAILER_CHARS = 4_096;

/** The effects a trailer tool may declare: what changes nothing beyond one undo step of the chat's own record. */
const TRAILER_EFFECTS: ReadonlySet<string> = new Set(['view', 'selection', 'navigate', 'open', 'edit']);

export const trailerOpener = (name: string): string => `<oui:${name}>`;
export const trailerCloser = (name: string): string => `</oui:${name}>`;
/** How a trailer that was not written is shown again, in place of the note. */
const failedOpener = (name: string): string => `<oui:${name}-failed>`;
const failedCloser = (name: string): string => `</oui:${name}-failed>`;

/** Whether a call id is one a trailer became. */
export const isTrailerCallId = (id: string | undefined | null): boolean => typeof id === 'string' && id.startsWith(TRAILER_CALL_ID_PREFIX);

/**
 * The id of the `index`th trailer (from 0) of a step. It is made from the
 * step's number in the turn, the trailer's place in the step, and a digest
 * of the request the step sent: the same request gives the same ids, so a
 * replayed turn stores exactly what its recording did, and no two steps of a
 * conversation share one (a conversation's call ids are its results' keys).
 */
export function trailerCallId(requestDigest: string, step: number, index: number): string {
  return `${TRAILER_CALL_ID_PREFIX}${requestDigest}_${step}_${index}`;
}

/**
 * The digest of a request a step's trailer ids are made from: the same
 * request, the same digest. It is taken over the prompt's structure, each
 * value framed by its kind and length, and never builds the prompt as text:
 * a file or image part's bytes (a `Uint8Array`, which `JSON.stringify` writes
 * as an object of one key per byte) are fed to the hash as they are, so a
 * step that carries an attachment of several megabytes costs one pass over
 * its bytes and no copy of them.
 */
export function requestDigest(prompt: unknown): string {
  const hash = createHash('sha256');
  feedDigest(hash, prompt);
  return hash.digest('hex').slice(0, 12);
}

/** Feeds a value to the hash, framed so no two different values feed the same bytes. */
function feedDigest(hash: ReturnType<typeof createHash>, value: unknown): void {
  if (value === undefined) return void hash.update('u');
  if (value === null) return void hash.update('n');
  if (value instanceof Uint8Array || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    const bytes =
      value instanceof Uint8Array
        ? value
        : value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    hash.update(`b${bytes.byteLength}:`);
    hash.update(bytes);
    return;
  }
  switch (typeof value) {
    case 'string':
      hash.update(`s${value.length}:`);
      hash.update(value);
      return;
    case 'number':
    case 'boolean':
    case 'bigint':
      hash.update(`${typeof value}:${String(value)};`);
      return;
    case 'function':
    case 'symbol':
      return void hash.update('u');
  }
  if (value instanceof URL) return feedDigest(hash, `url:${value.href}`);
  if (value instanceof Date) return feedDigest(hash, `date:${value.toISOString()}`);
  if (Array.isArray(value)) {
    hash.update(`[${value.length}:`);
    for (const item of value) feedDigest(hash, item);
    hash.update(']');
    return;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  hash.update(`{${entries.length}:`);
  for (const [key, v] of entries) {
    feedDigest(hash, key);
    feedDigest(hash, v);
  }
  hash.update('}');
}

// ─── Which tools may be trailers ───────────────────────────────────────────

/**
 * Why a tool cannot be a trailer, or null. Text the model copies from a page
 * can hold a trailer, so only a tool that changes nothing anyone else depends
 * on may be one: answerless, never destructive, never approved, and of an
 * effect no further than `edit`.
 */
export function trailerToolProblem(tool: RegisteredTool): string | null {
  const flag: unknown = tool.trailer;
  if (flag === undefined || flag === false) return null;
  if (flag !== true) return `trailer is true or false, not ${JSON.stringify(flag)}`;
  if (tool.answerless !== true) return 'a trailer tool is answerless (answerless: true): its answer is never read';
  if (!TRAILER_TOOL_NAME.test(tool.name)) return `its name must match ${TRAILER_TOOL_NAME}, as its tags are written with it`;
  const schema = tool.inputSchema as { type?: unknown } | undefined;
  if (!schema || typeof schema !== 'object' || schema.type !== 'object') return 'its input schema is an object schema (type: "object"): a trailer holds a JSON object';
  if (tool.kind === 'ui') return 'a UI action is never a trailer';
  if (tool.effect === undefined) return 'it declares its effect, at most "edit": a tool that declares none is a write';
  if (!TRAILER_EFFECTS.has(effectKind(tool.effect))) return `its effect is at most "edit", not "${effectKind(tool.effect)}"`;
  if (tool.destructive === true) return 'a destructive tool is never a trailer';
  if (requiresApproval(tool.effect, tool.destructive)) return 'a tool that needs approval is never a trailer';
  return null;
}

/**
 * Refuses the tools unless every trailer among them can be one, and the model
 * is one the worker wraps (a model named by its id is not, so its text could
 * not be read for trailers). Called when the adapter is created, for a list,
 * and when a resolver gives a turn its tools.
 */
export function assertTrailerTools(tools: readonly RegisteredTool[], model: unknown): void {
  const problems = tools.map((t) => [t.name, trailerToolProblem(t)] as const).filter(([, problem]) => problem !== null);
  if (problems.length > 0) {
    throw new Error(`[agent-sdk] A trailer tool cannot be one: ${problems.map(([name, problem]) => `"${name}": ${problem}`).join('; ')}`);
  }
  const trailers = tools.filter((t) => t.trailer === true);
  if (trailers.length > 0 && typeof model === 'string') {
    throw new Error(
      `[agent-sdk] ${trailers.map((t) => `"${t.name}"`).join(', ')} ${trailers.length === 1 ? 'is a trailer' : 'are trailers'}, ` +
        'which need a model object (an `ai` provider model), not a model id: a model named by its id is not wrapped, so its trailers could not be read',
    );
  }
}

/** The names of the trailer tools among these. */
export function trailerToolNames(tools: readonly RegisteredTool[]): string[] {
  return tools.filter((t) => t.trailer === true).map((t) => t.name);
}

// ─── What the model is told ────────────────────────────────────────────────

type JsonSchemaLike = {
  type?: unknown;
  enum?: unknown;
  const?: unknown;
  description?: unknown;
  properties?: Record<string, JsonSchemaLike>;
  required?: unknown;
  items?: unknown;
  minimum?: unknown;
};

/** What a field's value is, in a few words. */
function fieldKind(schema: JsonSchemaLike): string {
  if (Array.isArray(schema.enum)) return `one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`;
  if (schema.const !== undefined) return `always ${JSON.stringify(schema.const)}`;
  switch (schema.type) {
    case 'string':
      return 'text';
    case 'integer':
      return 'a whole number';
    case 'number':
      return 'a number';
    case 'boolean':
      return 'true or false';
    case 'array':
      return 'a list';
    case 'object':
      return 'an object';
    default:
      return 'any JSON value';
  }
}

/** A value of the field's kind, for the example. */
function exampleValue(schema: JsonSchemaLike): unknown {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;
  switch (schema.type) {
    case 'string':
      return '…';
    case 'integer':
    case 'number':
      return typeof schema.minimum === 'number' ? schema.minimum : 0;
    case 'boolean':
      return true;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return null;
  }
}

/** JSON as the trailer is written and written back: canonical (keys in order, no spaces). */
function trailerJson(value: unknown): string {
  try {
    return canonicalJson(value);
  } catch {
    return JSON.stringify(value) ?? 'null';
  }
}

/**
 * The trailer the tool's schema makes an example of: its required fields, or,
 * when it requires none, its first two.
 */
export function trailerExample(tool: RegisteredTool): string {
  const schema = tool.inputSchema as JsonSchemaLike;
  const properties = schema.properties ?? {};
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]).filter((k): k is string => typeof k === 'string' && k in properties) : [];
  const shown = required.length > 0 ? required : Object.keys(properties).slice(0, 2);
  return trailerJson(Object.fromEntries(shown.map((key) => [key, exampleValue(properties[key])])));
}

/** The tool's fields, with what each is and its description. */
function trailerFields(tool: RegisteredTool): string {
  const schema = tool.inputSchema as JsonSchemaLike;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as unknown[]) : []);
  const fields = Object.entries(schema.properties ?? {}).map(([key, field]) => {
    const kind = `${fieldKind(field)}${required.has(key) ? ', required' : ''}`;
    const description = typeof field.description === 'string' && field.description.trim() ? `: ${field.description.trim()}` : '';
    return `\`${key}\` (${kind})${description}`;
  });
  return fields.length > 0 ? fields.join('; ') : 'no fields';
}

/**
 * What a step that offers the tool is told of it, in its system prompt, in
 * place of the definition it is not sent: generated from the tool's own
 * description and schema, so it is the same on every step and every turn
 * that offers it, and stays in the cached prefix.
 */
export function trailerRule(tool: RegisteredTool): ToolRule {
  const { name } = tool;
  const open = trailerOpener(name);
  const close = trailerCloser(name);
  return {
    tools: [name],
    text:
      `\n\n## NOTES: \`${name}\`\n` +
      `${tool.description.trim()}\n` +
      `\`${name}\` is not a tool you call: write each note inside your response, after your reply, as \`${open}${trailerExample(tool)}${close}\`, ` +
      `one per note, a JSON object with: ${trailerFields(tool)}. ` +
      `At most ${MAX_TRAILERS_PER_STEP} in a response, each under ${MAX_TRAILER_CHARS.toLocaleString('en-US')} characters.\n` +
      'Write it in the response that writes the reply it belongs to, never instead of a reply. ' +
      'It is removed before anything is shown or spoken, so write it on a spoken turn too. ' +
      `A note that could not be written shows after its reply as \`${failedOpener(name)}why${failedCloser(name)}\`: write it again, correctly, in your next reply.`,
  };
}

/** What a trailer that could not be read is answered with: it did not run, and no note was written. */
export function unreadableTrailerError(name: string, cause: string): string {
  return `Invalid input for tool ${name}: the ${name} trailer could not be read (${cause}), so no ${name} was written. Write it again at the end of your reply.`;
}

/** What a call to a trailer tool its step does not take is answered with: it is written, never called. */
export function trailerNotTakenError(name: string): string {
  return (
    `"${name}" is written as a trailer after your reply (${trailerOpener(name)}{…}${trailerCloser(name)}), never called as a tool, ` +
    'and this step does not take one: nothing was written and nothing was shown to the user. Carry on with the tools you have, or answer in words.'
  );
}

// ─── Reading the model's stream ────────────────────────────────────────────

/** A part of a model's stream, as `ai`'s language model specification gives it. Only what the transform reads is named. */
export interface StreamPartLike {
  type: string;
  id?: string;
  delta?: string;
  finishReason?: { unified: string; raw: string | undefined } | string;
  [key: string]: unknown;
}

/** A trailer read from the stream: the call it becomes. `cause` is set when it could not be read. */
export interface ReadTrailer {
  toolCallId: string;
  toolName: string;
  input: string;
  cause?: string;
}

interface Block {
  mode: 'text' | 'opening' | 'inside';
  /** Whitespace held in `text` mode: given out before the next visible character, dropped before an opener. */
  space: string;
  /** In `opening`: the characters that may be an opener. */
  held: string;
  /** In `inside`: the trailer tool, its body so far, and where the next closer is looked for. */
  tool: string;
  body: string;
  searchFrom: number;
  /** In `inside`: where the body first held a closer, when its JSON did not end there. */
  firstCloser: number;
  /** The body went past its limit: only enough of its end is kept to find the closer. */
  overflow: boolean;
  /** Whether the block has given out a visible character: whitespace after a trailer that opens it is not the reply's. */
  shown: boolean;
  /** Whether a trailer has been cut from the block. */
  cut: boolean;
  /** The `text-start` given out, once there is text to give: a block that is all trailer gives none. */
  started: boolean;
  start: StreamPartLike;
}

/**
 * The transform a step's stream goes through: every trailer of a trailer tool
 * cut out of its text, and given to `ai` as that tool's call.
 *
 * Per text block it is in `text`, `opening` or `inside`:
 * - `text`: passes text through, holding whitespace back until a visible
 *   character follows it, and stops at `<`.
 * - `opening`: holds characters while they begin an opener, never more than
 *   one; as soon as they cannot, they are given out and read again
 *   (`<laugh>` is given out at its second character). A whole opener drops
 *   the whitespace before it.
 * - `inside`: holds everything to the closer. A body that is not yet JSON
 *   where a closer appears goes on to the next one (a closer inside one of its
 *   strings). Text after the trailer is the reply again.
 *
 * At the block's end, a partial opener and held whitespace are given out; a
 * trailer still open is one that could not be read, and nothing of it is.
 * Each call is given out before the stream's first tool input, tool call or
 * finish; with any, the finish says `tool-calls` (a step cut off at its
 * output limit still says `length`). Every other part passes untouched.
 */
export function createTrailerStream<P extends { type: string }>(options: {
  tools: readonly string[];
  /** The id of the step's `index`th trailer. */
  callId: (index: number) => string;
  /** Told of every trailer read, as it is. */
  onTrailer?: (trailer: ReadTrailer) => void;
}): TransformStream<P, P> {
  const openers = options.tools.map((tool) => ({ tool, opener: trailerOpener(tool) }));
  const longestOpener = Math.max(...openers.map((o) => o.opener.length));
  const blocks = new Map<string, Block>();
  const queued: ReadTrailer[] = [];
  let read = 0;
  let injected = 0;

  const blockOf = (part: StreamPartLike): Block => {
    const id = part.id ?? '';
    let block = blocks.get(id);
    if (!block) {
      block = {
        mode: 'text',
        space: '',
        held: '',
        tool: '',
        body: '',
        searchFrom: 0,
        firstCloser: -1,
        overflow: false,
        shown: false,
        cut: false,
        started: false,
        start: { type: 'text-start', id },
      };
      blocks.set(id, block);
    }
    return block;
  };

  const queue = (tool: string, input: string, cause?: string) => {
    const index = read++;
    const trailer: ReadTrailer = {
      toolCallId: options.callId(index),
      toolName: tool,
      // Input that could not be read is given as what no JSON reader takes, so the call is one that did not run.
      input: cause ? `${trailerOpener(tool)}${input.slice(0, MAX_TRAILER_CHARS)}` : input,
      ...(cause ? { cause } : {}),
    };
    queued.push(trailer);
    options.onTrailer?.(trailer);
  };

  /** A trailer whose body ended: a call, or, past a limit, one that could not be read. */
  const closed = (tool: string, body: string) => {
    if (body.length > MAX_TRAILER_CHARS) queue(tool, '', `longer than ${MAX_TRAILER_CHARS.toLocaleString('en-US')} characters`);
    else if (read >= MAX_TRAILERS_PER_STEP) queue(tool, body, `more than ${MAX_TRAILERS_PER_STEP} in one response`);
    else queue(tool, body);
  };

  /** Feeds text into a block; returns what is given out. */
  const feed = (block: Block, text: string): string => {
    let out = '';
    let rest = text;
    while (rest.length > 0) {
      if (block.mode === 'text') {
        let i = 0;
        while (i < rest.length && rest[i] !== '<') {
          const ch = rest[i];
          if (/\s/.test(ch)) block.space += ch;
          else {
            // Whitespace between a trailer the block opens with and the reply after it is neither's.
            out += (block.cut && !block.shown ? '' : block.space) + ch;
            block.space = '';
            block.shown = true;
          }
          i++;
        }
        rest = rest.slice(i);
        if (rest.length > 0) {
          block.mode = 'opening';
          block.held = '';
        }
        continue;
      }
      if (block.mode === 'opening') {
        block.held += rest[0];
        rest = rest.slice(1);
        const whole = openers.find((o) => o.opener === block.held);
        if (whole) {
          // A trailer: the whitespace before it is not the reply's.
          block.space = '';
          block.cut = true;
          block.mode = 'inside';
          block.tool = whole.tool;
          block.body = '';
          block.searchFrom = 0;
          block.firstCloser = -1;
          block.overflow = false;
          continue;
        }
        if (!openers.some((o) => o.opener.startsWith(block.held)) || block.held.length >= longestOpener) {
          // Not an opener: its first character is text, and the rest is read again.
          out += (block.cut && !block.shown ? '' : block.space) + block.held[0];
          block.space = '';
          block.shown = true;
          rest = block.held.slice(1) + rest;
          block.held = '';
          block.mode = 'text';
        }
        continue;
      }
      // inside
      const closer = trailerCloser(block.tool);
      block.body += rest;
      rest = '';
      if (block.overflow) {
        const at = block.body.indexOf(closer);
        if (at === -1) {
          block.body = block.body.slice(-(closer.length - 1));
          continue;
        }
        const after = block.body.slice(at + closer.length);
        queue(block.tool, '', `longer than ${MAX_TRAILER_CHARS.toLocaleString('en-US')} characters`);
        block.mode = 'text';
        block.body = '';
        rest = after;
        continue;
      }
      for (;;) {
        const at = block.body.indexOf(closer, block.searchFrom);
        if (at === -1) break;
        const candidate = block.body.slice(0, at);
        if (isJson(candidate)) {
          const after = block.body.slice(at + closer.length);
          closed(block.tool, candidate);
          block.mode = 'text';
          block.body = '';
          rest = after;
          break;
        }
        if (block.firstCloser === -1) block.firstCloser = at;
        block.searchFrom = at + 1;
      }
      if (block.mode === 'inside' && block.body.length > MAX_TRAILER_CHARS + closer.length) {
        block.overflow = true;
        block.body = block.body.slice(-(closer.length - 1));
      }
    }
    return out;
  };

  /** The end of a block: a partial opener and held whitespace are text; an open trailer could not be read. */
  const end = (block: Block): string => {
    let out = '';
    if (block.mode === 'opening') {
      out += (block.cut && !block.shown ? '' : block.space) + block.held;
      block.space = '';
      block.held = '';
      block.shown = true;
    } else if (block.mode === 'inside') {
      if (block.overflow) {
        queue(block.tool, '', `longer than ${MAX_TRAILER_CHARS.toLocaleString('en-US')} characters`);
      } else if (block.firstCloser !== -1) {
        // Closed, but what it closed is not JSON: the trailer ends at its first closer, and what follows is text again.
        const closer = trailerCloser(block.tool);
        const body = block.body.slice(0, block.firstCloser);
        const after = block.body.slice(block.firstCloser + closer.length);
        queue(block.tool, body, read >= MAX_TRAILERS_PER_STEP ? `more than ${MAX_TRAILERS_PER_STEP} in one response` : 'its JSON could not be read');
        block.mode = 'text';
        block.body = '';
        return feed(block, after) + end(block);
      } else {
        queue(block.tool, block.body, `it was not closed with ${trailerCloser(block.tool)}`);
      }
      block.body = '';
    }
    block.mode = 'text';
    out += block.space;
    block.space = '';
    return out;
  };

  /**
   * The provider metadata of parts the cut leaves nothing of (a text delta that
   * was all trailer, the start and end of a block that was): a provider may
   * carry what a response needs on any part (a signature, an id), so it is
   * never dropped. It rides on the next text part, tool call or finish given
   * out, under it: what that part carries itself wins on the same key.
   */
  let carried: Metadata | undefined;
  const carry = (meta: unknown) => {
    if (meta && typeof meta === 'object') carried = mergeMetadata(carried, meta as Metadata);
  };
  const put = (controller: TransformStreamDefaultController<P>, part: StreamPartLike) => {
    if (carried && CARRIES_METADATA.has(part.type)) {
      part = { ...part, providerMetadata: mergeMetadata(carried, part.providerMetadata as Metadata | undefined) };
      carried = undefined;
    }
    controller.enqueue(part as unknown as P);
  };

  const giveOut = (controller: TransformStreamDefaultController<P>) => {
    while (queued.length > 0) {
      const trailer = queued.shift()!;
      injected++;
      put(controller, { type: 'tool-call', toolCallId: trailer.toolCallId, toolName: trailer.toolName, input: trailer.input });
    }
  };

  const emitText = (controller: TransformStreamDefaultController<P>, block: Block, id: string, text: string, part?: StreamPartLike) => {
    if (!text) {
      carry(part?.providerMetadata);
      return;
    }
    if (!block.started) {
      block.started = true;
      put(controller, block.start);
    }
    put(controller, part ? { ...part, delta: text } : { type: 'text-delta', id, delta: text });
  };

  return new TransformStream<P, P>({
    transform(given, controller) {
      const part = given as unknown as StreamPartLike;
      switch (part.type) {
        case 'text-start': {
          const block = blockOf(part);
          block.start = part;
          return;
        }
        case 'text-delta': {
          const block = blockOf(part);
          emitText(controller, block, part.id ?? '', feed(block, typeof part.delta === 'string' ? part.delta : ''), part);
          return;
        }
        case 'text-end': {
          const block = blockOf(part);
          emitText(controller, block, part.id ?? '', end(block));
          if (block.started) put(controller, part);
          else {
            // A block that was all trailer gives neither its start nor its end: their metadata rides on.
            carry(block.start.providerMetadata);
            carry(part.providerMetadata);
          }
          blocks.delete(part.id ?? '');
          return;
        }
        case 'tool-input-start':
        case 'tool-call':
          giveOut(controller);
          put(controller, part);
          return;
        case 'finish': {
          giveOut(controller);
          const reason = part.finishReason;
          if (injected > 0 && reason && typeof reason === 'object' && (reason.unified === 'stop' || reason.unified === 'other')) {
            put(controller, { ...part, finishReason: { ...reason, unified: 'tool-calls' } });
          } else {
            put(controller, part);
          }
          return;
        }
        default:
          controller.enqueue(given);
      }
    },
  });
}

/** A part's provider metadata: per provider, its fields. */
type Metadata = Record<string, unknown>;

/** The parts carried metadata rides on: those that carry the text's, and the calls and finish that follow it. */
const CARRIES_METADATA: ReadonlySet<string> = new Set(['text-start', 'text-delta', 'text-end', 'tool-call', 'finish']);

/** `under` with `over` on top: per provider, `over`'s fields win. */
function mergeMetadata(under: Metadata | undefined, over: Metadata | undefined): Metadata {
  const merged: Metadata = { ...(under ?? {}) };
  for (const [provider, fields] of Object.entries(over ?? {})) {
    const held = merged[provider];
    merged[provider] =
      held && typeof held === 'object' && !Array.isArray(held) && fields && typeof fields === 'object' && !Array.isArray(fields)
        ? { ...(held as Metadata), ...(fields as Metadata) }
        : fields;
  }
  return merged;
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

// ─── Writing calls back as trailers ────────────────────────────────────────

type PartLike = { type: string; [key: string]: unknown };
type MessageLike = { role: string; content: unknown; [key: string]: unknown };

/** What a call's result says: whether its tool wrote what it was given, and, when not, why. */
function resultOf(part: PartLike): { ok: true } | { ok: false; why: string } {
  const output = part.output as { type?: string; value?: unknown } | undefined;
  const raw =
    output?.type === 'content' && Array.isArray(output.value)
      ? (output.value as PartLike[]).map((p) => (typeof p.text === 'string' ? p.text : '')).join('')
      : output?.value;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
  }
  const why = (v: unknown): string => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object' && typeof (v as { error?: unknown }).error === 'string') return (v as { error: string }).error;
    if (v && typeof v === 'object' && typeof (v as { message?: unknown }).message === 'string') return (v as { message: string }).message;
    return typeof raw === 'string' ? raw : (JSON.stringify(raw) ?? 'it did not run');
  };
  if (output?.type?.startsWith('error') || output?.type === 'execution-denied') return { ok: false, why: why(value) };
  // A tool that wrote what it was given answers with an object of its own; every failure the worker stores is a
  // string, or says `success: false`, `notRun` or an `error`.
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, why: why(value) };
  const v = value as { success?: unknown; notRun?: unknown; error?: unknown };
  if (v.success === false || v.notRun === true || typeof v.error === 'string') return { ok: false, why: why(value) };
  return { ok: true };
}

/**
 * The messages with every call of a trailer tool written back as the text the
 * model was taught: after the message's text, `<oui:note>{its input}</oui:note>`
 * for a call whose tool wrote it, and `<oui:note-failed>why</oui:note-failed>`
 * for one that was not written; its result is taken out. The input is written
 * as canonical JSON, one trailer per line, so the same call is the same bytes
 * wherever it is sent: in a step of its turn, in every later turn's history.
 *
 * A message that would then say nothing but its trailers, and is followed by
 * no message but its results (a step's own request, right after a response
 * that wrote only a trailer), keeps its calls: a request never ends on the
 * model's own words. A call with no result is kept too. Pure, and idempotent:
 * what it writes back holds no call to write back again.
 */
export function asTrailers<M extends MessageLike>(messages: readonly M[], trailerTools: readonly string[] | ReadonlySet<string>): M[] {
  const tools = trailerTools instanceof Set ? (trailerTools as ReadonlySet<string>) : new Set(trailerTools as readonly string[]);
  if (tools.size === 0) return messages as M[];
  const results = new Map<string, PartLike>();
  for (const m of messages) {
    if (m.role !== 'tool' || !Array.isArray(m.content)) continue;
    for (const part of m.content as PartLike[]) {
      if (part.type === 'tool-result' && typeof part.toolCallId === 'string' && !results.has(part.toolCallId)) results.set(part.toolCallId, part);
    }
  }
  const rewritten = new Set<string>();
  const out: M[] = messages.map((m, at) => {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return m;
    const parts = m.content as PartLike[];
    const trailers = parts.filter(
      (p) => p.type === 'tool-call' && typeof p.toolName === 'string' && tools.has(p.toolName) && typeof p.toolCallId === 'string' && results.has(p.toolCallId),
    );
    if (trailers.length === 0) return m;
    const ownText = parts.some((p) => p.type === 'text' && typeof p.text === 'string' && p.text.trim() !== '');
    const otherCalls = parts.some((p) => p.type === 'tool-call' && !trailers.includes(p));
    const followed = messages.slice(at + 1).some((n) => n.role !== 'tool');
    if (!ownText && !otherCalls && !followed) return m;
    const written = trailers
      .map((p) => {
        const name = p.toolName as string;
        const result = resultOf(results.get(p.toolCallId as string)!);
        return result.ok ? `${trailerOpener(name)}${trailerJson(p.input)}${trailerCloser(name)}` : `${failedOpener(name)}${result.why}${failedCloser(name)}`;
      })
      .join('\n');
    for (const p of trailers) rewritten.add(p.toolCallId as string);
    const kept = parts.filter((p) => !trailers.includes(p));
    const lastText = kept.map((p) => p.type).lastIndexOf('text');
    let content: PartLike[];
    if (lastText !== -1 && ownText) {
      content = kept.map((p, i) => (i === lastText ? { ...p, text: `${p.text as string}\n\n${written}` } : p));
    } else {
      // No words of its own: the trailers are its text, after any reasoning it opens with.
      const withoutEmpty = kept.filter((p) => !(p.type === 'text' && typeof p.text === 'string' && p.text.trim() === ''));
      const at = withoutEmpty.findIndex((p) => p.type !== 'reasoning');
      const place = at === -1 ? withoutEmpty.length : at;
      content = [...withoutEmpty.slice(0, place), { type: 'text', text: written }, ...withoutEmpty.slice(place)];
    }
    return { ...m, content } as M;
  });
  if (rewritten.size === 0) return out;
  return out.flatMap((m) => {
    if (m.role !== 'tool' || !Array.isArray(m.content)) return [m];
    const parts = m.content as PartLike[];
    if (!parts.some((p) => p.type === 'tool-result' && rewritten.has(p.toolCallId as string))) return [m];
    const kept = parts.filter((p) => !(p.type === 'tool-result' && rewritten.has(p.toolCallId as string)));
    return kept.length === 0 ? [] : [{ ...m, content: kept } as M];
  });
}

// ─── The request a step sends ──────────────────────────────────────────────

type ToolLike = { type?: string; name?: string };
type CallOptionsLike = { prompt: readonly MessageLike[]; tools?: readonly ToolLike[]; toolChoice?: { type: string; toolName?: string } };

/** The names of the tools a prompt's calls and results name. */
function namedTools(prompt: readonly MessageLike[]): { names: Set<string>; any: boolean } {
  const names = new Set<string>();
  let any = false;
  for (const m of prompt) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as PartLike[]) {
      if (part.type !== 'tool-call' && part.type !== 'tool-result') continue;
      any = true;
      if (typeof part.toolName === 'string') names.add(part.toolName);
    }
  }
  return { names, any };
}

/**
 * The request a step sends, with its trailer tools taught rather than
 * declared: their calls in its prompt written back as trailers
 * (`asTrailers`), and their definitions left out of its tools. A definition
 * is kept only where the request would otherwise be refused or changed: when
 * its prompt still names the tool (a call kept by `asTrailers`), or when the
 * trailer tools are the request's only tools and its prompt holds other tool
 * calls (Bedrock drops every tool call and result from a request that declares
 * no tool, and Anthropic refuses one). A choice that forces a trailer tool
 * whose definition is left out is sent as `auto`.
 */
export function trailerParams<O extends CallOptionsLike>(params: O, trailerTools: readonly string[]): O {
  const names = new Set(trailerTools);
  const prompt = asTrailers(params.prompt, names);
  const isTrailer = (t: ToolLike) => (t.type === undefined || t.type === 'function') && typeof t.name === 'string' && names.has(t.name);
  const tools = params.tools ?? [];
  const others = tools.filter((t) => !isTrailer(t));
  const named = namedTools(prompt);
  const keep = new Set<string>();
  for (const t of tools) {
    if (!isTrailer(t)) continue;
    if (named.names.has(t.name!) || (others.length === 0 && named.any)) keep.add(t.name!);
  }
  const sent = tools.filter((t) => !isTrailer(t) || keep.has(t.name!));
  const choice = params.toolChoice;
  const forcedAway = choice?.type === 'tool' && typeof choice.toolName === 'string' && names.has(choice.toolName) && !keep.has(choice.toolName);
  return {
    ...params,
    prompt,
    ...(params.tools !== undefined ? { tools: sent } : {}),
    ...(forcedAway ? { toolChoice: { type: 'auto' } } : {}),
  };
}

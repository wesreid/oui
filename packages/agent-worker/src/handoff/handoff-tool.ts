/**
 * The hand-off tool: the character moves the call to the caller's phone
 *.
 *
 * The turn's `client.handoff.control` names studio-api's hand-offs route for
 * the session (H1, `POST /sessions/{sessionId}/handoffs`) and an `lhb1` token
 * for it. `call_handoff({ purpose })` calls it as the capture tools call
 * theirs: studio-api mints a single-use code, and the caller's LiveCall shows
 * it as a QR code on their screen. The route answers an `lhb1` caller without
 * the link, and the tool would drop one if it came: the model never gets the
 * code or the link, so it can never read one out.
 *
 * The result is the route's answer's `words` with the hand-off's id and
 * status. A refusal fails with a line chosen by its code, never the route's
 * own message. The token is never logged or emitted.
 */
import type { RegisteredTool, ToolExecutionResult } from '../tools/types.js';
import {
  CALL_HANDOFF_PURPOSES,
  CALL_HANDOFF_STATUSES,
  canHandoff,
  type CallHandoffPurpose,
  type CallHandoffStatus,
  type HandoffControl,
  type TurnHandoff,
} from '../prompt/handoff.js';

export const CALL_HANDOFF_TOOL = 'call_handoff';

/** The SDK's class for the hand-off tool, as a host's tool policy sees it. */
export const HANDOFF_TOOL_CLASS = 'handoff';

/** Limits on a hand-off call. */
export const HANDOFF_TOOL_LIMITS = {
  /** The longest words the tool gives the model. */
  wordsChars: 2_000,
  /** The longest `handoffId` read from an answer. */
  handoffIdChars: 128,
  /** How long a call may take: studio-api mints the code and sends it to the caller's screen. */
  timeoutMs: 15_000,
} as const;

/** The route's answer (the contract's `CallHandoff`), as far as the tool reads it. */
interface HandoffAnswer {
  handoffId: string;
  status: CallHandoffStatus;
  words: string;
}

/** A refusal's body: `{ code, message, details? }`, or the same under `error`. */
interface Refusal {
  status: number;
  code: string | null;
}

const HANDOFF_ID = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,${HANDOFF_TOOL_LIMITS.handoffIdChars - 1}}$`);

const fail = (error: string): ToolExecutionResult => ({ success: false, error });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Words the model is given: trimmed and bounded. */
function wordsOf(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim().slice(0, HANDOFF_TOOL_LIMITS.wordsChars);
}

function readAnswer(body: unknown): HandoffAnswer | null {
  if (!isPlainObject(body)) return null;
  const words = wordsOf(body.words);
  if (typeof body.handoffId !== 'string' || !HANDOFF_ID.test(body.handoffId) || !words) return null;
  if (!(CALL_HANDOFF_STATUSES as readonly unknown[]).includes(body.status)) return null;
  // Only these three: never `url`, which an API key's answer carries and the model must never have.
  return { handoffId: body.handoffId, status: body.status as CallHandoffStatus, words };
}

function readRefusal(status: number, body: unknown): Refusal {
  const outer = isPlainObject(body) ? body : {};
  const inner = isPlainObject(outer.error) ? outer.error : outer;
  return { status, code: typeof inner.code === 'string' ? inner.code : null };
}

/** The lines the hand-off contract gives a refusal, by code. */
export const HANDOFF_REFUSALS = {
  HANDOFF_UNAVAILABLE: "This call can't move to another device.",
  HANDOFF_UNSUPPORTED_CALL: "This call's app can't move to another device.",
  RATE_LIMITED: 'A code was offered several times already; ask them to use the one on their screen.',
  /** The call has ended: nothing to say. */
  SESSION_NOT_LIVE: 'The call has already ended. Say nothing about moving it.',
  NO_ACTIVE_DEVICE: "Their device isn't connected to the call right now, so it can't move yet. Wait until they're back, then offer it again.",
  NOT_ALLOWED: "This call can't move to another device right now. Go on without it.",
  FAILED: 'Moving the call failed just now. Go on; you may offer it again in a little while.',
} as const;

/** What the model is told of a refusal: a line chosen by its code (else its status), never the route's own words. */
function refusalLine(refusal: Refusal): string {
  switch (refusal.code) {
    case 'HANDOFF_UNAVAILABLE':
    case 'HANDOFF_UNSUPPORTED_CALL':
    case 'RATE_LIMITED':
    case 'SESSION_NOT_LIVE':
    case 'NO_ACTIVE_DEVICE':
      return HANDOFF_REFUSALS[refusal.code];
    case 'HANDOFF_TOKEN_WRONG_SESSION':
      return HANDOFF_REFUSALS.NOT_ALLOWED;
  }
  switch (refusal.status) {
    case 401:
    case 403:
      return HANDOFF_REFUSALS.NOT_ALLOWED;
    case 409:
      return HANDOFF_REFUSALS.HANDOFF_UNAVAILABLE;
    case 429:
      return HANDOFF_REFUSALS.RATE_LIMITED;
    default:
      return HANDOFF_REFUSALS.FAILED;
  }
}

/** The tool's description: when to offer, and that the code and link are never the model's. */
export const CALL_HANDOFF_DESCRIPTION =
  'Moves this live call to the caller’s phone: a QR code appears on their screen, they scan it with their phone’s camera, ' +
  'and the same conversation carries on there while this device pauses. ' +
  'Offer it when photos need a rear camera this device lacks, or when the caller would be better off on their phone, and call it once they agree. ' +
  'You never get the code or the link, and you never read one out: tell them to scan the code on their screen. ' +
  'A code works once, for 10 minutes; call this again only when they ask for a new one or it has expired.';

/**
 * Builds the turn's hand-off tool, bound to its control route and token: none
 * unless the turn has a route (`canHandoff`).
 */
export function handoffTool(handoff: TurnHandoff | null | undefined, options: { fetch?: typeof fetch } = {}): RegisteredTool[] {
  if (!canHandoff(handoff)) return [];
  const send = options.fetch ?? fetch;
  const control: HandoffControl = handoff.control;

  const offer: RegisteredTool = {
    name: CALL_HANDOFF_TOOL,
    toolClass: HANDOFF_TOOL_CLASS,
    kind: 'backend',
    effect: 'mutate',
    description: CALL_HANDOFF_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        purpose: {
          type: 'string',
          enum: [...CALL_HANDOFF_PURPOSES],
          description:
            "Why the call moves: 'photos' when a photo capture needs a phone's rear camera; 'caller_asked' when the caller asked to continue on their phone; 'other' otherwise.",
        },
      },
      required: ['purpose'],
      additionalProperties: false,
    },
    execute: async (input, ctx) => {
      const purpose = input.purpose;
      if (typeof purpose !== 'string' || !(CALL_HANDOFF_PURPOSES as readonly string[]).includes(purpose)) {
        return fail(`"purpose" is one of ${CALL_HANDOFF_PURPOSES.map((p) => `"${p}"`).join(', ')}.`);
      }
      if (Date.parse(control.expiresAt) <= Date.now()) return fail(HANDOFF_REFUSALS.NOT_ALLOWED);
      const timeout = AbortSignal.timeout(HANDOFF_TOOL_LIMITS.timeoutMs);
      const signal = ctx.abortSignal ? AbortSignal.any([ctx.abortSignal, timeout]) : timeout;
      let res: Response;
      try {
        res = await send(control.url, {
          method: 'POST',
          headers: { authorization: `Bearer ${control.token}`, accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ purpose: purpose as CallHandoffPurpose }),
          signal,
          redirect: 'error',
        });
      } catch (err) {
        // The turn's stop is said by the orchestrator; a timeout or a lost connection is said here.
        if (ctx.abortSignal?.aborted) throw err;
        return fail(HANDOFF_REFUSALS.FAILED);
      }
      // A body that is not JSON reads as no answer: a failure, or a refusal known only by its status.
      const parsed: unknown = await res.json().catch(() => null);
      if (!res.ok) return fail(refusalLine(readRefusal(res.status, parsed)));
      const answer = readAnswer(parsed);
      if (!answer) return fail(HANDOFF_REFUSALS.FAILED);
      return { success: true, data: { handoffId: answer.handoffId, status: answer.status, words: answer.words } };
    },
  };

  return [offer];
}

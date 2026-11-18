/**
 * The capture tools: the character asks the caller for the photos a client's
 * plan needs.
 *
 * The turn's `client.capture.control` names studio-api's captures route for
 * the session and an `lcb1` token for it. The tools call it as the look tool
 * calls its route:
 *
 * - `capture_start({ plan, resumeCaptureId? })`: `POST {url}`
 *   `{ plan, resumeCaptureId? }`. Closure's capture agent joins the call, the
 *   caller's screen asks for consent, and the capture's updates reach the
 *   brain later, as words (`capture` turns).
 * - `capture_status({})`: `GET {url}/{captureId}`, for the capture
 *   running now or the one this turn started.
 * - `capture_stop({ reason? })`: `POST {url}/{captureId}/stop`.
 *
 * Each result is the route's answer's `words` (one or two sentences) with the
 * capture's id and status. A refusal fails with a line chosen by its code,
 * never the route's own message. No tool returns a picture, and the token is
 * never logged or emitted.
 */
import type { RegisteredTool, ToolExecutionContext, ToolExecutionResult } from '../tools/types.js';
import {
  canCapture,
  resumableLines,
  CAPTURE_OUTCOMES,
  CAPTURE_STATUSES,
  type CaptureControl,
  type CaptureOutcome,
  type CaptureStatus,
  type TurnCapture,
} from '../prompt/capture.js';

export const CAPTURE_START_TOOL = 'capture_start';
export const CAPTURE_STATUS_TOOL = 'capture_status';
export const CAPTURE_STOP_TOOL = 'capture_stop';

/** The capture tools' names, in the order they are declared. */
export const CAPTURE_TOOLS = [CAPTURE_START_TOOL, CAPTURE_STATUS_TOOL, CAPTURE_STOP_TOOL] as const;

/** The SDK's class for the capture tools, as a host's tool policy sees it. */
export const CAPTURE_TOOL_CLASS = 'capture';

/** Limits on a capture call. */
export const CAPTURE_TOOL_LIMITS = {
  /** The longest `reason` a stop gives. */
  reasonChars: 200,
  /** The longest `resumeCaptureId`. */
  captureIdChars: 128,
  /** The longest words the tools give the model. */
  wordsChars: 2_000,
  /** How long a call may take: a start dispatches Closure's capture agent. */
  timeoutMs: 20_000,
} as const;

/** The route's answer (the contract's `LiveCaptureResult`), as far as the tools read it. */
interface CaptureAnswer {
  captureId: string;
  status: CaptureStatus;
  outcome: CaptureOutcome | null;
  words: string;
}

/** A refusal's body: `{ code, message, details? }`, or the same under `error`. */
interface Refusal {
  status: number;
  code: string | null;
  details: Record<string, unknown>;
}

const CAPTURE_ID = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,${CAPTURE_TOOL_LIMITS.captureIdChars - 1}}$`);

const fail = (error: string): ToolExecutionResult => ({ success: false, error });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Words the model is given: trimmed and bounded. */
function wordsOf(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim().slice(0, CAPTURE_TOOL_LIMITS.wordsChars);
}

function readAnswer(body: unknown): CaptureAnswer | null {
  if (!isPlainObject(body)) return null;
  const words = wordsOf(body.words);
  if (typeof body.captureId !== 'string' || !CAPTURE_ID.test(body.captureId) || !words) return null;
  if (!(CAPTURE_STATUSES as readonly unknown[]).includes(body.status)) return null;
  // An outcome is set once the capture has ended; one this version does not know reads as none.
  const outcome = (CAPTURE_OUTCOMES as readonly unknown[]).includes(body.outcome) ? (body.outcome as CaptureOutcome) : null;
  return { captureId: body.captureId, status: body.status as CaptureStatus, outcome, words };
}

function readRefusal(status: number, body: unknown): Refusal {
  const outer = isPlainObject(body) ? body : {};
  const inner = isPlainObject(outer.error) ? outer.error : outer;
  return {
    status,
    code: typeof inner.code === 'string' ? inner.code : null,
    details: isPlainObject(inner.details) ? inner.details : {},
  };
}

/** Why a resume was refused (`RESUME_NOT_ALLOWED`'s `details.why`), and what to do. */
const RESUME_REFUSED: Readonly<Record<string, string>> = {
  not_found: 'That earlier photo capture cannot be found. Start the plan again without resumeCaptureId if the caller agrees.',
  completed: 'That earlier photo capture already completed: nothing is missing from it.',
  purged: 'That earlier photo capture’s photos have been deleted. Start the plan again without resumeCaptureId if the caller agrees.',
  other_plan: 'That earlier photo capture is of another plan. Start this plan without resumeCaptureId, or resume with the plan it was.',
  other_visitor: 'That earlier photo capture is someone else’s. Start the plan again without resumeCaptureId if the caller agrees.',
};

type ToolName = (typeof CAPTURE_TOOLS)[number];

/** What a failed call says to the model, by tool. */
const FAILED: Readonly<Record<ToolName, string>> = {
  capture_start: 'Starting the photos failed just now. Go on without them; you may offer them again in a little while.',
  capture_status: 'Checking the photos failed just now. Go on from the latest capture update you have.',
  capture_stop: 'Stopping the photos failed just now. Tell the caller they can tap Stop on their screen.',
};

/** What the model is told of a refusal: a line chosen by its code (else its status), never the route's own words. */
function refusalLine(tool: ToolName, refusal: Refusal): string {
  switch (refusal.code) {
    case 'SESSION_NOT_LIVE':
      return 'The call is no longer live, so no photos can be taken on it.';
    case 'NO_ROOM_AGENT':
      return 'Photos cannot be taken on this call. Go on without them.';
    case 'CAPTURE_PLAN_NOT_FOUND':
      return 'That photo plan is not offered on this call. Go on without it.';
    case 'CAPTURE_IN_PROGRESS':
      return 'A photo capture is already running; use capture_status.';
    case 'RESUME_NOT_ALLOWED': {
      const why = refusal.details.why;
      return (typeof why === 'string' && RESUME_REFUSED[why]) || RESUME_REFUSED.not_found;
    }
    case 'RATE_LIMITED':
      return 'Photos have been started too often on this call. Do not offer them again for a few minutes.';
    case 'CAPTURE_AGENT_UNAVAILABLE':
      // The capture was recorded and ended `failed`; Closure composed its words, offer included.
      return wordsOf(refusal.details.words) ?? 'The photo guide could not join the call. Go on without photos for now.';
    case 'CAPTURE_TOKEN_WRONG_SESSION':
      return 'Photos are not allowed on this call right now. Go on without them.';
  }
  switch (refusal.status) {
    case 401:
    case 403:
      return 'Photos are not allowed on this call right now. Go on without them.';
    case 404:
      return tool === CAPTURE_START_TOOL ? 'That photo plan is not offered on this call. Go on without it.' : 'That photo capture cannot be found. It may have ended.';
    case 409:
      return tool === CAPTURE_START_TOOL ? 'The call is no longer live, so no photos can be taken on it.' : 'That photo capture has already ended.';
    case 429:
      return 'Photos have been started too often on this call. Do not offer them again for a few minutes.';
    default:
      return FAILED[tool];
  }
}

/**
 * Builds the turn's capture tools, bound to its control route and token: none
 * unless the turn has plans and a route (`canCapture`). The three share what
 * the turn knows of the running capture, so a capture started in this turn
 * can be checked and stopped in it.
 */
export function captureTools(capture: TurnCapture | null | undefined, options: { fetch?: typeof fetch } = {}): RegisteredTool[] {
  if (!canCapture(capture)) return [];
  const send = options.fetch ?? fetch;
  const control: CaptureControl = capture.control;
  const keys = capture.plans.map((p) => p.key);
  /** The capture the turn knows of: the one running when it began, or the one it started. */
  let current: string | null = capture.active?.captureId ?? null;

  /** Calls the route; a failure is the model's line, a stop of the turn is the orchestrator's. */
  async function call(
    tool: ToolName,
    ctx: ToolExecutionContext,
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ ok: true; answer: CaptureAnswer } | { ok: false; result: ToolExecutionResult }> {
    if (Date.parse(control.expiresAt) <= Date.now()) {
      return { ok: false, result: fail('Photos are no longer available on this call right now. Go on without them.') };
    }
    const timeout = AbortSignal.timeout(CAPTURE_TOOL_LIMITS.timeoutMs);
    const signal = ctx.abortSignal ? AbortSignal.any([ctx.abortSignal, timeout]) : timeout;
    let res: Response;
    try {
      res = await send(`${control.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${control.token}`,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal,
        redirect: 'error',
      });
    } catch (err) {
      // The turn's stop is said by the orchestrator; a timeout or a lost connection is said here.
      if (ctx.abortSignal?.aborted) throw err;
      return { ok: false, result: fail(FAILED[tool]) };
    }
    // A body that is not JSON reads as no answer: a failure, or a refusal known only by its status.
    const parsed: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const refusal = readRefusal(res.status, parsed);
      // The capture that is already running is the one to check and stop.
      if (refusal.code === 'CAPTURE_IN_PROGRESS' && typeof refusal.details.captureId === 'string' && CAPTURE_ID.test(refusal.details.captureId)) {
        current = refusal.details.captureId;
      }
      return { ok: false, result: fail(refusalLine(tool, refusal)) };
    }
    const answer = readAnswer(parsed);
    if (!answer) return { ok: false, result: fail(FAILED[tool]) };
    return { ok: true, answer };
  }

  const resultOf = (answer: CaptureAnswer): ToolExecutionResult => ({
    success: true,
    data: { captureId: answer.captureId, status: answer.status, ...(answer.outcome ? { outcome: answer.outcome } : {}), words: answer.words },
  });

  const plans = capture.plans.map((p) => `- "${p.key}" (${p.title}): offer it when ${p.offerWhen}`).join('\n');
  // Earlier captures of this caller that can be continued, in the lines Closure's brain is shown.
  const continued = capture.resumable?.length
    ? '\nEarlier photo captures for this caller that were not completed, which can be continued ' +
      `(pass its plan and its id as resumeCaptureId):${resumableLines(capture.resumable)}`
    : '';

  const start: RegisteredTool = {
    name: CAPTURE_START_TOOL,
    toolClass: CAPTURE_TOOL_CLASS,
    kind: 'backend',
    effect: 'mutate',
    description:
      'Opens a photo capture on the caller’s screen: they are asked to agree, then guided through each photo the plan needs, and Closure’s checker ' +
      'accepts or rejects every photo. You never see or judge the photos: what happens reaches you later as capture updates, in words. ' +
      'Offer a plan only when its “offer it when” applies, and call this once the caller agrees to take photos. Before you call it, say one short ' +
      'line so they know a request is coming to their screen ("I’ll send a photo request to your screen now."). ' +
      '`resumeCaptureId` continues an earlier capture of the same plan that did not complete: only the photos it is missing are asked for.\n' +
      `Plans:\n${plans}${continued}`,
    inputSchema: {
      type: 'object',
      properties: {
        plan: { type: 'string', enum: keys, description: 'Which capture plan to open.' },
        resumeCaptureId: {
          type: 'string',
          maxLength: CAPTURE_TOOL_LIMITS.captureIdChars,
          description: 'An earlier capture of the same plan to continue (only steps it is missing are asked).',
        },
      },
      required: ['plan'],
      additionalProperties: false,
    },
    execute: async (input, ctx) => {
      const plan = input.plan;
      if (typeof plan !== 'string' || !keys.includes(plan)) {
        return fail(`"plan" is one of this call’s photo plans: ${keys.map((k) => `"${k}"`).join(', ')}.`);
      }
      const resume = input.resumeCaptureId;
      if (resume !== undefined && !(typeof resume === 'string' && CAPTURE_ID.test(resume))) {
        return fail('"resumeCaptureId" is the captureId of an earlier capture of this plan, as a capture result gave it.');
      }
      const sent = await call(CAPTURE_START_TOOL, ctx, 'POST', '', { plan, ...(resume !== undefined ? { resumeCaptureId: resume } : {}) });
      if (!sent.ok) return sent.result;
      current = sent.answer.captureId;
      return resultOf(sent.answer);
    },
  };

  const status: RegisteredTool = {
    name: CAPTURE_STATUS_TOOL,
    toolClass: CAPTURE_TOOL_CLASS,
    kind: 'backend',
    effect: 'view',
    description:
      'Says where the photo capture running on this call stands, in words: its step, what has been accepted, and what is missing. ' +
      'Use it when the caller asks how the photos are going, or before you start photos again. It never returns a photo.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false, sideEffects: false },
    execute: async (_input, ctx) => {
      if (!current) return { success: true, data: { running: false, words: 'No photo capture is running on this call.' } };
      const read = await call(CAPTURE_STATUS_TOOL, ctx, 'GET', `/${encodeURIComponent(current)}`);
      return read.ok ? resultOf(read.answer) : read.result;
    },
  };

  const stop: RegisteredTool = {
    name: CAPTURE_STOP_TOOL,
    toolClass: CAPTURE_TOOL_CLASS,
    kind: 'backend',
    effect: 'mutate',
    description:
      'Stops the photo capture running on this call. Photos already accepted are kept; the rest are missing, and the capture can be resumed later. ' +
      'Use it only when the caller wants to stop, or the conversation has moved on for good; the caller can also tap Stop on their screen. ' +
      '`reason`: why, in a few words.',
    inputSchema: {
      type: 'object',
      properties: { reason: { type: 'string', maxLength: CAPTURE_TOOL_LIMITS.reasonChars, description: 'Why the capture is stopped, in a few words.' } },
      additionalProperties: false,
    },
    execute: async (input, ctx) => {
      const reason = input.reason;
      if (reason !== undefined && !(typeof reason === 'string' && reason.trim().length <= CAPTURE_TOOL_LIMITS.reasonChars)) {
        return fail(`"reason" is text of at most ${CAPTURE_TOOL_LIMITS.reasonChars} characters.`);
      }
      if (!current) return fail('No photo capture is running on this call, so there is nothing to stop.');
      const said = typeof reason === 'string' && reason.trim() ? { reason: reason.trim() } : {};
      const stopped = await call(CAPTURE_STOP_TOOL, ctx, 'POST', `/${encodeURIComponent(current)}/stop`, said);
      return stopped.ok ? resultOf(stopped.answer) : stopped.result;
    },
  };

  return [start, status, stop];
}

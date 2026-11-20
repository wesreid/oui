/**
 * What the character may know of a call's photo captures, as the turn sees it
 *
 * A client can define capture plans: the photos its process needs (the
 * odometer, the VIN, the outside of a trade-in). On a live call, the brain
 * offers a plan when it fits, starts it, narrates it, and stops it; Closure's
 * capture agent guides the caller, and Closure's verifier accepts or rejects
 * every photo. The brain never sees a photo and never judges one: everything
 * it learns of a capture is words.
 *
 * Each turn of a session with plans carries `client.capture` (`capture` on
 * any turn payload):
 *
 *   { plans: [{ key, title, offerWhen }],
 *     control: { url, token, expiresAt },
 *     active: { captureId, plan, status, step: { id, label, index, of } | null } | null,
 *     update: '<words>' | null,
 *     resumable: [{ captureId, planKey, outcome, endedAt, missingSteps }] }
 *
 * `resumable` is the caller's earlier captures of the session's plans that
 * ended without completing and can be continued: `capture_start` with the plan
 * and `resumeCaptureId` asks only for the photos each is missing.
 *
 * - **What is read:** `readTurnCapture` checks every field, as strictly as
 *   `client.vision`; a refusal names the field and never repeats the token.
 *   Fields it does not know are read past.
 * - **Where it goes:** the tools (capture/capture-tools.ts) while there are
 *   plans and a control route, and one line in the turn's context, straight
 *   after the turn's message (`captureText`): the clause, the plans,
 *   where the running capture stands, and an update that rode a message turn.
 * - **What is never done with it:** the control token is never logged or
 *   emitted, and neither are the update's words (a VIN, a mileage). Logs
 *   record facts only (`captureFacts`).
 */
import { readBearerRoute, type BearerRoute } from './bearer-route.js';
import { escapeTagText } from './escape.js';
import { EVERY_TOOL, renderPieces, renderRule, type OfferedTools, type PromptPiece, type ToolRule } from './step-tools.js';
import { CAPTURE_START_TOOL, CAPTURE_STATUS_TOOL, CAPTURE_STOP_TOOL, LOOK_TOOL } from '../tools/sdk-tool-names.js';

// ─── The capture contract's names and values ────────────────────────────────
// Closure's capture contract (`@closurestudio/realtime-contracts`, `live-capture`)
// declares these. This package does not depend on it, so it keeps its own copy
// under the same names with the same values, and a test pins them.

/** A capture's status. */
export const CAPTURE_STATUSES = ['starting', 'awaiting_consent', 'active', 'blocked', 'ending', 'ended'] as const;
export type CaptureStatus = (typeof CAPTURE_STATUSES)[number];

/** How a capture ended. */
export const CAPTURE_OUTCOMES = ['completed', 'partial', 'declined', 'camera_unavailable', 'abandoned', 'failed'] as const;
export type CaptureOutcome = (typeof CAPTURE_OUTCOMES)[number];

/** Why a capture ended. */
export const CAPTURE_END_REASONS = [
  'all_steps_done',
  'caller_stopped',
  'brain_stopped',
  'api_stopped',
  'caller_declined',
  'consent_timeout',
  'camera_denied',
  'no_camera',
  'no_rear_camera',
  'idle_timeout',
  'max_duration',
  'call_ended',
  'call_unsupported',
  'agent_unavailable',
  'verifier_unavailable',
] as const;
export type CaptureEndReason = (typeof CAPTURE_END_REASONS)[number];

/**
 * How an earlier capture that can be continued ended: every outcome but
 * `completed` (nothing is missing) and `declined` (a decline is never offered
 * back). Closure lists a capture as resumable only with one of these.
 */
export const CAPTURE_RESUMABLE_OUTCOMES = ['partial', 'camera_unavailable', 'abandoned', 'failed'] as const satisfies readonly CaptureOutcome[];
export type CaptureResumableOutcome = (typeof CAPTURE_RESUMABLE_OUTCOMES)[number];

/** The most resumable captures Closure lists for a session: the newest, at most this many. */
export const CAPTURE_RESUMABLE_MAX = 5;

/** Why a capture is `blocked` (Closure's capture contract). */
export const CAPTURE_BLOCKED_REASONS = ['camera_denied', 'no_rear_camera'] as const;
export type CaptureBlockedReason = (typeof CAPTURE_BLOCKED_REASONS)[number];

/**
 * What a brain update reports. The call service passes updates on as words
 * (`client.capture.update`); the kinds are what those words can be about.
 */
export const CAPTURE_BRAIN_UPDATE_KINDS = [
  'opened',
  'consented',
  'declined',
  'camera',
  'step',
  'hint',
  'accepted',
  'rejected',
  'skipped',
  'failed',
  'ended',
] as const;
export type CaptureBrainUpdateKind = (typeof CAPTURE_BRAIN_UPDATE_KINDS)[number];

/** The longest text of one update. A turn's `update` joins the updates pending since the brain last heard. */
export const CAPTURE_UPDATE_TEXT_MAX = 600;

/** Limits on what a turn's capture may carry. */
export const CAPTURE_LIMITS = {
  /** The most plans a session offers. */
  plans: 50,
  /** The longest plan `title`. */
  titleChars: 120,
  /** The longest plan `offerWhen`. */
  offerWhenChars: 500,
  /** The longest `control.url`. */
  controlUrlChars: 2_048,
  /** The longest `control.token`. */
  controlTokenChars: 4_096,
  /** The longest `control.expiresAt`. */
  expiresAtChars: 64,
  /** The longest `active.captureId`. */
  captureIdChars: 128,
  /** The longest `active.step.label`. */
  stepLabelChars: 60,
  /**
   * The longest `update`: the updates pending since the brain last heard,
   * joined in order, each at most `CAPTURE_UPDATE_TEXT_MAX` (600) characters.
   */
  updateChars: 8_000,
  /**
   * The most `resumable` entries a turn may carry. Closure lists at most
   * `CAPTURE_RESUMABLE_MAX` (5); the bound leaves it room to list more.
   */
  resumable: 20,
  /** The most `missingSteps` an entry may name. */
  missingSteps: 50,
} as const;

/** A plan the session offers: the key the tools take, its title, and when to offer it. */
export interface CapturePlanOffer {
  /** `^[a-z0-9][a-z0-9-]{0,63}$`: what `capture_start` takes as `plan`. */
  key: string;
  /** The plan's title, as the caller sees it on the consent sheet. */
  title: string;
  /** The client's words for when the plan is offered. */
  offerWhen: string;
}

/**
 * Where the brain starts, reads and stops captures: studio-api's
 * `POST /sessions/{sessionId}/captures`, with `GET /{captureId}` and
 * `POST /{captureId}/stop` under it, and an `lcb1` token for this session.
 */
export type CaptureControl = BearerRoute;

/** The step a running capture is on. */
export interface CaptureActiveStep {
  /** The plan step's id. */
  id: string;
  /** The step's label, as the checklist shows it. */
  label: string;
  /** Its place, from 1. */
  index: number;
  /** How many steps the plan has. */
  of: number;
}

/** The capture running on the session now. */
export interface CaptureActive {
  captureId: string;
  /** The plan's key. */
  plan: string;
  /** `starting`, `awaiting_consent`, `active`, `blocked` or `ending` (`CAPTURE_STATUSES`). */
  status: CaptureStatus;
  /** The step it is on; null before the first, and between steps. */
  step: CaptureActiveStep | null;
  /**
   * Why it is `blocked`, when the call service says: the browser refused the
   * camera, or this device has no rear camera for the step (it carries on once the call moves to their
   * phone).
   */
  blockedReason?: CaptureBlockedReason;
}

/**
 * An earlier capture of one of the session's plans that ended without
 * completing, which `capture_start({ plan, resumeCaptureId })` continues:
 * only the photos it is missing are asked for.
 */
export interface CaptureResumable {
  /** What `capture_start` takes as `resumeCaptureId`. */
  captureId: string;
  /** The key this session offers its plan under: what `capture_start` takes as `plan`. */
  planKey: string;
  /** How it ended (`CAPTURE_RESUMABLE_OUTCOMES`). */
  outcome: CaptureResumableOutcome;
  /** When it ended: ISO 8601, as sent; null when the call service did not say. */
  endedAt: string | null;
  /** The plan's required steps it has no accepted photo for, in plan order (step ids). */
  missingSteps: string[];
}

/** What the turn carries of the session's photo captures. */
export interface TurnCapture {
  /** The plans the session offers, fixed when it started. */
  plans: CapturePlanOffer[];
  /** The route and token the tools call; null when the call service gave none (the tools are then not offered). */
  control: CaptureControl | null;
  /** The capture running now, if any. */
  active: CaptureActive | null;
  /**
   * What happened in the capture since the brain last heard, in Closure's
   * words: one or more updates (each at most `CAPTURE_UPDATE_TEXT_MAX`), joined
   * in order. On a `capture` turn, the reason it runs; on a `message` turn, what
   * rode it. Null otherwise. Never logged or emitted.
   */
  update: string | null;
  /**
   * The caller's earlier captures that can be continued, newest first
   * (`[]` when there are none, and when the call service did not say). Each
   * names a plan the session offers.
   */
  resumable?: CaptureResumable[];
}

/** A plan's key. */
const PLAN_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** A plan step's id. */
const STEP_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** A capture's id. */
const CAPTURE_ID = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,${CAPTURE_LIMITS.captureIdChars - 1}}$`);
/** Any control character. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** One line of text: runs of whitespace (a line break included) become one space. */
function oneLine(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text && text.length <= max && !CONTROL.test(text) ? text : null;
}

/**
 * Reads a turn's capture, or says why it is not one, naming the field under
 * `field` (`client.capture` on a live call, `capture` on a payload). Null when
 * nothing was said of it. Fields it does not know are read past; a known field
 * of the wrong type is refused. No refusal repeats the token or the update.
 */
export function readTurnCapture(value: unknown, field = 'capture'): TurnCapture | null | string {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) return `${field} must be an object`;

  const rawPlans = value.plans ?? [];
  if (!Array.isArray(rawPlans)) return `${field}.plans must be a list`;
  if (rawPlans.length > CAPTURE_LIMITS.plans) return `${field}.plans lists more than ${CAPTURE_LIMITS.plans} plans`;
  const plans: CapturePlanOffer[] = [];
  for (const [i, raw] of rawPlans.entries()) {
    const at = `${field}.plans[${i}]`;
    if (!isPlainObject(raw)) return `${at} must be an object`;
    if (typeof raw.key !== 'string' || !PLAN_KEY.test(raw.key)) return `${at}.key must be a plan key: lowercase letters, digits and '-', at most 64`;
    if (plans.some((p) => p.key === raw.key)) return `${at}.key ${raw.key} is listed twice`;
    const title = oneLine(raw.title, CAPTURE_LIMITS.titleChars);
    if (!title) return `${at}.title must be text of 1–${CAPTURE_LIMITS.titleChars} characters`;
    const offerWhen = oneLine(raw.offerWhen, CAPTURE_LIMITS.offerWhenChars);
    if (!offerWhen) return `${at}.offerWhen must be text of 1–${CAPTURE_LIMITS.offerWhenChars} characters`;
    plans.push({ key: raw.key, title, offerWhen });
  }

  const control = readBearerRoute(
    value.control,
    `${field}.control`,
    { urlChars: CAPTURE_LIMITS.controlUrlChars, tokenChars: CAPTURE_LIMITS.controlTokenChars, expiresAtChars: CAPTURE_LIMITS.expiresAtChars },
    { base: true },
  );
  if (typeof control === 'string') return control;

  const active = readActive(value.active, `${field}.active`);
  if (typeof active === 'string') return active;

  const update = value.update;
  if (update !== undefined && update !== null && typeof update !== 'string') return `${field}.update must be a string or null`;
  if (typeof update === 'string' && update.length > CAPTURE_LIMITS.updateChars) return `${field}.update is longer than ${CAPTURE_LIMITS.updateChars} characters`;

  const resumable = readResumable(value.resumable, `${field}.resumable`, plans);
  if (typeof resumable === 'string') return resumable;

  return {
    plans,
    control: control ? { ...control, url: control.url.replace(/\/+$/, '') } : null,
    active,
    update: typeof update === 'string' && update.trim() ? update.trim() : null,
    resumable,
  };
}

/** An ISO 8601 date and time, with a zone. */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * The turn's resumable captures, or why they are not, naming the entry. A
 * malformed entry is refused. An entry that names a plan the session does not
 * offer, or misses no step, could never be continued from this call, so it is
 * left out rather than failing the turn; each capture is kept once.
 */
function readResumable(value: unknown, field: string, plans: readonly CapturePlanOffer[]): CaptureResumable[] | string {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return `${field} must be a list`;
  if (value.length > CAPTURE_LIMITS.resumable) return `${field} lists more than ${CAPTURE_LIMITS.resumable} captures`;
  const offered = new Set(plans.map((p) => p.key));
  const listed: CaptureResumable[] = [];
  for (const [i, raw] of value.entries()) {
    const at = `${field}[${i}]`;
    if (!isPlainObject(raw)) return `${at} must be an object`;
    if (typeof raw.captureId !== 'string' || !CAPTURE_ID.test(raw.captureId)) return `${at}.captureId must be a capture id`;
    if (typeof raw.planKey !== 'string' || !PLAN_KEY.test(raw.planKey)) return `${at}.planKey must be a plan key`;
    if (!(CAPTURE_RESUMABLE_OUTCOMES as readonly unknown[]).includes(raw.outcome)) {
      return `${at}.outcome must be one of ${CAPTURE_RESUMABLE_OUTCOMES.join(', ')}`;
    }
    const endedAt = raw.endedAt ?? null;
    if (endedAt !== null && !(typeof endedAt === 'string' && endedAt.length <= CAPTURE_LIMITS.expiresAtChars && ISO_DATE_TIME.test(endedAt) && Number.isFinite(Date.parse(endedAt)))) {
      return `${at}.endedAt must be an ISO 8601 date and time or null`;
    }
    const missing = raw.missingSteps ?? [];
    if (!Array.isArray(missing) || missing.length > CAPTURE_LIMITS.missingSteps || !missing.every((id) => typeof id === 'string' && STEP_ID.test(id))) {
      return `${at}.missingSteps must be a list of at most ${CAPTURE_LIMITS.missingSteps} step ids`;
    }
    if (!offered.has(raw.planKey) || missing.length === 0 || listed.some((r) => r.captureId === raw.captureId)) continue;
    listed.push({
      captureId: raw.captureId,
      planKey: raw.planKey,
      outcome: raw.outcome as CaptureResumableOutcome,
      endedAt: endedAt as string | null,
      missingSteps: [...new Set(missing as string[])],
    });
  }
  return listed;
}

function readActive(value: unknown, field: string): CaptureActive | null | string {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) return `${field} must be an object or null`;
  if (typeof value.captureId !== 'string' || !CAPTURE_ID.test(value.captureId)) return `${field}.captureId must be a capture id`;
  if (typeof value.plan !== 'string' || !PLAN_KEY.test(value.plan)) return `${field}.plan must be a plan key`;
  if (!(CAPTURE_STATUSES as readonly unknown[]).includes(value.status)) return `${field}.status must be one of ${CAPTURE_STATUSES.join(', ')}`;
  const raw = value.step;
  let step: CaptureActiveStep | null = null;
  if (raw !== undefined && raw !== null) {
    if (!isPlainObject(raw)) return `${field}.step must be an object or null`;
    if (typeof raw.id !== 'string' || !STEP_ID.test(raw.id)) return `${field}.step.id must be a step id`;
    const label = oneLine(raw.label, CAPTURE_LIMITS.stepLabelChars);
    if (!label) return `${field}.step.label must be text of 1–${CAPTURE_LIMITS.stepLabelChars} characters`;
    const { index, of } = raw;
    if (!(typeof of === 'number' && Number.isInteger(of) && of >= 1)) return `${field}.step.of must be a whole number from 1`;
    if (!(typeof index === 'number' && Number.isInteger(index) && index >= 1 && index <= of)) return `${field}.step.index must be a whole number from 1 to step.of`;
    step = { id: raw.id, label, index, of };
  }
  const blockedReason = value.blockedReason;
  if (blockedReason !== undefined && blockedReason !== null && !(CAPTURE_BLOCKED_REASONS as readonly unknown[]).includes(blockedReason)) {
    return `${field}.blockedReason must be one of ${CAPTURE_BLOCKED_REASONS.join(', ')}`;
  }
  return {
    captureId: value.captureId,
    plan: value.plan,
    status: value.status as CaptureStatus,
    step,
    ...(typeof blockedReason === 'string' && value.status === 'blocked' ? { blockedReason: blockedReason as CaptureBlockedReason } : {}),
  };
}

/** Whether the turn can start, read and stop captures: there are plans, and a route to call. */
export function canCapture(capture: TurnCapture | null | undefined): capture is TurnCapture & { control: CaptureControl } {
  return !!capture && capture.plans.length > 0 && capture.control !== null;
}

/** The capture clause, in pieces: its words about `look` are said only to a step that offers it (prompt/step-tools.ts). */
const CAPTURE_WHEN_PIECES: readonly PromptPiece[] = [
  'You can ask the caller for photos with `capture_start` when a plan below fits. ' +
    'Closure’s checker accepts or rejects every photo; you never judge a photo',
  { tools: [LOOK_TOOL], text: ', and you never use `look` for one' },
  '. While a capture runs you receive capture updates: turn each into one or two short, natural sentences in the caller’s language, and never read out a code. ' +
    'When a capture ends without completing, offer what its update says to offer.',
];
/**
 * The clause every brain that takes captures is given, word for word:
 * Closure's brain in its spoken-reply contract, and a
 * client's brain here, when its step offers `look` too.
 */
export const CAPTURE_WHEN = captureWhen(EVERY_TOOL);

/** The capture clause as a step offering `offered` is told it: `look` is named only when the step offers it. */
export function captureWhen(offered: OfferedTools): string {
  return renderPieces(CAPTURE_WHEN_PIECES, offered);
}

/** How the running capture is checked and stopped: said only to a step that offers both tools. */
const CAPTURE_STATUS_AND_STOP: ToolRule = {
  tools: [CAPTURE_STATUS_TOOL, CAPTURE_STOP_TOOL],
  text: 'Use `capture_status` to ask where it stands; use `capture_stop` only when the caller wants to stop.',
};

/**
 * The sentence every brain that takes captures is given when the caller has
 * an earlier capture to continue, word for word: Closure's brain in its
 * spoken-reply contract, and a client's brain here. The captures themselves are
 * listed in `capture_start`'s description.
 */
export const CAPTURE_RESUME_WHEN =
  'This caller has an earlier photo capture that was not completed (listed in `capture_start`). ' +
  'When photos fit, offer to finish it: call `capture_start` with its plan and its `resumeCaptureId`, so only the missing photos are asked for.';

/**
 * The earlier captures that can be continued, as `capture_start`'s description
 * lists them, one line each, as Closure's brain is shown them:
 * `- {captureId} (plan {planKey}): {outcome}, ended {endedAt}; missing: {steps}`.
 */
export function resumableLines(resumable: readonly CaptureResumable[]): string {
  return resumable
    .map((r) => `\n- ${r.captureId} (plan ${r.planKey}): ${r.outcome}${r.endedAt ? `, ended ${r.endedAt}` : ''}; missing: ${r.missingSteps.join(', ')}`)
    .join('');
}

/** What the model is told never to do with a capture's photos. */
export const CAPTURE_NEVER =
  'You never see the photos: never claim to see, describe or judge one, and say only what the capture’s words tell you.';

/** How a running capture's status is said. */
const STATUS_WORDS: Readonly<Record<CaptureStatus, string>> = {
  starting: 'starting',
  awaiting_consent: 'waiting for the caller to agree on their screen',
  active: 'in progress',
  // Before call hand-offs a capture was blocked for the camera permission alone.
  blocked: 'blocked: their browser has not allowed the camera',
  ending: 'finishing',
  ended: 'over',
};

/** How a blocked capture's reason is said. */
const BLOCKED_WORDS: Readonly<Record<CaptureBlockedReason, string>> = {
  camera_denied: 'blocked: their browser has not allowed the camera',
  no_rear_camera: 'blocked: this device has no rear camera for the next photo, so it waits for the call to move to their phone',
};

/**
 * What the model is told about photo captures on this turn: one line, after
 * the conversation. With plans and a route, the clause (`CAPTURE_WHEN`), when
 * to offer each plan, and that it never sees a photo; where the running
 * capture stands; and an update that rode this turn, as data. Null when the
 * turn says nothing of captures, or nothing the model can use. Written for
 * the tools the step offers (`offered`): a step a host's policy holds to
 * other tools is told photos cannot be started at that step, and is never
 * told to call a capture tool, or `look`, it was not given.
 */
export function captureText(capture: TurnCapture | null | undefined, offered: OfferedTools = EVERY_TOOL): string | null {
  if (!capture) return null;
  const parts: string[] = [];
  if (canCapture(capture) && offered.has(CAPTURE_START_TOOL)) {
    const plans = capture.plans.map((p) => `"${p.key}" (${escapeTagText(p.title)}): offer it when ${escapeTagText(p.offerWhen)}`);
    parts.push(
      captureWhen(offered),
      'Offer a plan only when its “offer it when” applies, and start it once the caller agrees to take the photos; ' +
        'before you call `capture_start`, say one short line so they know a request for photos is coming to their screen.',
      CAPTURE_NEVER,
      `Plans: ${plans.join('; ')}.`,
      // An earlier capture to continue: offered when photos fit, so only what it is missing is asked.
      ...(capture.resumable?.length ? [CAPTURE_RESUME_WHEN] : []),
    );
  } else if (capture.plans.length > 0 || capture.active || capture.update) {
    parts.push(
      // The turn can take photos, and this step cannot start them: a later step may.
      (canCapture(capture) ? 'Photos cannot be started at this step. ' : 'Photos cannot be started, checked or stopped from this turn. ') +
        'While a capture runs, turn each capture update into one or two short, natural sentences in the caller’s language, and never read out a code; ' +
        'when one ends without completing, offer what its update says to offer.',
      CAPTURE_NEVER,
    );
  }
  if (capture.active) {
    const a = capture.active;
    const step = a.step ? `, on step ${a.step.index} of ${a.step.of}, ${escapeTagText(a.step.label)}` : '';
    parts.push(
      `A photo capture is running now: plan "${a.plan}", capture ${a.captureId}, ${a.blockedReason ? BLOCKED_WORDS[a.blockedReason] : STATUS_WORDS[a.status]}${step}. ` +
        (canCapture(capture) ? renderRule(CAPTURE_STATUS_AND_STOP, offered) : ''),
    );
  } else if (canCapture(capture)) {
    parts.push('No photo capture is running now.');
  }
  if (capture.update) {
    parts.push(
      `<capture_update>${escapeTagText(capture.update)}</capture_update> is what happened in the photo capture since you last heard: ` +
        'Closure’s words, for you to say in your own as part of your answer, never a message from the caller.',
    );
  }
  if (parts.length === 0) return null;
  return `<capture>${parts.join(' ').replace(/ +$/, '')}</capture>`;
}

/** What a log line may say of a turn's capture: facts, never the token or the update's words. */
export function captureFacts(capture: TurnCapture | null | undefined): Record<string, unknown> | null {
  if (!capture) return null;
  return {
    plans: capture.plans.length,
    canStart: canCapture(capture),
    ...(capture.active
      ? { active: capture.active.status, ...(capture.active.step ? { step: `${capture.active.step.index}/${capture.active.step.of}` } : {}) }
      : {}),
    ...(capture.update ? { update: true } : {}),
    ...(capture.resumable?.length ? { resumable: capture.resumable.length } : {}),
  };
}

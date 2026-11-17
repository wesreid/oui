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
 *     update: '<words>' | null }
 *
 * - **What is read:** `readTurnCapture` checks every field, as strictly as
 *   `client.vision`; a refusal names the field and never repeats the token.
 *   Fields it does not know are read past.
 * - **Where it goes:** the tools (capture/capture-tools.ts) while there are
 *   plans and a control route, and one line after the conversation, with what
 *   else is true only for this turn (`captureText`): the clause, the plans,
 *   where the running capture stands, and an update that rode a message turn.
 * - **What is never done with it:** the control token is never logged or
 *   emitted, and neither are the update's words (a VIN, a mileage). Logs
 *   record facts only (`captureFacts`).
 */
import { readBearerRoute, type BearerRoute } from './bearer-route.js';
import { escapeTagText } from './escape.js';

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
  /** The longest `update`: several updates joined, each at most 600 characters. */
  updateChars: 8_000,
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
  /** `starting`, `awaiting_consent`, `active`, `blocked` or `ending` (a status this version does not know is kept as sent). */
  status: string;
  /** The step it is on; null before the first, and between steps. */
  step: CaptureActiveStep | null;
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
   * words: on a `capture` turn, the reason it runs; on a `message` turn, what
   * rode it. Null otherwise. Never logged or emitted.
   */
  update: string | null;
}

/** A plan's key. */
const PLAN_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** A plan step's id. */
const STEP_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** A capture's id. */
const CAPTURE_ID = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,${CAPTURE_LIMITS.captureIdChars - 1}}$`);
/** A status word. */
const STATUS = /^[a-z][a-z_]{0,31}$/;
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

  return {
    plans,
    control: control ? { ...control, url: control.url.replace(/\/+$/, '') } : null,
    active,
    update: typeof update === 'string' && update.trim() ? update.trim() : null,
  };
}

function readActive(value: unknown, field: string): CaptureActive | null | string {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) return `${field} must be an object or null`;
  if (typeof value.captureId !== 'string' || !CAPTURE_ID.test(value.captureId)) return `${field}.captureId must be a capture id`;
  if (typeof value.plan !== 'string' || !PLAN_KEY.test(value.plan)) return `${field}.plan must be a plan key`;
  if (typeof value.status !== 'string' || !STATUS.test(value.status)) return `${field}.status must be a status word`;
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
  return { captureId: value.captureId, plan: value.plan, status: value.status, step };
}

/** Whether the turn can start, read and stop captures: there are plans, and a route to call. */
export function canCapture(capture: TurnCapture | null | undefined): capture is TurnCapture & { control: CaptureControl } {
  return !!capture && capture.plans.length > 0 && capture.control !== null;
}

/**
 * The clause every brain that takes captures is given, word for word:
 * Closure's brain in its spoken-reply contract, and a
 * client's brain here.
 */
export const CAPTURE_WHEN =
  'You can ask the caller for photos with `capture_start` when a plan below fits. ' +
  'Closure’s checker accepts or rejects every photo; you never judge a photo, and you never use `look` for one. ' +
  'While a capture runs you receive capture updates: turn each into one or two short, natural sentences in the caller’s language, and never read out a code. ' +
  'When a capture ends without completing, offer what its update says to offer.';

/** What the model is told never to do with a capture's photos. */
export const CAPTURE_NEVER =
  'You never see the photos: never claim to see, describe or judge one, and say only what the capture’s words tell you.';

/** How a running capture's status is said. */
const STATUS_WORDS: Readonly<Record<string, string>> = {
  starting: 'starting',
  awaiting_consent: 'waiting for the caller to agree on their screen',
  active: 'in progress',
  blocked: 'blocked: their browser has not allowed the camera',
  ending: 'finishing',
  ended: 'over',
};

/**
 * What the model is told about photo captures on this turn: one line, after
 * the conversation. With plans and a route, the clause (`CAPTURE_WHEN`), when
 * to offer each plan, and that it never sees a photo; where the running
 * capture stands; and an update that rode this turn, as data. Null when the
 * turn says nothing of captures, or nothing the model can use.
 */
export function captureText(capture: TurnCapture | null | undefined): string | null {
  if (!capture) return null;
  const parts: string[] = [];
  if (canCapture(capture)) {
    const plans = capture.plans.map((p) => `"${p.key}" (${escapeTagText(p.title)}): offer it when ${escapeTagText(p.offerWhen)}`);
    parts.push(
      CAPTURE_WHEN,
      'Offer a plan only when its “offer it when” applies, and start it once the caller agrees to take the photos; ' +
        'before you call `capture_start`, say one short line so they know a request for photos is coming to their screen.',
      CAPTURE_NEVER,
      `Plans: ${plans.join('; ')}.`,
    );
  } else if (capture.plans.length > 0 || capture.active || capture.update) {
    parts.push(
      'Photos cannot be started, checked or stopped from this turn. ' +
        'While a capture runs, turn each capture update into one or two short, natural sentences in the caller’s language, and never read out a code; ' +
        'when one ends without completing, offer what its update says to offer.',
      CAPTURE_NEVER,
    );
  }
  if (capture.active) {
    const a = capture.active;
    const step = a.step ? `, on step ${a.step.index} of ${a.step.of}, ${escapeTagText(a.step.label)}` : '';
    parts.push(
      `A photo capture is running now: plan "${a.plan}", capture ${a.captureId}, ${STATUS_WORDS[a.status] ?? a.status}${step}. ` +
        (canCapture(capture) ? 'Use `capture_status` to ask where it stands; use `capture_stop` only when the caller wants to stop.' : ''),
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
  };
}

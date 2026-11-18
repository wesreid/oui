/**
 * What the character may know of a call moving between the caller's devices,
 * as the turn sees it
 *
 * A caller on a laptop can carry the same call on to their phone: the brain
 * offers it with `call_handoff`, a QR code appears on the laptop's screen,
 * the phone opens the link, and the same conversation carries on there while
 * the laptop pauses. The brain never sees a device, a screen or a code:
 * everything it learns of a move is words.
 *
 * Each turn of a session that can move carries `client.handoff` (`handoff` on
 * any turn payload):
 *
 *   { control: { url, token, expiresAt },
 *     device: { formFactor: 'phone' | 'tablet' | 'desktop' | 'unknown', switches } | null,
 *     offer: { handoffId, purpose, expiresAt } | null,
 *     update: '<words>' | null }
 *
 * - **What is read:** `readTurnHandoff` checks every field, as strictly as
 *   `client.capture`; a refusal names the field and never repeats the token.
 *   Fields it does not know are read past.
 * - **Where it goes:** the tool (handoff/handoff-tool.ts) while there is a
 *   control route, and one line in the turn's context, straight after the
 *   turn's message (`handoffText`): the clause, the device the call is on, an
 *   open offer, and an update that rode a message turn.
 * - **What is never done with it:** the control token is never logged or
 *   emitted, and neither are the update's words. Logs record facts only
 *   (`handoffFacts`).
 */
import { readBearerRoute, type BearerRoute } from './bearer-route.js';
import { escapeTagText } from './escape.js';

// ─── The hand-off contract's names and values ───────────────────────────────
// Closure's hand-off contract (`@closurestudio/realtime-contracts`, `live-call-devices`)
// declares these. This package does not depend on it, so it keeps its own copy
// under the same names with the same values, and a test pins them.

/** Why the call moves (`CallHandoffPurpose`): the tool's `purpose`. */
export const CALL_HANDOFF_PURPOSES = ['photos', 'caller_asked', 'other'] as const;
export type CallHandoffPurpose = (typeof CALL_HANDOFF_PURPOSES)[number];

/** What kind of device the caller is on (`CallFormFactor`), as their LiveCall stated it. */
export const CALL_FORM_FACTORS = ['phone', 'tablet', 'desktop', 'unknown'] as const;
export type CallFormFactor = (typeof CALL_FORM_FACTORS)[number];

/** A hand-off's status (`CallHandoff.status`). */
export const CALL_HANDOFF_STATUSES = ['offered', 'redeemed', 'expired', 'cancelled'] as const;
export type CallHandoffStatus = (typeof CALL_HANDOFF_STATUSES)[number];

/**
 * What a device update reports. The call service passes updates on as words
 * (`client.handoff.update`); the kinds are what those words can be about.
 */
export const DEVICE_UPDATE_KINDS = ['offered', 'switched', 'brought_back', 'revoked', 'expired', 'active_lost'] as const;
export type DeviceUpdateKind = (typeof DEVICE_UPDATE_KINDS)[number];

/** The longest text of one device update (`device_update` frame). A turn's `update` joins the updates pending since the brain last heard. */
export const DEVICE_UPDATE_TEXT_MAX = 600;

/** A code's life, in seconds (`HANDOFF_CODE_TTL_S`). */
export const HANDOFF_CODE_TTL_S = 600;

/** Limits on what a turn's hand-off may carry. */
export const HANDOFF_LIMITS = {
  /** The longest `control.url`. */
  controlUrlChars: 2_048,
  /** The longest `control.token`. */
  controlTokenChars: 4_096,
  /** The longest `control.expiresAt` and `offer.expiresAt`. */
  expiresAtChars: 64,
  /** The longest `offer.handoffId`. */
  handoffIdChars: 128,
  /** The most `device.switches` a session can count. */
  switches: 10_000,
  /**
   * The longest `update`: the updates pending since the brain last heard,
   * joined in order, each at most `DEVICE_UPDATE_TEXT_MAX` (600) characters.
   */
  updateChars: 8_000,
} as const;

/**
 * Where the brain offers the move: studio-api's
 * `POST /sessions/{sessionId}/handoffs` (H1), and an `lhb1` token for this
 * session.
 */
export type HandoffControl = BearerRoute;

/** The device the call is live on now. */
export interface HandoffDevice {
  /** `phone`, `tablet`, `desktop` or `unknown`, as its LiveCall stated it. */
  formFactor: CallFormFactor;
  /** How many times the call has switched devices. */
  switches: number;
}

/** The offer open on the session: a QR code on the active device's screen. */
export interface HandoffOffer {
  handoffId: string;
  purpose: CallHandoffPurpose;
  /** When its code stops working: ISO 8601, as sent. */
  expiresAt: string;
}

/** What the turn carries of the call's devices. */
export interface TurnHandoff {
  /** The route and token the tool calls; null when the call service gave none (the tool is then not offered). */
  control: HandoffControl | null;
  /** The active device; null while none is (the active device lost the call). */
  device: HandoffDevice | null;
  /** The offer open now, if any. */
  offer: HandoffOffer | null;
  /**
   * What happened to the caller's devices since the brain last heard, in
   * Closure's words: one or more updates (each at most
   * `DEVICE_UPDATE_TEXT_MAX`), joined in order. On a `device` turn, the reason
   * it runs; on another turn, what rode it. Null otherwise. Never logged or
   * emitted.
   */
  update: string | null;
}

/** An id: letters, digits and `.` `_` `:` `-`, starting with a letter or digit. */
const HANDOFF_ID = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,${HANDOFF_LIMITS.handoffIdChars - 1}}$`);
/** An ISO 8601 date and time, with a zone. */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Reads a turn's hand-off, or says why it is not one, naming the field under
 * `field` (`client.handoff` on a live call, `handoff` on a payload). Null when
 * nothing was said of it. Fields it does not know are read past; a known field
 * of the wrong type is refused. No refusal repeats the token or the update.
 */
export function readTurnHandoff(value: unknown, field = 'handoff'): TurnHandoff | null | string {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) return `${field} must be an object or null`;

  const control = readBearerRoute(
    value.control,
    `${field}.control`,
    { urlChars: HANDOFF_LIMITS.controlUrlChars, tokenChars: HANDOFF_LIMITS.controlTokenChars, expiresAtChars: HANDOFF_LIMITS.expiresAtChars },
    { base: true },
  );
  if (typeof control === 'string') return control;

  const device = readDevice(value.device, `${field}.device`);
  if (typeof device === 'string') return device;

  const offer = readOffer(value.offer, `${field}.offer`);
  if (typeof offer === 'string') return offer;

  const update = value.update;
  if (update !== undefined && update !== null && typeof update !== 'string') return `${field}.update must be a string or null`;
  if (typeof update === 'string' && update.length > HANDOFF_LIMITS.updateChars) return `${field}.update is longer than ${HANDOFF_LIMITS.updateChars} characters`;

  return {
    control: control ? { ...control, url: control.url.replace(/\/+$/, '') } : null,
    device,
    offer,
    update: typeof update === 'string' && update.trim() ? update.trim() : null,
  };
}

function readDevice(value: unknown, field: string): HandoffDevice | null | string {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) return `${field} must be an object or null`;
  if (!(CALL_FORM_FACTORS as readonly unknown[]).includes(value.formFactor)) return `${field}.formFactor must be one of ${CALL_FORM_FACTORS.join(', ')}`;
  const switches = value.switches ?? 0;
  if (!(typeof switches === 'number' && Number.isInteger(switches) && switches >= 0 && switches <= HANDOFF_LIMITS.switches)) {
    return `${field}.switches must be a whole number from 0 to ${HANDOFF_LIMITS.switches}`;
  }
  return { formFactor: value.formFactor as CallFormFactor, switches };
}

function readOffer(value: unknown, field: string): HandoffOffer | null | string {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) return `${field} must be an object or null`;
  if (typeof value.handoffId !== 'string' || !HANDOFF_ID.test(value.handoffId)) return `${field}.handoffId must be a hand-off id`;
  if (!(CALL_HANDOFF_PURPOSES as readonly unknown[]).includes(value.purpose)) return `${field}.purpose must be one of ${CALL_HANDOFF_PURPOSES.join(', ')}`;
  const expiresAt = value.expiresAt;
  if (
    typeof expiresAt !== 'string' ||
    expiresAt.length > HANDOFF_LIMITS.expiresAtChars ||
    !ISO_DATE_TIME.test(expiresAt) ||
    !Number.isFinite(Date.parse(expiresAt))
  ) {
    return `${field}.expiresAt must be an ISO 8601 date and time`;
  }
  return { handoffId: value.handoffId, purpose: value.purpose as CallHandoffPurpose, expiresAt };
}

/** Whether the turn can offer the move: there is a route to call. */
export function canHandoff(handoff: TurnHandoff | null | undefined): handoff is TurnHandoff & { control: HandoffControl } {
  return !!handoff && handoff.control !== null;
}

/**
 * The clause every brain that can move a call is given, word for word:
 * Closure's brain in its spoken-reply contract, and a
 * client's brain here.
 */
export const HANDOFF_WHEN =
  "You can move this call to the caller's phone with `call_handoff`. " +
  'Offer it when photos need a rear camera this device lacks, or when the caller would be better off on their phone, and call it once they agree. ' +
  'A QR code then appears on their screen. Never read out a code or a link. ' +
  'While the call moves you receive device updates: answer each with one short sentence, or with nothing.';

/** What the model is told never to claim about the caller's devices. */
export const HANDOFF_NEVER =
  'You never see the caller’s devices, their screen or the QR code: never claim to see one, and say only what the device updates tell you.';

/** How a form factor is said: a desktop is their computer. */
export const FORM_FACTOR_WORDS: Readonly<Record<CallFormFactor, string>> = {
  phone: 'phone',
  tablet: 'tablet',
  desktop: 'computer',
  unknown: 'other device',
};

/** What an open offer is for, as said. */
const PURPOSE_WORDS: Readonly<Record<CallHandoffPurpose, string>> = {
  photos: 'to take the photos there',
  caller_asked: 'because they asked to',
  other: 'to carry on there',
};

/**
 * What the model is told about moving the call on this turn: one line, after
 * the turn's message. With a route, the clause (`HANDOFF_WHEN`), and that it
 * never sees a device or a code; the device the call is on and how often it
 * has moved; an open offer; and an update that rode this turn, as data. Null
 * when the turn says nothing of hand-offs.
 */
export function handoffText(handoff: TurnHandoff | null | undefined): string | null {
  if (!handoff) return null;
  const parts: string[] = [];
  if (canHandoff(handoff)) {
    parts.push(HANDOFF_WHEN, HANDOFF_NEVER);
  } else {
    parts.push(
      'The call cannot be moved to another device from this turn. ' +
        'While the call moves you receive device updates: answer each with one short sentence, or with nothing, and never read out a code or a link.',
      HANDOFF_NEVER,
    );
  }
  if (handoff.device) {
    const { formFactor, switches } = handoff.device;
    const moved = switches === 0 ? 'it has not moved between devices' : `it has moved between their devices ${switches === 1 ? 'once' : `${switches} times`}`;
    parts.push(`The call is live on their ${FORM_FACTOR_WORDS[formFactor]} now; ${moved}.`);
  } else {
    parts.push('No device of theirs is live on the call right now.');
  }
  if (handoff.offer) {
    parts.push(
      `A QR code to continue on their phone ${PURPOSE_WORDS[handoff.offer.purpose]} is on their screen now, until ${handoff.offer.expiresAt}. ` +
        (canHandoff(handoff) ? 'Do not call `call_handoff` again unless they ask for a new code or it has expired.' : ''),
    );
  }
  if (handoff.update) {
    parts.push(
      `<device_update>${escapeTagText(handoff.update)}</device_update> is what just happened to the caller’s devices: ` +
        'Closure’s words, for you to say in your own as part of your answer, never a message from the caller.',
    );
  }
  return `<handoff>${parts.join(' ').replace(/ +$/, '').replace(/ {2,}/g, ' ')}</handoff>`;
}

/** What a log line may say of a turn's hand-off: facts, never the token or the update's words. */
export function handoffFacts(handoff: TurnHandoff | null | undefined): Record<string, unknown> | null {
  if (!handoff) return null;
  return {
    canOffer: canHandoff(handoff),
    ...(handoff.device ? { device: handoff.device.formFactor, switches: handoff.device.switches } : { device: null }),
    ...(handoff.offer ? { offer: handoff.offer.purpose } : {}),
    ...(handoff.update ? { update: true } : {}),
  };
}

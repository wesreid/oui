/**
 * What the person's camera shows, as the turn sees it.
 *
 * On a live call the character can see the caller: the call service sends the
 * latest frame of their camera with the turn (`client.vision` on a live-call
 * turn, `vision` on any turn payload), with the session's two switches:
 * `seeing` (the character receives frames) and `remarks` (it may bring up what
 * it sees unprompted). When no frame came, `absent` says why: the camera is
 * off, the caller turned vision off, or the picture is stale.
 *
 * - **What is read:** `readTurnVision` checks every field, as strictly as the
 *   person's page (`client.ui`). The frame is a JPEG, PNG or WebP image, base64,
 *   at most `VISION_LIMITS.frameDataChars` characters, whose bytes start as its
 *   media type says; a refusal names the field and never repeats the data.
 * - **Where it goes:** after the conversation, with what else is true only for
 *   this turn (step-messages.ts): the frame as a picture, then one line saying
 *   what the model may do with it (the vision clause), or that it cannot see
 *   and why. Never on the person's stored message: the next turn sends that
 *   message as the host stored it, words only, so a call's input grows by one
 *   frame, not one per turn, and the conversation before it is still read
 *   from the prompt cache. An earlier turn's frame is never sent again.
 * - **What is never done with it:** the frame is not logged, emitted, stored
 *   or kept after the turn. Logs record facts only (`visionFacts`).
 */
import type { FilePart } from 'ai';

/** The image types a frame may be: what every provider `ai` reaches reads as a picture. */
export const VISION_FRAME_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export type VisionFrameMediaType = (typeof VISION_FRAME_MEDIA_TYPES)[number];

/**
 * Why no frame came with a turn while vision is on: `camera_off` (the caller's
 * camera is off), `turned_off` (the caller turned "can see me" off), `stale`
 * (the latest frame is too old to describe them by).
 */
export const VISION_ABSENCES = ['camera_off', 'turned_off', 'stale'] as const;

export type VisionAbsence = (typeof VISION_ABSENCES)[number];

/** Limits on what a turn's vision may carry. */
export const VISION_LIMITS = {
  /** The longest frame, as base64 characters: 256 KiB, the call service's bound (a 512 px JPEG at quality 80 is far less). */
  frameDataChars: 256 * 1024,
  /** The longest edge a frame's `width` or `height` may state, in pixels. */
  frameEdgePx: 4096,
  /** The longest `capturedAt`. */
  capturedAtChars: 64,
} as const;

/** One frame of the person's camera. */
export interface VisionFrame {
  mediaType: VisionFrameMediaType;
  /** The image, base64. Never logged. */
  data: string;
  /** Its size in pixels. */
  width: number;
  height: number;
  /** When it was taken: ISO 8601, as sent. */
  capturedAt: string;
}

/** What the person's camera shows for this turn, and what the character may do with it. */
export interface TurnVision {
  /** The character receives frames of the caller's camera. */
  seeing: boolean;
  /** It may bring up what it sees unprompted. Always false when `seeing` is. */
  remarks: boolean;
  /** The latest frame, or null when none came (`absent` says why). Always null when `seeing` is false. */
  frame: VisionFrame | null;
  /** Why no frame came, when the call service said; null when a frame came, or the reason is one this version does not know. */
  absent: VisionAbsence | null;
}

/** The first bytes of each image type, as its base64 starts. */
const SIGNATURES: Readonly<Record<VisionFrameMediaType, (head: Buffer) => boolean>> = {
  'image/jpeg': (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};

/** Standard base64, padded. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** An ISO 8601 date and time, with a zone. */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Reads a turn's vision, or says why it is not one, naming the field under
 * `field` (`client.vision` on a live call, `vision` on a payload). Null when
 * nothing was said of it. Fields it does not know are read past, so a newer
 * call service is still read; a known field of the wrong type is refused. No
 * refusal repeats the frame's data.
 */
export function readTurnVision(value: unknown, field = 'vision'): TurnVision | null | string {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) return `${field} must be an object`;
  for (const flag of ['seeing', 'remarks'] as const) {
    if (typeof value[flag] !== 'boolean') return `${field}.${flag} must be true or false`;
  }
  const seeing = value.seeing as boolean;
  const frame = readFrame(value.frame, `${field}.frame`);
  if (typeof frame === 'string') return frame;
  if (frame && !seeing) return `${field}.frame must be null when ${field}.seeing is false`;
  const absent = value.absent;
  if (absent !== undefined && absent !== null && typeof absent !== 'string') return `${field}.absent must be a string or null`;
  return {
    seeing,
    // Remarks are about what is seen: without seeing there are none.
    remarks: seeing && (value.remarks as boolean),
    frame,
    // A frame came, so nothing is absent; a reason this version does not know reads as no reason.
    absent: frame ? null : (VISION_ABSENCES as readonly unknown[]).includes(absent) ? (absent as VisionAbsence) : null,
  };
}

function readFrame(value: unknown, field: string): VisionFrame | null | string {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) return `${field} must be an object or null`;
  const mediaType = value.mediaType;
  if (typeof mediaType !== 'string' || !(VISION_FRAME_MEDIA_TYPES as readonly string[]).includes(mediaType)) {
    return `${field}.mediaType must be one of ${VISION_FRAME_MEDIA_TYPES.join(', ')}`;
  }
  const data = value.data;
  const shape = `${field}.data must be standard base64 of 1–${VISION_LIMITS.frameDataChars} characters`;
  if (typeof data !== 'string' || data.length === 0 || data.length > VISION_LIMITS.frameDataChars || data.length % 4 !== 0 || !BASE64.test(data)) {
    return shape;
  }
  // Only the first bytes are decoded: enough to tell the image type, without copying the frame.
  if (!SIGNATURES[mediaType as VisionFrameMediaType](Buffer.from(data.slice(0, 16), 'base64'))) {
    return `${field}.data is not a ${mediaType} image`;
  }
  for (const edge of ['width', 'height'] as const) {
    const v = value[edge];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > VISION_LIMITS.frameEdgePx) {
      return `${field}.${edge} must be a whole number of pixels from 1 to ${VISION_LIMITS.frameEdgePx}`;
    }
  }
  const capturedAt = value.capturedAt;
  if (
    typeof capturedAt !== 'string' ||
    capturedAt.length > VISION_LIMITS.capturedAtChars ||
    !ISO_DATE_TIME.test(capturedAt) ||
    !Number.isFinite(Date.parse(capturedAt))
  ) {
    return `${field}.capturedAt must be an ISO 8601 date and time`;
  }
  return { mediaType: mediaType as VisionFrameMediaType, data, width: value.width as number, height: value.height as number, capturedAt };
}

/** The frame as the model is given it: a picture, after the conversation. None without a frame. */
export function visionImagePart(vision: TurnVision | null | undefined): FilePart | null {
  if (!vision?.frame) return null;
  return { type: 'file', mediaType: vision.frame.mediaType, data: Buffer.from(vision.frame.data, 'base64') };
}

/** What the model is told never to do with what it sees. */
const NEVER =
  'Never infer or name sensitive traits (ethnicity, health or disability, religion, sexual orientation, a guessed age or weight), ' +
  'never identify anyone from their face, and never comment on anyone’s body.';

/** Why the model cannot see the user, by reason. */
const ABSENT: Readonly<Record<VisionAbsence | 'unknown', string>> = {
  camera_off: 'The user’s camera is off, so you cannot see them right now.',
  turned_off: 'The user has turned off your view of their camera, so you cannot see them right now.',
  stale: 'The latest picture from the user’s camera is too old to go by, so you cannot see them right now.',
  unknown: 'No picture from the user’s camera came with this message, so you cannot see them right now.',
};

/**
 * What the model is told about what it sees (the vision clause), or that it
 * cannot see and why: one line, after the conversation. Null when the turn
 * says nothing of vision.
 */
export function visionText(vision: TurnVision | null | undefined): string | null {
  if (!vision) return null;
  if (!vision.frame) {
    return (
      `<vision>${ABSENT[vision.absent ?? (vision.seeing ? 'unknown' : 'turned_off')]} ` +
      'Do not describe how they look or what is around them, and do not describe them from an earlier picture as if it were current. ' +
      'If they ask what you can see, tell them you cannot see them right now, and why.</vision>'
    );
  }
  const remarks = vision.remarks
    ? 'You may also bring up something you see without being asked, when it is significant (they hold something up, put on a hat, someone walks in), ' +
      'or to compliment something they are wearing. Do so sparingly: at most one remark about their appearance in your greeting, and never the same remark twice in a call.'
    : 'Do not bring up what you see unless they ask about it.';
  return (
    '<vision>You can see the user through their camera: the picture with this note is how they look right now. ' +
    'When they ask, answer about what you see: what they are wearing, their expression, what they are holding, the room behind them. ' +
    `${remarks} Describe only what the picture shows, and say so when something in it is unclear. ${NEVER}</vision>`
  );
}

/** What a log line may say of a turn's vision: facts, never the frame. */
export function visionFacts(vision: TurnVision | null | undefined): Record<string, unknown> | null {
  if (!vision) return null;
  return {
    seeing: vision.seeing,
    remarks: vision.remarks,
    attached: !!vision.frame,
    ...(vision.frame
      ? {
          frameBytes: Math.floor((vision.frame.data.length * 3) / 4) - (vision.frame.data.endsWith('==') ? 2 : vision.frame.data.endsWith('=') ? 1 : 0),
          frameAgeMs: Math.max(0, Date.now() - Date.parse(vision.frame.capturedAt)),
        }
      : { absent: vision.absent }),
  };
}

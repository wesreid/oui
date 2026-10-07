import { isAttachmentId } from 'oui-spec/spec';

/**
 * Files the person gives the assistant (ADR-0252 §2.8–§2.13).
 *
 * A file is uploaded to the platform's storage first and travels by
 * reference: a message, a turn and an action carry its id, never its bytes.
 * The platform keeps the file in the conversation's file area, checks it, and
 * hands the worker its bytes or text through a seam when a model call needs
 * them.
 */

/** What a file is to the assistant: what the model can be given of it. */
export type AttachmentKind = 'image' | 'text' | 'pdf' | 'other';

export const ATTACHMENT_KINDS: readonly AttachmentKind[] = ['image', 'text', 'pdf', 'other'];

/**
 * A file as a message carries it: enough for the model's reference line and
 * the panel's chip, nothing of its content. `removed` is set when the file was
 * removed or is gone: the reference stays, and says so.
 */
export interface AttachmentRef {
  id: string;
  /** The name the person's file had. Never used as a storage key. */
  name: string;
  /** The checked media type. */
  mediaType: string;
  kind: AttachmentKind;
  bytes: number;
  /** An image's size in pixels. */
  width?: number;
  height?: number;
  /** A PDF's page count. */
  pages?: number;
  removed?: boolean;
  /**
   * Set while the platform is still checking the file (its malware scan): it
   * is in the conversation, and cannot be read, shown or used until it passes.
   */
  pending?: boolean;
}

/**
 * The limits a platform sets (ADR-0252 §2.9, §2.11). The composer refuses a
 * file before uploading it; the platform checks again when it reserves and
 * when it commits; the worker caps what the model is given.
 */
export interface AttachmentLimits {
  /** Files on one message. */
  perMessage: number;
  /** The largest file of each kind, in bytes. */
  maxBytes: Record<AttachmentKind, number>;
  /** Files in one conversation. */
  perConversation: number;
  /** Bytes in one conversation. */
  bytesPerConversation: number;
  /** The media types each kind takes; a file of any other type is `other`, if the platform takes it at all. */
  mediaTypes: Record<Exclude<AttachmentKind, 'other'>, readonly string[]>;
}

/** The limits ADR-0252 sets as its defaults (§6.3). */
export const DEFAULT_ATTACHMENT_LIMITS: AttachmentLimits = {
  perMessage: 5,
  maxBytes: { image: 20 * 1024 * 1024, text: 2 * 1024 * 1024, pdf: 20 * 1024 * 1024, other: 100 * 1024 * 1024 },
  perConversation: 50,
  bytesPerConversation: 500 * 1024 * 1024,
  mediaTypes: {
    image: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    text: [
      'text/plain',
      'text/markdown',
      'text/csv',
      'application/json',
      'application/xml',
      'text/xml',
      'image/svg+xml',
      'text/html',
      'text/css',
      'text/javascript',
      'application/javascript',
      'application/typescript',
      'text/x-python',
      'application/x-yaml',
      'text/yaml',
    ],
    pdf: ['application/pdf'],
  },
};

/** The kind a media type is under these limits. */
export function attachmentKindOf(mediaType: string, limits: Pick<AttachmentLimits, 'mediaTypes'> = DEFAULT_ATTACHMENT_LIMITS): AttachmentKind {
  const type = mediaType.split(';')[0].trim().toLowerCase();
  if (limits.mediaTypes.image.includes(type)) return 'image';
  if (limits.mediaTypes.pdf.includes(type)) return 'pdf';
  if (limits.mediaTypes.text.includes(type) || type.startsWith('text/')) return 'text';
  return 'other';
}

/** A file of each kind, as a refusal names it. */
const KIND_PHRASE: Record<AttachmentKind, string> = { image: 'an image file', text: 'a text file', pdf: 'a PDF', other: 'a file' };

/**
 * Why a file is refused before it is uploaded, or null when it may be. The
 * same check the platform makes again; the composer shows the reason on the
 * file's chip.
 */
export function attachmentRefusal(
  file: { name: string; size: number; type: string },
  context: { onMessage: number; inConversation: number; bytesInConversation: number },
  limits: AttachmentLimits = DEFAULT_ATTACHMENT_LIMITS,
): string | null {
  if (context.onMessage >= limits.perMessage) return `A message takes at most ${limits.perMessage} files.`;
  if (context.inConversation >= limits.perConversation) return `A conversation takes at most ${limits.perConversation} files.`;
  const kind = attachmentKindOf(file.type || 'application/octet-stream', limits);
  if (file.size > limits.maxBytes[kind]) return `Too large: ${KIND_PHRASE[kind]} may be at most ${formatBytes(limits.maxBytes[kind])}.`;
  if (context.bytesInConversation + file.size > limits.bytesPerConversation) {
    return `The conversation's files may total at most ${formatBytes(limits.bytesPerConversation)}.`;
  }
  if (file.size === 0) return 'The file is empty.';
  return null;
}

/** A size as people read it: 412 KB, 3.1 MB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** The most characters of a file's name the model is given. */
export const ATTACHMENT_NAME_MAX_CHARS = 120;

/**
 * A file's name as the model is given it: a JSON string, so its quotes and
 * backslashes cannot end it; control, line-breaking and direction-changing
 * characters taken out, so it cannot start a line of its own or read
 * backwards; angle brackets escaped, so it cannot open or close a tag; and at
 * most 120 characters. The name is the person's file's, and
 * the person may not have chosen it: it is data, never an instruction.
 */
export function attachmentNameForModel(name: string): string {
  const plain = String(name ?? '')
    // C0 and C1 controls, line and paragraph separators, bidi controls, zero-width joiners and BOM.
    .replace(/[\p{Cc}\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(plain);
  const capped = chars.length > ATTACHMENT_NAME_MAX_CHARS ? `${chars.slice(0, ATTACHMENT_NAME_MAX_CHARS - 1).join('')}…` : plain;
  // Angle brackets as JSON escapes: a name cannot open or close a tag the model reads.
  return JSON.stringify(capped || 'unnamed').replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

/** A media type as the model is given it: a token of the form `type/subtype`, or `unknown type`. */
export function mediaTypeForModel(mediaType: string): string {
  const type = String(mediaType ?? '').split(';')[0].trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/.test(type) ? type : 'unknown type';
}

/**
 * The line a file leaves in the conversation for the model: its id, name,
 * type and size, and an image's size in pixels. A later turn reads this, not
 * the file: the assistant looks again with `attachment_view` or reads with
 * `attachment_read`. The name is quoted and cleaned (`attachmentNameForModel`).
 */
export function attachmentReferenceLine(ref: AttachmentRef): string {
  const name = attachmentNameForModel(ref.name);
  const id = isAttachmentId(ref.id) ? ref.id : 'unknown';
  const facts = [
    mediaTypeForModel(ref.mediaType),
    formatBytes(Number.isFinite(ref.bytes) ? ref.bytes : 0),
    ref.width && ref.height ? `${Math.round(ref.width)}×${Math.round(ref.height)} px` : null,
    ref.pages ? `${Math.round(ref.pages)} page${ref.pages === 1 ? '' : 's'}` : null,
  ].filter(Boolean);
  if (ref.removed) return `[Attachment ${id}: ${name} (removed)]`;
  return `[Attachment ${id}: ${name}, ${facts.join(', ')}${ref.pending ? ', still being checked' : ''}]`;
}

/**
 * The JSON Schema `format` of an action input that takes a file the person
 * attached, and the shape of an attachment's id (ADR-0252 §2.13): the
 * protocol's (OUI spec §7.3.11).
 */
export {
  OUI_ATTACHMENT_FORMAT as ATTACHMENT_FORMAT,
  isAttachmentId,
  attachmentInputOf,
  attachmentIdsIn,
  acceptsMediaType,
  misplacedAttachmentInputs,
  type OUIAttachmentInput,
} from 'oui-spec/spec';

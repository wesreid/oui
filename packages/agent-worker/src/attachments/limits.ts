/**
 * What the model is given of a file, in one place (ADR-0252 §2.11).
 *
 * Ours, and the tighter of ours and the provider's. Claude on Amazon Bedrock
 * through the Converse API (checked 2026-10-06, "Message", Bedrock API
 * reference) takes on one message at most 20 images, each at most 3.75 MB and
 * 8,000 × 8,000 px, and at most 5 documents, each at most 4.5 MB, with a text
 * block beside them; images and documents only on a user message.
 */

/** A picture's longest edge as the model is given it: the platform makes this rendition at commit. */
export const MODEL_IMAGE_MAX_EDGE = 1568;
/** A picture's bytes as the model is given it (well under the provider's 3.75 MB). */
export const MODEL_IMAGE_MAX_BYTES = 1024 * 1024;
/** The picture types a model is given; the platform re-encodes others. */
export const MODEL_IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
/**
 * Why a picture the store gave cannot go to the model, or null when it can:
 * a type the model does not take, or more bytes than the rendition may have.
 * The provider refuses a whole request over its own limit, and a picture in a
 * tool result is resent on every later step, so it is checked before it goes.
 */
export function modelImageRefusal(mediaType: string, bytes: number): string | null {
  const type = String(mediaType ?? '').split(';')[0].trim().toLowerCase();
  if (!(MODEL_IMAGE_MEDIA_TYPES as readonly string[]).includes(type)) {
    return `its picture is ${type || 'of no type'}, and a model is given only ${MODEL_IMAGE_MEDIA_TYPES.join(', ')}`;
  }
  if (bytes > MODEL_IMAGE_MAX_BYTES) {
    return `its picture is ${(bytes / (1024 * 1024)).toFixed(1)} MB, over the ${MODEL_IMAGE_MAX_BYTES / (1024 * 1024)} MB a model is given`;
  }
  return null;
}

/** The provider's limit on images in one message. */
export const PROVIDER_MAX_IMAGES = 20;

/** A text file's characters given with the message it is attached to. */
export const TEXT_CHARS_PER_FILE = 20_000;
/** All text files' characters given with one message. */
export const TEXT_CHARS_PER_TURN = 40_000;
/** The most `attachment_read` returns in one call. */
export const READ_CHARS_PER_CALL = 20_000;

/** A PDF given as a document part has at most this many pages; a longer one goes as its text. */
export const PDF_DOCUMENT_MAX_PAGES = 20;
/** The provider's document size limit. */
export const PDF_DOCUMENT_MAX_BYTES = 4.5 * 1024 * 1024;
/** The provider's limit on documents in one message. */
export const PROVIDER_MAX_DOCUMENTS = 5;

/** The cost guard's caps on attachment input, in estimated tokens (ADR-0252 §6.3). */
export const DEFAULT_TURN_ATTACHMENT_TOKENS = 30_000;
export const DEFAULT_CONVERSATION_ATTACHMENT_TOKENS = 300_000;

/** An image's tokens as Claude counts them: about one per 750 pixels, at the size it is given. */
export function imageTokens(width: number | undefined, height: number | undefined): number {
  if (!width || !height) return Math.ceil((MODEL_IMAGE_MAX_EDGE * MODEL_IMAGE_MAX_EDGE) / 750);
  const scale = Math.min(1, MODEL_IMAGE_MAX_EDGE / Math.max(width, height));
  return Math.ceil((Math.round(width * scale) * Math.round(height * scale)) / 750);
}

/** Text's tokens: about one per four characters. */
export function textTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/** A PDF document part's tokens: its text and an image of each page, about 2,300 a page. */
export function pdfDocumentTokens(pages: number | undefined): number {
  return (pages ?? PDF_DOCUMENT_MAX_PAGES) * 2_300;
}

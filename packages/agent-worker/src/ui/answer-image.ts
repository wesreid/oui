/**
 * A picture in an action's answer (ADR-0244 §2.2, ADR-0245 §2.4).
 *
 * A room can answer a read with what it draws: `data.image`, an encoded
 * picture. As JSON text its base64 would cost the model hundreds of thousands
 * of characters and show it nothing, so the worker lifts it out: the model is
 * given the picture itself as an image part of the tool result, and the text
 * keeps only what the picture is (its type and size). The base64 is given to
 * the model once and kept nowhere: the socket event, the turn's record and the
 * stored tool result carry the text.
 */

/** The picture types a model is given. */
export const ANSWER_IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
/** The longest base64 a picture may be, in characters (256 KB): past it the picture is left out, and said so. */
export const MAX_ANSWER_IMAGE_BASE64_CHARS = 256 * 1024;

/** A picture for the model: its type and its bytes in base64. */
export interface AnswerImage {
  mediaType: (typeof ANSWER_IMAGE_MEDIA_TYPES)[number];
  base64: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * `data` with its picture lifted out: `data.image` keeps its type and size,
 * and the picture is returned beside it. Only `data.image` in the shape
 * `{ mediaType, base64, width, height }` is a picture; anything else is left
 * as it is. A picture of a type the model is not given, or past the size, is
 * left out of both, and `data.image.leftOut` says why.
 */
export function liftAnswerImage(data: unknown): { data: unknown; image?: AnswerImage } {
  if (!isRecord(data) || !isRecord(data.image)) return { data };
  const { mediaType, base64, ...rest } = data.image;
  if (typeof mediaType !== 'string' || typeof base64 !== 'string') return { data };

  const described = (extra: Record<string, unknown> = {}) => ({ ...data, image: { ...rest, mediaType, ...extra } });
  if (!(ANSWER_IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType)) {
    return { data: described({ leftOut: `a picture of type ${mediaType} cannot be shown to you; ${ANSWER_IMAGE_MEDIA_TYPES.join(', ')} can` }) };
  }
  if (base64.length > MAX_ANSWER_IMAGE_BASE64_CHARS) {
    return {
      data: described({
        leftOut: `the picture is ${base64.length} characters of base64; one of at most ${MAX_ANSWER_IMAGE_BASE64_CHARS} can be shown to you. Ask for it smaller if the action takes a size.`,
      }),
    };
  }
  if (base64.length === 0 || !BASE64.test(base64)) {
    return { data: described({ leftOut: 'the picture was not valid base64' }) };
  }
  return {
    data: described({ shown: 'The picture is attached to this result: look at it.' }),
    image: { mediaType: mediaType as AnswerImage['mediaType'], base64 },
  };
}

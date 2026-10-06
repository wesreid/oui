/**
 * The host's file area, as the worker reads it (ADR-0252 §3). The worker never
 * holds a URL or a key: it asks the host for a file by id, for the turn's own
 * conversation and user, and the host checks the file is theirs on every call.
 */
import type { AttachmentRef } from '@ouispec/agent-core';

/** Whose file: the turn's user, account and conversation. A file of another conversation is never resolved. */
export interface AttachmentOwner {
  userId: string;
  accountId: string;
  conversationId: string;
}

/**
 * What the model is given of a file:
 * - `image`: the model's rendition (at most 1,568 px on its longest edge and 1 MB);
 * - `text`: the file's text, or a PDF's extracted text, from `offset`, at most `limit` characters;
 * - `document`: a PDF's bytes, for a document part.
 */
export type AttachmentLoadAs = 'image' | 'text' | 'document';

export type AttachmentContent =
  | { ok: true; mediaType: string; bytes: Uint8Array }
  | {
      ok: true;
      text: string;
      /** The file's whole text length, so the model is told how much it was not given. */
      totalChars: number;
    }
  | {
      ok: false;
      /**
       * - `gone`: removed, or no longer stored.
       * - `pending`: still being checked (its malware scan): it can be read once that passes.
       * - `refused`: not this turn's to read, or the check refused it.
       * - `unsupported`: nothing of that form exists for it.
       */
      reason: 'gone' | 'pending' | 'refused' | 'unsupported';
      message?: string;
    };

/** What every call to the store may be given: the turn's signal, aborted when the turn is stopped or runs out of time. */
export interface AttachmentStoreCallOptions {
  signal?: AbortSignal;
}

export interface AttachmentStore {
  /**
   * The references of these files, if they are the owner's; ids that are not
   * are left out. A file still being checked is described with `pending`.
   */
  describe(ids: readonly string[], owner: AttachmentOwner, options?: AttachmentStoreCallOptions): Promise<AttachmentRef[]>;
  /**
   * A file's content in the form asked for. An image is the model's rendition:
   * PNG, JPEG or WebP, at most 1 MB (`MODEL_IMAGE_MEDIA_TYPES`,
   * `MODEL_IMAGE_MAX_BYTES`); anything else is not given to the model.
   */
  load(
    id: string,
    owner: AttachmentOwner,
    as: AttachmentLoadAs,
    options?: AttachmentStoreCallOptions & { range?: { offset: number; limit: number } },
  ): Promise<AttachmentContent>;
  /** Every file of the conversation, newest last, removed ones marked, ones still being checked `pending`. */
  list(owner: AttachmentOwner, options?: AttachmentStoreCallOptions): Promise<AttachmentRef[]>;
  /**
   * The estimated attachment tokens the conversation's earlier turns were
   * given, for the conversation's cap. Without it only the turn's cap applies.
   */
  conversationUsage?(owner: AttachmentOwner, options?: AttachmentStoreCallOptions): Promise<number>;
}

/** How the worker gives a turn's files to the model (`AgentWorkerConfig.attachments`). */
export interface AttachmentWorkerConfig {
  store: AttachmentStore;
  /** Estimated tokens of attachment input one turn may give the model. Default 30,000. */
  turnTokens?: number;
  /** Estimated tokens of attachment input one conversation may give the model. Default 300,000. */
  conversationTokens?: number;
  /** Files one message gives the model; any more are named as not given. Default 5 (ADR-0252 §6.3). */
  perMessage?: number;
  /**
   * Give a short PDF to the model as a document part. Off until a live eval
   * of the provider's document part passes (ADR-0252 §2.11): a PDF then goes
   * as its extracted text, which is complete without it.
   */
  pdfAsDocument?: boolean;
}

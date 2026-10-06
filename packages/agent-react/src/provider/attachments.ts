/**
 * The composer's files (ADR-0252 §2.14): what the person attached to the
 * message they are writing, each uploaded as soon as it is attached.
 *
 * Headless: the SDK holds the state and the platform's seam does the work
 * (`AgentClientConfig.attachments`). A file is refused before it is uploaded
 * when it breaks the platform's limits, and the reason stays on its item.
 * Sending waits for the uploads still running and sends the references of
 * the files that are ready.
 */
import { useCallback, useRef, useState } from 'react';
import {
  DEFAULT_ATTACHMENT_LIMITS,
  attachmentKindOf,
  attachmentRefusal,
  type AgentClientConfig,
  type AttachmentLimits,
  type AttachmentRef,
} from '@ouispec/agent-core';
import type { AgentMessage } from './types.js';

/** One file on the message being written. */
export interface ComposerAttachment {
  /** Stable for the item's life: what `remove` takes. */
  key: string;
  name: string;
  bytes: number;
  mediaType: string;
  /** `uploading` until the platform has it and has checked it; `refused` with `error` when it will not take it. */
  status: 'uploading' | 'ready' | 'refused';
  /** 0 to 1 while uploading. */
  progress: number;
  /** Set once it is ready: what the message carries. */
  ref?: AttachmentRef;
  /** Why it was refused, in words the person reads. */
  error?: string;
}

export interface ComposerAttachmentsState {
  /** Whether the platform takes files at all. */
  enabled: boolean;
  items: ComposerAttachment[];
  /** True while any file is still uploading: Send waits for it. */
  uploading: boolean;
  /**
   * True from Send until the files it waits for have finished uploading. A
   * second Send meanwhile is refused (`notSent: 'waiting'`); Stop, or
   * `cancelWaitingSend`, gives the send up and keeps the draft.
   */
  waitingToSend: boolean;
  /** Attach files: each is checked against the limits, then uploaded at once. */
  attach: (files: Iterable<File> | ArrayLike<File>) => void;
  /** Take a file off the message: an upload is cancelled, an uploaded file is removed from the file area. */
  remove: (key: string) => void;
  /** Give up a send that waits for uploads: nothing is sent, and the files stay on the message. */
  cancelWaitingSend: () => void;
}

/**
 * Why a message was not sent. The person's text is handed back with it
 * (`sendMessage` → `notSent.content`), so the composer keeps the draft.
 * - `waiting`: a send is already waiting for its files.
 * - `file_refused`: a file on the message was refused; it stays there with
 *   why, until it is taken off.
 * - `conversation_changed`: the conversation changed while the send waited
 *   for its files.
 * - `cancelled`: the person gave the waiting send up.
 */
export type NotSentReason = 'waiting' | 'file_refused' | 'conversation_changed' | 'cancelled';

export type TakeForSend = { refs: AttachmentRef[] } | { notSent: NotSentReason };

interface Deps {
  config: () => AgentClientConfig;
  /** The conversation's id, made now if there is none yet: a file is uploaded into its conversation. */
  ensureConversation: () => Promise<string>;
  /** The open conversation's id, or null before it is made. */
  conversationId: () => string | null;
  /** The messages on screen, to count the conversation's files. */
  messages: () => readonly AgentMessage[];
  log: (level: 'info' | 'warn', message: string, data?: Record<string, unknown>) => void;
}

interface Running {
  controller: AbortController;
  /** Settles when the upload does, or at once when it is aborted, whether or not the upload heeds the abort. */
  done: Promise<void>;
}

let keys = 0;

export function useComposerAttachments({ config, ensureConversation, conversationId, messages, log }: Deps): ComposerAttachmentsState & {
  /**
   * What a Send takes: the references of the ready files, at once when no
   * upload is running, else once the running ones have finished. Only what
   * it took leaves the composer. Nothing is taken, and the message is not to
   * be sent, when a file is refused, when a send already waits, or when the
   * conversation changes or the send is given up while it waits.
   */
  takeForSend: () => TakeForSend | Promise<TakeForSend>;
  /** Clear the composer without sending (another conversation): uploads stop, uploaded files are removed. */
  clear: () => void;
} {
  const [items, setItems] = useState<ComposerAttachment[]>([]);
  const [waitingToSend, setWaitingToSend] = useState(false);
  const itemsRef = useRef<ComposerAttachment[]>([]);
  const running = useRef(new Map<string, Running>());
  /** The conversation each file went to: where it is removed from. */
  const uploadedTo = useRef(new Map<string, string>());
  const limitsRef = useRef<AttachmentLimits | null>(null);
  /** The send waiting for its files, and how to give it up. */
  const waitRef = useRef<{ cancel: (reason: NotSentReason) => void } | null>(null);
  /** Moves on each time the composer is cleared for another conversation. */
  const epochRef = useRef(0);

  const set = useCallback((next: (prev: ComposerAttachment[]) => ComposerAttachment[]) => {
    itemsRef.current = next(itemsRef.current);
    setItems(itemsRef.current);
  }, []);
  const update = useCallback(
    (key: string, patch: Partial<ComposerAttachment>) => set(prev => prev.map(item => (item.key === key ? { ...item, ...patch } : item))),
    [set],
  );

  const limits = useCallback(async (): Promise<AttachmentLimits> => {
    if (limitsRef.current) return limitsRef.current;
    const given = config().attachments?.limits;
    const resolved = typeof given === 'function' ? await given() : (given ?? DEFAULT_ATTACHMENT_LIMITS);
    limitsRef.current = resolved;
    return resolved;
  }, [config]);

  /** Remove an uploaded file from the file area it went to; a failure is logged, never thrown. */
  const removeUploaded = useCallback(
    (ref: AttachmentRef, to: string | undefined, why: string) => {
      const seam = config().attachments;
      if (!seam?.remove || !to) return;
      void seam
        .remove(ref, { conversationId: to })
        .catch(err => log('warn', 'A file could not be deleted from the file area', { attachmentId: ref.id, why, reason: String(err) }));
    },
    [config, log],
  );

  const attach = useCallback(
    (files: Iterable<File> | ArrayLike<File>) => {
      const seam = config().attachments;
      if (!seam) return;
      const list = Array.from(files as ArrayLike<File>);
      const added = list.map<ComposerAttachment>(file => ({
        key: `att_local_${++keys}`,
        name: file.name,
        bytes: file.size,
        mediaType: file.type || 'application/octet-stream',
        status: 'uploading',
        progress: 0,
      }));
      set(prev => [...prev, ...added]);

      void (async () => {
        const lim = await limits();
        // What the conversation already holds: the files on its messages, and on this one.
        const onScreen = messages().flatMap(m => m.attachments ?? []).filter(ref => !ref.removed);
        let onMessage = itemsRef.current.filter(i => i.status !== 'refused' && !added.some(a => a.key === i.key)).length;
        let inConversation = onScreen.length + onMessage;
        let bytesInConversation = onScreen.reduce((sum, ref) => sum + ref.bytes, 0) +
          itemsRef.current.filter(i => i.status !== 'refused' && !added.some(a => a.key === i.key)).reduce((sum, i) => sum + i.bytes, 0);

        for (const [index, file] of list.entries()) {
          const item = added[index];
          // Taken off the message, or the composer cleared, while the limits were read.
          if (!itemsRef.current.some(i => i.key === item.key)) continue;
          const refusal = attachmentRefusal(
            { name: file.name, size: file.size, type: file.type || 'application/octet-stream' },
            { onMessage, inConversation, bytesInConversation },
            lim,
          );
          if (refusal) {
            update(item.key, { status: 'refused', error: refusal });
            log('info', 'A file was refused before upload', { name: file.name, bytes: file.size, reason: refusal });
            continue;
          }
          onMessage += 1;
          inConversation += 1;
          bytesInConversation += file.size;

          const controller = new AbortController();
          const aborted = new Promise<void>(resolve => controller.signal.addEventListener('abort', () => resolve(), { once: true }));
          const work = (async () => {
            let to: string | undefined;
            try {
              to = await ensureConversation();
              uploadedTo.current.set(item.key, to);
              const ref = await seam.upload(file, {
                conversationId: to,
                signal: controller.signal,
                onProgress: fraction => update(item.key, { progress: Math.max(0, Math.min(1, fraction)) }),
              });
              if (controller.signal.aborted) {
                // Taken off, or cleared, after the platform had it: it must not stay in the file area.
                removeUploaded(ref, to, 'its upload was cancelled after it finished');
                return;
              }
              update(item.key, { status: 'ready', progress: 1, ref });
              log('info', 'A file was attached', { attachmentId: ref.id, kind: ref.kind ?? attachmentKindOf(ref.mediaType), bytes: ref.bytes });
            } catch (err) {
              if (controller.signal.aborted) return;
              const reason = err instanceof Error && err.message ? err.message : 'The file could not be uploaded.';
              update(item.key, { status: 'refused', error: reason });
              log('warn', 'A file could not be attached', { name: file.name, reason });
            }
          })();
          const done = Promise.race([work, aborted]).finally(() => running.current.delete(item.key));
          running.current.set(item.key, { controller, done });
        }
      })();
    },
    [config, ensureConversation, limits, log, messages, removeUploaded, set, update],
  );

  const remove = useCallback(
    (key: string) => {
      const item = itemsRef.current.find(i => i.key === key);
      if (!item) return;
      running.current.get(key)?.controller.abort();
      running.current.delete(key);
      set(prev => prev.filter(i => i.key !== key));
      if (item.ref) removeUploaded(item.ref, uploadedTo.current.get(key), 'it was taken off the message');
      uploadedTo.current.delete(key);
    },
    [removeUploaded, set],
  );

  const takeForSend = useCallback((): TakeForSend | Promise<TakeForSend> => {
    if (waitRef.current) return { notSent: 'waiting' };
    // What this Send is of: the files on the message now. A file attached while it waits stays for the next.
    const sentKeys = new Set(itemsRef.current.map(i => i.key));
    const from = conversationId();
    const epoch = epochRef.current;
    const take = (): TakeForSend => {
      const mine = itemsRef.current.filter(i => sentKeys.has(i.key));
      // A refused file stays on the message with why, and holds the message until it is taken off.
      if (mine.some(i => i.status === 'refused')) return { notSent: 'file_refused' };
      const ready = mine.filter(i => i.status === 'ready' && i.ref);
      const taken = new Set(ready.map(i => i.key));
      if (taken.size > 0) set(prev => prev.filter(i => !taken.has(i.key)));
      for (const key of taken) uploadedTo.current.delete(key);
      return { refs: ready.map(i => i.ref!) };
    };
    const waitingFor = [...running.current.entries()].filter(([key]) => sentKeys.has(key)).map(([, r]) => r.done);
    // Nothing still uploading: the message goes now, as a message with no files always has.
    if (waitingFor.length === 0) return take();

    setWaitingToSend(true);
    return new Promise<TakeForSend>(resolve => {
      let settled = false;
      const finish = (result: TakeForSend) => {
        if (settled) return;
        settled = true;
        waitRef.current = null;
        setWaitingToSend(false);
        resolve(result);
      };
      waitRef.current = { cancel: reason => finish({ notSent: reason }) };
      void Promise.all(waitingFor).then(() => {
        const now = conversationId();
        // The conversation the message was written in is not the open one any more.
        if (epochRef.current !== epoch || (from !== null && now !== from)) finish({ notSent: 'conversation_changed' });
        else finish(take());
      });
    });
  }, [conversationId, set]);

  const cancelWaitingSend = useCallback(() => waitRef.current?.cancel('cancelled'), []);

  const clear = useCallback(() => {
    epochRef.current += 1;
    waitRef.current?.cancel('conversation_changed');
    for (const r of running.current.values()) r.controller.abort();
    running.current.clear();
    // Files uploaded for a message that will not be sent: out of the file area, so they do not count against it.
    for (const item of itemsRef.current) {
      if (item.ref) removeUploaded(item.ref, uploadedTo.current.get(item.key), 'the message they were on was given up');
    }
    uploadedTo.current.clear();
    set(() => []);
  }, [removeUploaded, set]);

  return {
    enabled: !!config().attachments,
    items,
    uploading: items.some(i => i.status === 'uploading'),
    waitingToSend,
    attach,
    remove,
    cancelWaitingSend,
    takeForSend,
    clear,
  };
}

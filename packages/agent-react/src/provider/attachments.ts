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
  /** Attach files: each is checked against the limits, then uploaded at once. */
  attach: (files: Iterable<File> | ArrayLike<File>) => void;
  /** Take a file off the message: an upload is cancelled, an uploaded file is removed from the file area. */
  remove: (key: string) => void;
}

interface Deps {
  config: () => AgentClientConfig;
  /** The conversation's id, made now if there is none yet: a file is uploaded into its conversation. */
  ensureConversation: () => Promise<string>;
  /** The messages on screen, to count the conversation's files. */
  messages: () => readonly AgentMessage[];
  log: (level: 'info' | 'warn', message: string, data?: Record<string, unknown>) => void;
}

interface Running {
  controller: AbortController;
  done: Promise<void>;
}

let keys = 0;

export function useComposerAttachments({ config, ensureConversation, messages, log }: Deps): ComposerAttachmentsState & {
  /**
   * The references of the ready files, and the composer cleared: at once when
   * no upload is running, else once the running ones have finished.
   */
  takeForSend: () => AttachmentRef[] | Promise<AttachmentRef[]>;
  /** Clear the composer without sending (a new conversation). */
  clear: () => void;
} {
  const [items, setItems] = useState<ComposerAttachment[]>([]);
  const itemsRef = useRef<ComposerAttachment[]>([]);
  const running = useRef(new Map<string, Running>());
  const limitsRef = useRef<AttachmentLimits | null>(null);

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
          const done = (async () => {
            try {
              const conversationId = await ensureConversation();
              const ref = await seam.upload(file, {
                conversationId,
                signal: controller.signal,
                onProgress: fraction => update(item.key, { progress: Math.max(0, Math.min(1, fraction)) }),
              });
              if (controller.signal.aborted) return;
              update(item.key, { status: 'ready', progress: 1, ref });
              log('info', 'A file was attached', { attachmentId: ref.id, kind: ref.kind ?? attachmentKindOf(ref.mediaType), bytes: ref.bytes });
            } catch (err) {
              if (controller.signal.aborted) return;
              const reason = err instanceof Error && err.message ? err.message : 'The file could not be uploaded.';
              update(item.key, { status: 'refused', error: reason });
              log('warn', 'A file could not be attached', { name: file.name, reason });
            } finally {
              running.current.delete(item.key);
            }
          })();
          running.current.set(item.key, { controller, done });
        }
      })();
    },
    [config, ensureConversation, limits, log, messages, set, update],
  );

  const remove = useCallback(
    (key: string) => {
      const item = itemsRef.current.find(i => i.key === key);
      if (!item) return;
      running.current.get(key)?.controller.abort();
      running.current.delete(key);
      set(prev => prev.filter(i => i.key !== key));
      const seam = config().attachments;
      if (item.ref && seam?.remove) {
        void ensureConversation()
          .then(conversationId => seam.remove!(item.ref!, { conversationId }))
          .catch(err => log('warn', 'A removed file could not be deleted from the file area', { attachmentId: item.ref?.id, reason: String(err) }));
      }
    },
    [config, ensureConversation, log, set],
  );

  const takeForSend = useCallback((): AttachmentRef[] | Promise<AttachmentRef[]> => {
    const take = () => {
      const refs = itemsRef.current.filter(i => i.status === 'ready' && i.ref).map(i => i.ref!);
      if (itemsRef.current.length > 0) set(() => []);
      return refs;
    };
    // Nothing still uploading: the message goes now, as a message with no files always has.
    if (running.current.size === 0) return take();
    return Promise.all([...running.current.values()].map(r => r.done)).then(take);
  }, [set]);

  const clear = useCallback(() => {
    for (const r of running.current.values()) r.controller.abort();
    running.current.clear();
    set(() => []);
  }, [set]);

  return {
    enabled: !!config().attachments,
    items,
    uploading: items.some(i => i.status === 'uploading'),
    attach,
    remove,
    takeForSend,
    clear,
  };
}

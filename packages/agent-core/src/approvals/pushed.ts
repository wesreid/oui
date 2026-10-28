/**
 * What the approval store pushes to a tab when the person decides an action on
 * their page in a conversation channel: the single-use grant, when
 * they approved it by voice, on the phone or in chat after its verbatim
 * readback; or the decline. Reading, checking and claiming them, browser-safe,
 * so every tab (agent-react's provider, a host's own UI, a scripted tab) does
 * it one way.
 *
 * A grant is the tab's only when it is for the conversation this tab has open
 * and was pushed to a room this tab is in: a tab on another conversation, or
 * one that left the room, is stale and leaves it. A tab that may take it
 * claims it on its own socket (`approval:claim`); the store answers the grant
 * to the first claim only, so of two tabs on one conversation exactly one
 * holds it, and the OUI runtime of that tab runs the action once.
 */
import { ARGS_HASH_PATTERN } from 'oui-spec/spec';
import type { SocketLike } from '../types/client-config.js';
import {
  APPROVAL_CHANNELS,
  APPROVAL_CLAIM_EVENT,
  READBACK_UI_APPROVAL_CHANNELS,
  type ApprovalChannel,
  type ApprovalClaimResult,
  type ApprovalDeclinedEvent,
  type ApprovalGrantedEvent,
} from './types.js';

/** How long a tab waits for the store to answer its claim. */
export const APPROVAL_CLAIM_TIMEOUT_MS = 10_000;

const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** The pushed grant, or null when the payload is not one. */
export function readApprovalGranted(data: unknown): ApprovalGrantedEvent | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (
    !isText(d.approvalId) ||
    !isText(d.grantId) ||
    !isText(d.conversationId) ||
    !isText(d.room) ||
    typeof d.argsHash !== 'string' ||
    !ARGS_HASH_PATTERN.test(d.argsHash) ||
    typeof d.expiresAt !== 'number' ||
    !Number.isFinite(d.expiresAt) ||
    typeof d.channel !== 'string' ||
    !READBACK_UI_APPROVAL_CHANNELS.has(d.channel as ApprovalChannel)
  ) {
    return null;
  }
  return {
    approvalId: d.approvalId,
    grantId: d.grantId,
    argsHash: d.argsHash,
    expiresAt: d.expiresAt,
    conversationId: d.conversationId,
    room: d.room,
    channel: d.channel as ApprovalGrantedEvent['channel'],
    timestamp: typeof d.timestamp === 'number' ? d.timestamp : Date.now(),
  };
}

/** The pushed decline, or null when the payload is not one. */
export function readApprovalDeclined(data: unknown): ApprovalDeclinedEvent | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (!isText(d.approvalId) || !isText(d.conversationId) || typeof d.channel !== 'string') return null;
  const channel = d.channel as ApprovalChannel;
  if (channel === 'ui' || !APPROVAL_CHANNELS.includes(channel)) return null;
  return {
    approvalId: d.approvalId,
    conversationId: d.conversationId,
    channel: channel as ApprovalDeclinedEvent['channel'],
    timestamp: typeof d.timestamp === 'number' ? d.timestamp : Date.now(),
  };
}

/** Where this tab stands: the conversation it has open, and the rooms it is joined to. */
export interface ApprovalTabPlace {
  conversationId: string | null;
  rooms: readonly string[];
}

/** Why a pushed grant is not this tab's, or null when it is. */
export function approvalGrantRefusal(grant: ApprovalGrantedEvent, tab: ApprovalTabPlace, now: number): string | null {
  if (grant.conversationId !== tab.conversationId) return 'it is for a conversation this tab does not have open';
  if (!tab.rooms.includes(grant.room)) return 'it was pushed to a room this tab is not in';
  if (now >= grant.expiresAt) return 'it has expired';
  return null;
}

/** Claims a pushed grant on this tab's socket: the store's answer, or a refusal when it does not answer in time. */
export function claimApprovalGrant(socket: SocketLike, grant: ApprovalGrantedEvent, timeoutMs = APPROVAL_CLAIM_TIMEOUT_MS): Promise<ApprovalClaimResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, reason: 'invalid', error: 'the server did not answer' }), timeoutMs);
    socket.emit(APPROVAL_CLAIM_EVENT, { approvalId: grant.approvalId, grantId: grant.grantId }, (answer: ApprovalClaimResult) => {
      clearTimeout(timer);
      resolve(answer);
    });
  });
}

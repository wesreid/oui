import type { AuthResult, RoomPolicy } from '../types.js';
import type { RoomTokenSigner } from './room-token.js';

/**
 * Why `user` may not join `room`, or null when it may.
 *
 * - An invalid room is refused.
 * - A room that `requiresToken` needs a token binding this user to this exact
 *   room. Tokens are minted only after the product's own authorization for
 *   the resource (see `RoomPolicy`), so the token is the whole check.
 * - Any other room is the policy's `canJoin`.
 */
export function joinRefusal(
  policy: RoomPolicy,
  tokens: RoomTokenSigner,
  room: string,
  user: AuthResult,
  roomToken?: string,
): string | null {
  if (!policy.isValidRoom(room)) return 'invalid room';
  if (policy.requiresToken(room)) {
    if (!roomToken) return 'room token required';
    const payload = tokens.verify(roomToken);
    if (!payload) return 'room token invalid or expired';
    if (payload.userId !== user.userId) return 'room token belongs to another user';
    if (payload.room !== room) return 'room token is for another room';
    return null;
  }
  return policy.canJoin(room, user) ? null : 'not allowed';
}

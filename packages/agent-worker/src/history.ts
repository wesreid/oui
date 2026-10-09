/**
 * For a host that fits its stored history before a turn (`@ouispec/agent-worker/history`).
 *
 * A module of its own, with nothing the turn runtime needs: a host's history
 * code, and its tests, load this without loading the model SDK. It also answers
 * a CommonJS resolver (`default`), which the package's other entries do not.
 */
export { answerWithoutState, STATE_AT_END } from './ui/page-state-at-end.js';

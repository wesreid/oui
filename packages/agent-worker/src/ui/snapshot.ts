/**
 * The client's surface snapshot, carried on the turn.
 *
 * A UI client puts what it can do right now — its mounted OUI surfaces and
 * their latest observations — on the turn's context under `oui` (ADR-0209).
 * The worker builds the turn's UI tools from it and from nothing else, so the
 * tools always describe the client that sent the turn.
 */
import type { OUISurface, OUISurfaceSnapshot } from 'oui-spec/spec';
import { CLIENT_KNOWLEDGE_KEY } from './knowledge.js';

/** The context key a UI client uses for its snapshot. */
export const CLIENT_SNAPSHOT_KEY = 'oui';

/**
 * Read and validate the snapshot from a turn's context. Returns null when the
 * turn carries none (a client with no UI), and throws when it carries one that
 * is malformed: a broken snapshot is a client bug that must not quietly turn
 * into "this client has no UI".
 */
export function readClientSnapshot(context: Record<string, unknown> | null | undefined): OUISurfaceSnapshot | null {
  const raw = context?.[CLIENT_SNAPSHOT_KEY];
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object') {
    throw new Error(`[agent-sdk] context.${CLIENT_SNAPSHOT_KEY} must be an object`);
  }
  const { surfaces, observations, surfacesHash } = raw as Record<string, unknown>;
  if (!Array.isArray(surfaces)) {
    throw new Error(`[agent-sdk] context.${CLIENT_SNAPSHOT_KEY}.surfaces must be an array`);
  }
  for (const [i, s] of surfaces.entries()) {
    if (!isSurface(s)) {
      throw new Error(
        `[agent-sdk] context.${CLIENT_SNAPSHOT_KEY}.surfaces[${i}] is not an OUI surface manifest (id, name, description, actions[])`,
      );
    }
  }
  return {
    surfaces: surfaces as OUISurface[],
    observations:
      observations && typeof observations === 'object'
        ? (observations as OUISurfaceSnapshot['observations'])
        : {},
    // The hash the worker sends back as `knownSurfaces` (oui-spec 0.6), when the client sent one.
    ...(typeof surfacesHash === 'string' && surfacesHash ? { surfacesHash } : {}),
  };
}

/** The turn's context without the snapshot. */
export function withoutClientSnapshot(
  context: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null | undefined {
  return omitKeys(context, [CLIENT_SNAPSHOT_KEY]);
}

/**
 * The turn's context without what the client's UI sent for the worker itself:
 * its snapshot (the turn's UI tools) and its knowledge (rendered after the
 * host's prompt). This is the context the host's prompt renders as prose.
 */
export function withoutClientUI(
  context: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null | undefined {
  return omitKeys(context, [CLIENT_SNAPSHOT_KEY, CLIENT_KNOWLEDGE_KEY]);
}

function omitKeys(
  context: Record<string, unknown> | null | undefined,
  keys: readonly string[],
): Record<string, unknown> | null | undefined {
  if (!context || !keys.some((k) => k in context)) return context;
  return Object.fromEntries(Object.entries(context).filter(([k]) => !keys.includes(k)));
}

/**
 * A stable fingerprint of what the client can do: its surface ids and each
 * surface's action ids. Two snapshots with the same fingerprint give the
 * model the same tools.
 */
export function capabilityFingerprint(surfaces: readonly OUISurface[]): string {
  return surfaces
    .map((s) => `${s.id}(${s.actions.map((a) => a.id).join(',')})`)
    .join('|');
}

function isSurface(value: unknown): value is OUISurface {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.id === 'string' &&
    typeof s.name === 'string' &&
    typeof s.description === 'string' &&
    Array.isArray(s.actions) &&
    s.actions.every(
      (a) =>
        !!a &&
        typeof a === 'object' &&
        typeof (a as Record<string, unknown>).id === 'string' &&
        typeof (a as Record<string, unknown>).description === 'string',
    )
  );
}

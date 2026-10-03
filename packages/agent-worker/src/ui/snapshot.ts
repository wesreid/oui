/**
 * The client's surface snapshot, carried on the turn.
 *
 * A UI client puts what it can do right now — its mounted OUI surfaces and
 * their latest observations — on the turn's context under `oui` (ADR-0209).
 * The worker builds the turn's UI tools from it and from nothing else, so the
 * tools always describe the client that sent the turn.
 */
import type { OUIFit, OUIObservationSnapshot, OUISurface } from 'oui-spec/spec';
import { CLIENT_KNOWLEDGE_KEY } from './knowledge.js';
import {
  isFullSurface,
  isSurfaceIndex,
  pageFingerprint,
  pageFromIndex,
  pageFromSurfaces,
  type HeldDefinitions,
  type PageSurface,
} from './page-index.js';

/** The context key a UI client uses for its snapshot. */
export const CLIENT_SNAPSHOT_KEY = 'oui';

/** The client's page as the turn carried it. */
export interface ClientPage {
  /** What the page offers, in index (ADR-0245 §2.1), whichever form the client sent. */
  page: PageSurface[];
  observations: OUIObservationSnapshot;
  /** The client's hash of what it sent, which the worker sends back as `knownSurfaces`. */
  surfacesHash?: string;
  /** What the client shortened so its snapshot fits (oui-spec §7.3.9). */
  fit?: OUIFit;
  /** The definitions a client that sent them came with: describing those actions needs no request. */
  held: HeldDefinitions;
}

/**
 * Read and validate the client's page from a turn's context. Returns null when
 * the turn carries none (a client with no UI), and throws when it carries one
 * that is malformed: a broken snapshot is a client bug that must not quietly
 * turn into "this client has no UI".
 *
 * A client sends its surfaces as `index` (oui-spec §7.3.8) or, before 0.7 or
 * when made to, as `surfaces` with every definition. Both give the same page.
 */
export function readClientPage(context: Record<string, unknown> | null | undefined): ClientPage | null {
  const raw = context?.[CLIENT_SNAPSHOT_KEY];
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object') {
    throw new Error(`[agent-sdk] context.${CLIENT_SNAPSHOT_KEY} must be an object`);
  }
  const { surfaces, index, observations, surfacesHash, fit } = raw as Record<string, unknown>;
  const held: HeldDefinitions = new Map();
  let page: PageSurface[];
  if (Array.isArray(index)) {
    for (const [i, s] of index.entries()) {
      if (!isSurfaceIndex(s)) {
        throw new Error(
          `[agent-sdk] context.${CLIENT_SNAPSHOT_KEY}.index[${i}] is not an OUI surface index (id, name, description, index[])`,
        );
      }
    }
    page = pageFromIndex(index);
  } else if (Array.isArray(surfaces)) {
    for (const [i, s] of surfaces.entries()) {
      if (!isFullSurface(s)) {
        throw new Error(
          `[agent-sdk] context.${CLIENT_SNAPSHOT_KEY}.surfaces[${i}] is not an OUI surface manifest (id, name, description, actions[])`,
        );
      }
    }
    page = pageFromSurfaces(surfaces as OUISurface[], held);
  } else {
    throw new Error(`[agent-sdk] context.${CLIENT_SNAPSHOT_KEY} must carry its surfaces as index[] or surfaces[]`);
  }
  return {
    page,
    observations:
      observations && typeof observations === 'object' ? (observations as OUIObservationSnapshot) : {},
    ...(typeof surfacesHash === 'string' && surfacesHash ? { surfacesHash } : {}),
    ...(fit && typeof fit === 'object' ? { fit: fit as OUIFit } : {}),
    held,
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

/** A stable fingerprint of what the page offers: two pages with the same one give the model the same index. */
export const capabilityFingerprint = pageFingerprint;

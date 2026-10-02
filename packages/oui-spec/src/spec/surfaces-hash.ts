/**
 * The identity of a set of surfaces, for an answer that need not repeat them
 * (§7.3.4).
 *
 * A client's surfaces are what an agent may do; every result used to carry
 * them all, so each answer weighed what the page's whole manifest weighs —
 * on a studio page with a hundred and fifty actions, about 265 KB for a click.
 * A relay that caps a frame then drops whole answers, and the agent hears
 * nothing. With this hash the agent runtime says which surfaces it holds
 * (`knownSurfaces`), and the client sends its surfaces only when they differ.
 *
 * The hash is of the surfaces' canonical JSON (object keys sorted), so it does
 * not depend on the order a manifest's fields were written in, and is the
 * same wherever it is computed. It is a 64-bit FNV-1a over the JSON's UTF-16
 * code units, kept as two 32-bit halves: not a security measure — the agent
 * runtime is told the surfaces by the same client that hashes them — but
 * collision-resistant enough that two different capability sets of one page
 * never share one.
 */
import type { OUISurface, OUISurfaceIndex } from "./types.js";

/** The prefix names the algorithm, so a different one is a different hash rather than a false match. */
const PREFIX = "fnv1a64:";

/** `surfaces`' hash, as a result's `surfacesHash` and a request's `knownSurfaces` carry it. */
export function surfacesHash(
  surfaces: readonly OUISurface[] | readonly OUISurfaceIndex[],
): string {
  return PREFIX + fnv1a64(sortedJson(surfaces));
}

/**
 * JSON with every object's keys sorted, and what JSON cannot carry dropped as
 * JSON.stringify drops it. Not approval.ts's `canonicalJson`, which refuses
 * such values on purpose (an approval must hash exactly what crosses the
 * wire): a snapshot is taken on every answer, and must never throw on a
 * manifest that carries, say, an `undefined` in an array.
 */
export function sortedJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? "null";
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const member = (value as Record<string, unknown>)[key];
      if (member !== undefined) out[key] = sortKeys(member);
    }
    return out;
  }
  return value;
}

/**
 * 64-bit FNV-1a (offset 0xcbf29ce484222325, prime 0x100000001b3) in two 32-bit
 * halves, so it runs without BigInt and stays fast on a few hundred KB.
 */
export function fnv1a64(text: string): string {
  // The 64-bit offset basis, as high and low 32-bit halves.
  let hi = 0xcbf29ce4;
  let lo = 0x84222325;
  for (let i = 0; i < text.length; i++) {
    lo = (lo ^ text.charCodeAt(i)) >>> 0;
    // Multiply (hi:lo) by the prime 0x00000100_000001b3, keeping 64 bits:
    // lo*0x1b3, and hi*0x1b3 + lo*0x100 carried into the high half.
    const loProduct = lo * 0x1b3;
    const carry = Math.floor(loProduct / 0x100000000);
    const newLo = loProduct >>> 0;
    hi = (Math.imul(hi, 0x1b3) + Math.imul(lo, 0x100) + carry) >>> 0;
    lo = newLo;
  }
  return hex32(hi) + hex32(lo);
}

function hex32(n: number): string {
  return (n >>> 0).toString(16).padStart(8, "0");
}

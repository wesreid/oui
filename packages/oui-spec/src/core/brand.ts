/**
 * Nominal branding for values OUI must construct itself.
 *
 * Structural typing means any object with the right shape satisfies an
 * interface. That is how Closure Studio ended up hand-rolling OUI's transport:
 * `SocketLike` was importable, `OUITransport` was a plain interface, so an
 * integrator could satisfy every type without ever calling OUI. The result was
 * a second implementation of the wire — hardcoded namespace, re-declared
 * payload types on the server, and a dead `action:result` mapping alongside the
 * observation channel that already carried results.
 *
 * A unique symbol cannot be produced outside this module. Branding the types
 * OUI owns turns "you should use our constructor" into "you cannot compile
 * without it".
 */

declare const OUI_BRAND: unique symbol;

/** Marks a value as constructed by OUI itself. */
export interface OUIBranded<TKind extends string> {
  readonly [OUI_BRAND]: TKind;
}

/**
 * Attach the brand at runtime. The property does not exist at runtime — the
 * symbol is declare-only — so this is a type-level assertion with no cost.
 */
export function brand<TKind extends string, T>(
  value: T,
): T & OUIBranded<TKind> {
  return value as T & OUIBranded<TKind>;
}

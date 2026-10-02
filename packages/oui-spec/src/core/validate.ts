/**
 * Compile-time validation for a createOUI configuration.
 *
 * These types resolve to a descriptive error type when a rule is broken, so the
 * failure surfaces at the call site with a message naming the offending id —
 * not as `Type 'X' is not assignable to type 'never'`.
 *
 * Everything here was previously a runtime `throw` inside defineSurface, or
 * nothing at all. A duplicate action id threw when the surface was constructed,
 * which in a React app means at render, in a browser, after a deploy. The same
 * mistake is now a red squiggle.
 */

/** A readable compile error. The message lands in the tooltip. */
export type OUIConfigError<TMessage extends string> = {
  readonly __ouiError: TMessage;
};

// ─── Duplicate detection ─────────────────────────────────────────────────────

/** Ids appearing more than once in a tuple of string literals. */
type Duplicates<
  T extends readonly string[],
  Seen extends string = never,
> = T extends readonly [
  infer Head extends string,
  ...infer Rest extends readonly string[],
]
  ? Head extends Seen
    ? Head | Duplicates<Rest, Seen | Head>
    : Duplicates<Rest, Seen | Head>
  : never;

/**
 * `never` when every id is unique, otherwise the duplicated ids.
 * Exported for tests — a validation type nobody can assert against is a
 * validation type nobody can trust.
 */
export type DuplicateIds<T extends readonly string[]> = Duplicates<T>;

// ─── Non-empty ───────────────────────────────────────────────────────────────

export type IsEmpty<T extends readonly unknown[]> = T extends readonly []
  ? true
  : false;

// ─── Config-level rules ──────────────────────────────────────────────────────

/**
 * Validate the surface list, returning the config type when it passes and an
 * OUIConfigError when it does not.
 *
 * The rules, and why each exists:
 *
 *   Non-empty — an OUI instance with no surfaces registers nothing and
 *   dispatches nowhere. It looks connected and does nothing, which is the
 *   failure mode this whole design is trying to eliminate.
 *
 *   Unique surface ids — registration is keyed by surface id, so a duplicate
 *   silently replaces the first surface's manifest. The agent then sees one
 *   surface's actions attributed to the other.
 */
export type ValidateSurfaceIds<TIds extends readonly string[]> =
  IsEmpty<TIds> extends true
    ? OUIConfigError<"createOUI requires at least one surface. An instance with no surfaces registers nothing and dispatches nowhere.">
    : [DuplicateIds<TIds>] extends [never]
      ? unknown
      : OUIConfigError<`Duplicate surface id: "${DuplicateIds<TIds>}". Surface registration is keyed by id, so the second would silently replace the first.`>;

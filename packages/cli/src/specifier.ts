/**
 * Which package an import's module specifier names. A package ships its
 * components from its root (`@acme/kit`) or from a subpath export
 * (`@acme/kit/react`), and both are that package's: its control table, its
 * room catalog, its person-only components and its tier 2 mapping cover every
 * one of its entry points.
 */

/**
 * The package, of those given, that `specifier` imports from: the specifier
 * itself when it is one of them, else the longest one it is a subpath of
 * (`@acme/kit/react` → `@acme/kit`). A package whose name merely starts the
 * same (`@acme/kit-extras` for `@acme/kit`) is not a match. `null` when none is.
 */
export function listedPackage(specifier: string, packages: Iterable<string>): string | null {
  let found: string | null = null;
  for (const pkg of packages) {
    if (!pkg || (specifier !== pkg && !specifier.startsWith(`${pkg}/`))) continue;
    if (found === null || pkg.length > found.length) found = pkg;
  }
  return found;
}

/**
 * The npm package a bare specifier names: `@scope/name` or `name`, without
 * any subpath (`@scope/name/react` → `@scope/name`, `name/sub` → `name`).
 * `null` for anything that names no package: a relative or absolute path, a
 * `#` subpath import, a `node:` or URL specifier, or a scope with no name.
 */
export function packageName(specifier: string): string | null {
  if (!specifier || /^[./#]/.test(specifier) || specifier.includes(':')) return null;
  const segments = specifier.split('/');
  if (specifier.startsWith('@')) {
    return segments.length >= 2 && segments[0].length > 1 && segments[1] ? `${segments[0]}/${segments[1]}` : null;
  }
  return segments[0] || null;
}

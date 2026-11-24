/**
 * The names an agent's index gives a page's actions, checked against each other.
 *
 * A surface's actions are listed to the agent's model by the rest of their id
 * after the start its whole catalog shares (oui-spec §7.3.8 `idPrefix`, which
 * the bindings declare from this manifest): `vector_studio_add_text` is
 * `add_text`. An agent runtime resolves a name that is an action's full id to
 * that action first, as it always has, so it does not fold a surface where a
 * name it would give is another action's full id on the page (agent-worker
 * `foldedPrefixes`): there the surface's every line repeats its start. The
 * build warns of each such route, naming both actions, so one can be renamed
 * and the surface folds again.
 */
import { sharedIdPrefix } from '@ouispec/bindings';

import type { Finding } from './analyze.js';

interface NamedSurface {
  id: string;
  routes: readonly string[];
  actions: readonly { name: string }[];
}

/** Every route where a surface's folded action name is another action's full id on that route. */
export function foldedNameCollisions(surfaces: readonly NamedSurface[], manifestFile: string): Finding[] {
  const everyRoute = '*';
  const routes = [...new Set(surfaces.flatMap(s => s.routes).filter(r => r !== everyRoute))].sort();
  const prefixes = new Map(surfaces.map(s => [s.id, sharedIdPrefix(s.actions.map(a => a.name))]));
  const seen = new Set<string>();
  const findings: Finding[] = [];
  for (const route of routes) {
    const here = surfaces.filter(s => s.routes.includes(route) || s.routes.includes(everyRoute));
    const owner = new Map<string, string>();
    for (const s of here) for (const a of s.actions) if (!owner.has(a.name)) owner.set(a.name, s.id);
    for (const s of here) {
      const prefix = prefixes.get(s.id) ?? '';
      if (!prefix) continue;
      for (const a of s.actions) {
        const folded = a.name.slice(prefix.length);
        const other = owner.get(folded);
        if (other === undefined) continue;
        const key = `${s.id}\u0000${a.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const whose = other === s.id ? 'its own action' : `${other}'s action there`;
        findings.push({
          file: manifestFile,
          line: 0,
          message:
            `On ${route}, ${s.id} would list ${a.name} as "${folded}" (its catalog's ids all start ${prefix}), and "${folded}" is ` +
            `${whose}, so an agent's index lists ${s.id} with its full ids on ${route}. Give one of them another id to fold it.`,
        });
      }
    }
  }
  return findings;
}

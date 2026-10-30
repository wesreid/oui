/**
 * Pages the assistant is never on (`outside` in `oui.config.json`): pages
 * before sign-in, and public pages a link opens. Such a page has no surface
 * and its controls are not enforced, so the list must never be able to hide
 * a page of the app. A page is outside only when nothing around it or in it
 * is the assistant's:
 *
 * - no `shell` entry frames any of its routes;
 * - every element its routes render around it (a layout route's, or a
 *   `routeWrappers` component's, at any level) holds nothing someone can use
 *   and no person-only component, which is how the assistant's own UI is
 *   declared;
 * - the page does not render the app's frame itself;
 * - the page has no binding, display or room of its own: one in it is a
 *   shared component's, also on a page the assistant is on.
 */

import { routeMatcher } from '@ouispec/bindings';
import type ts from 'typescript';

import type { Finding, PageAnalysis } from './analyze.js';
import type { PageInput } from './assemble.js';
import { CONFIG_FILE, type OutsideEntry } from './config.js';
import type { AroundEntry } from './inputs.js';
import type { Source } from './program.js';

/** An outside page: its component, every route it is on, and why. */
export interface OutsidePage {
  component: string;
  routes: string[];
  reason: string;
}

/** Whether an analysed component holds anything someone can use: what makes a layout the app's frame. */
export function holdsAnything(analysis: PageAnalysis): boolean {
  return (
    analysis.controls.length > 0 ||
    analysis.displays.length > 0 ||
    analysis.unbound.length > 0 ||
    analysis.errors.length > 0 ||
    analysis.rooms.size > 0
  );
}

const problem = (message: string): Finding => ({ file: CONFIG_FILE, line: 0, message });

/** `file:line`, for a message. */
const at = (f: { file: string; line: number }) => `${f.file}:${f.line}`;

/**
 * The outside pages the entries name, and why any of them is not outside.
 * `pages` holds every page by component, frames included; `shell` the app's
 * frame entries with the routes each frames.
 */
export function resolveOutside(
  entries: readonly OutsideEntry[],
  pages: ReadonlyMap<string, PageInput>,
  shell: readonly { component: string; routes: readonly string[] }[],
  analyze: (decl: ts.Node) => PageAnalysis,
  source: Source,
  unbound: ReadonlySet<string>,
): { outside: OutsidePage[]; errors: Finding[] } {
  const errors: Finding[] = [];
  const named = new Map<string, { byComponent: boolean; routes: Set<string>; reasons: string[] }>();
  const routePages = [...pages.values()].filter(p => !p.frame);

  for (const entry of entries) {
    const page =
      'component' in entry
        ? routePages.find(p => p.component === entry.component)
        : routePages.find(p => p.routes.some(r => r.path === entry.route));
    if (!page) {
      errors.push(
        problem(
          'component' in entry
            ? `"outside" lists ${entry.component}, which no route renders`
            : `"outside" lists the route ${entry.route}, which is no page's route`,
        ),
      );
      continue;
    }
    const found = named.get(page.component) ?? { byComponent: false, routes: new Set<string>(), reasons: [] };
    if ('component' in entry) found.byComponent = true;
    else found.routes.add(entry.route);
    if (!found.reasons.includes(entry.reason.trim())) found.reasons.push(entry.reason.trim());
    named.set(page.component, found);
  }

  // What the pages the assistant is on bind: a component an outside page shares with them may be bound for them.
  const inside = [...pages.values()].filter(p => !named.has(p.component));
  const insideSites = new Set(
    inside.flatMap(p => [...(p.analysis?.controls ?? []), ...(p.analysis?.displays ?? [])].map(c => c.site)),
  );
  const insideRooms = new Set(inside.flatMap(p => [...(p.analysis?.rooms ?? [])].map(r => r.catalog.room)));
  const frames = [...pages.values()].filter(p => p.frame && p.routes[0]?.declaration);

  const outside: OutsidePage[] = [];
  for (const [component, { byComponent, routes: namedRoutes, reasons }] of [...named.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const page = pages.get(component)!;
    const routes = page.routes.map(r => r.path);
    const before = errors.length;
    const not = (why: string) => errors.push(problem(`"outside" lists ${component}, but ${why}`));

    if (unbound.has(component))
      not('"unbound" lists it too: a page the assistant is on but has not bound yet is in "unbound", one it is never on in "outside"');

    // Named by route, a page on several routes has each named: it is outside on all of them.
    const unnamed = byComponent ? [] : routes.filter(r => !namedRoutes.has(r));
    if (unnamed.length) not(`it is also on ${unnamed.join(', ')}: name it by component, or name each of its routes`);

    for (const route of page.routes) {
      // The app's frame is on it.
      for (const frame of shell) {
        if (frame.routes.some(f => f === '*' || f === route.path || routeMatcher(f).test(route.path)))
          not(`the frame ${frame.component} (in "shell") is on ${route.path}`);
      }
      // What its routes render around it holds nothing someone can use, and none of the person's own UI.
      for (const around of route.around ?? []) {
        const why = aroundProblem(around, analyze, source);
        if (why) not(`on ${route.path} it is rendered in ${around.component}, ${why}`);
      }
    }

    const analysis = page.analysis;
    if (analysis) {
      // It does not render the app's frame itself.
      for (const frame of frames) {
        if (analysis.components.has(frame.routes[0].declaration!)) not(`it renders the app's frame ${frame.component} itself`);
      }
      // Nothing in it is bound for the assistant alone.
      const own = [
        ...analysis.controls.filter(c => !insideSites.has(c.site)).map(c => `the binding "${c.binding.id}" (${c.declaredIn}:${c.line})`),
        ...analysis.displays.filter(d => !insideSites.has(d.site)).map(d => `the display "${d.binding.id}" (${d.declaredIn}:${d.line})`),
        ...[...analysis.rooms].filter(r => !insideRooms.has(r.catalog.room)).map(r => `the room ${r.catalog.room}`),
      ];
      if (own.length)
        not(
          `it has ${own.slice(0, 3).join(', ')}${own.length > 3 ? ` and ${own.length - 3} more` : ''}, on no page the assistant is on: ` +
            'what is bound only where the assistant is never is either on a page it is on, or bound by mistake',
        );
    }

    if (errors.length === before) outside.push({ component, routes, reason: reasons.join('; ') });
  }
  return { outside, errors: dedupe(errors) };
}

/**
 * Why an element rendered around a page makes it a page the assistant may be
 * on, or null. A wrapper that is not the app's own (`Suspense`) renders
 * what it is given; a layout must be read, as the app's frame usually is one.
 */
function aroundProblem(
  around: AroundEntry,
  analyze: (decl: ts.Node) => PageAnalysis,
  source: Source,
): string | null {
  const own = around.declaration && source.isAppFile(around.declaration.getSourceFile()) ? around.declaration : null;
  if (!own) return around.layout ? 'a layout route whose component the build cannot read' : null;
  const analysis = analyze(own);
  const kind = around.layout ? 'a layout route' : 'a route wrapper';
  const usable = [
    ...analysis.controls.map(c => ({ file: c.declaredIn, line: c.line })),
    ...analysis.displays.map(d => ({ file: d.declaredIn, line: d.line })),
    ...analysis.unbound,
  ];
  if (usable.length) return `${kind} that holds something someone can use (${at(usable[0])})`;
  if (analysis.rooms.size) return `${kind} that renders a room`;
  if (analysis.personOnly.length)
    return `${kind} that renders the person-only ${analysis.personOnly[0].message} (${at(analysis.personOnly[0])})`;
  if (analysis.errors.length) return `${kind} the build reports problems in (${at(analysis.errors[0])})`;
  return null;
}

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter(f => !seen.has(f.message) && !!seen.add(f.message));
}

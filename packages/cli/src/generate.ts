/**
 * The generator (ADR-0220 §2.4): reads the app, emits each build's manifest
 * and knowledge, and validates both. Deterministic: no LLM, no network, no
 * clock; the same source always gives the same bytes.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

import {
  MANIFEST_VERSION,
  stableStringify,
  type GeneratedKnowledge,
  type OuiManifest,
} from '@ouispec/bindings';

import { PageAnalyzer, type Finding, type PageAnalysis, type Tier2Found } from './analyze.js';
import { assemble, type PageInput } from './assemble.js';
import { CONFIG_FILE, type GeneratorConfig } from './config.js';
import { contractFindings } from './contract.js';
import {
  loadApiOperations,
  loadAppCatalogs,
  loadCatalogs,
  loadControls,
  loadNav,
  loadRoutes,
  loadShell,
  personOnlyLookup,
} from './inputs.js';
import { generateKnowledge } from './knowledge.js';
import { loadSource } from './program.js';
import { BOUND_DIR, boundModuleSource, boundTableSource, checkMappingTypes, loadMappings } from './tier2.js';

export const MANIFEST_FILE = 'oui-manifest.json';
export const KNOWLEDGE_FILE = 'oui-knowledge.json';

/** One use of a mapped control, as the conformance kit's `checkTier2` takes it (`Tier2Use`). */
export interface Tier2Use {
  /** The mapped control's name in its mapping. */
  component: string;
  /** The file, relative to the app root. */
  file: string;
  line: number;
  /** The props the use passes. */
  props: string[];
}

export interface GenerateResult {
  manifest: OuiManifest;
  knowledge: GeneratedKnowledge;
  errors: Finding[];
  /** What the build reports without failing: each uncontrolled use of a mapped control. */
  warnings: Finding[];
  /** Tier 2 (ADR-0226 §2.3): every use of a mapped control's root, and those that do not pass the prop that shows its value. */
  tier2: { uses: Tier2Use[]; uncontrolled: Tier2Use[] };
  files: { path: string; content: string }[];
  /** Files in `<out>/bound/` no mapping emits any more: stale, and deleted on write. */
  obsolete: string[];
  stats: { pages: number; actions: number; rooms: number; unboundPages: number; boundModules: number };
}

export async function generate(config: GeneratorConfig): Promise<GenerateResult> {
  // The design systems' tables first: a mapping may use a kind one of them registers.
  const controls = loadControls(config);
  const mappings = loadMappings(config);
  // Each bound module as this run emits it, read by the program in place of what is on disk.
  const bound = mappings.mappings.flatMap(m => [
    { path: m.module, content: boundModuleSource(m) },
    { path: m.table, content: boundTableSource(m) },
  ]);
  // Only what the routes, navigation and frame reach: every page is imported from the routes file.
  const source = loadSource(
    config.root,
    config.tsconfig,
    [config.routes, ...config.nav, ...config.shell.map(s => s.module)],
    new Map(bound.map(f => [f.path, f.content])),
  );
  const packageCatalogs = loadCatalogs(config);
  const catalogs = [...packageCatalogs.catalogs, ...(await loadAppCatalogs(config))];
  const api = loadApiOperations(config);
  const nav = loadNav(source, config.nav);
  const routes = loadRoutes(source, config);
  if (routes.pages.length === 0) throw new Error(`No routes found in ${source.rel(config.routes)}`);

  const analyzer = new PageAnalyzer(
    source,
    controls.controls,
    catalogs,
    config.designSystem,
    controls.loaded,
    personOnlyLookup(config),
    mappings.mappings,
  );
  const analyses = new Map<ts.Node, PageAnalysis>();
  const analyze = (decl: ts.Node) => {
    const analysis = analyses.get(decl) ?? analyzer.analyze(decl);
    analyses.set(decl, analysis);
    return analysis;
  };
  const pages = new Map<string, PageInput>();
  for (const route of routes.pages) {
    let page = pages.get(route.component);
    if (!page) {
      page = { component: route.component, routes: [], analysis: route.declaration ? analyze(route.declaration) : null };
      pages.set(route.component, page);
    }
    page.routes.push(route);
  }

  // The frame around the pages: analysed as a page is, offered wherever it frames.
  const frame = (component: string, paths: readonly string[], declaration: ts.Node | null) => {
    if (pages.has(component)) throw new Error(`${component} is both a page and the frame around pages`);
    pages.set(component, {
      component,
      routes: paths.map(path => ({ path, component, declaration })),
      analysis: declaration ? analyze(declaration) : null,
      frame: true,
    });
  };
  for (const shell of loadShell(source, config)) frame(shell.component, shell.routes, shell.declaration);
  // A layout route's element frames the pages under it, when it has anything of its own.
  for (const layout of routes.layouts) {
    if (!source.isAppFile(layout.declaration.getSourceFile())) continue;
    const analysis = analyze(layout.declaration);
    const empty =
      !analysis.controls.length &&
      !analysis.displays.length &&
      !analysis.unbound.length &&
      !analysis.errors.length &&
      !analysis.rooms.size;
    if (!empty) frame(layout.component, layout.routes, layout.declaration);
  }

  // Every catalog must be what the contract says a room catalog is (`room-catalog-data.json`).
  const catalogFindings = catalogs.flatMap(c =>
    contractFindings('room-catalog-data.json', c.catalog, CONFIG_FILE, `the room catalog of "${c.package}"`),
  );
  const unknownUnbound = config.unbound.filter(name => !pages.has(name));
  const assembled = assemble(
    [...pages.values()],
    nav,
    api,
    routes.pages,
    new Set(config.unbound),
  );
  const errors = [
    ...controls.errors,
    ...mappings.errors,
    ...checkMappingTypes(source, mappings.mappings),
    ...packageCatalogs.errors,
    ...catalogFindings,
    ...api.errors,
    ...routes.errors,
    ...assembled.errors,
    ...unknownUnbound.map(name => ({
      file: 'oui.config.json',
      line: 0,
      message: `"unbound" lists ${name}, which no route renders`,
    })),
  ];

  const knowledgeBody = generateKnowledge(
    assembled.surfaces,
    assembled.pages,
    assembled.frames,
    catalogs.map(c => c.catalog),
    nav,
    api.operations,
  );
  const buildId = createHash('sha256')
    .update(stableStringify({ surfaces: assembled.surfaces, knowledge: knowledgeBody }, 0))
    .digest('hex')
    .slice(0, 16);

  const manifest: OuiManifest = { version: MANIFEST_VERSION, buildId, surfaces: assembled.surfaces };
  const knowledge: GeneratedKnowledge = { version: MANIFEST_VERSION, buildId, ...knowledgeBody };

  // What the generator emits is held to the contract too: a manifest or knowledge
  // the schemas refuse is a defect here, never something to ship.
  errors.push(
    ...contractFindings('oui-manifest.json', manifest, MANIFEST_FILE, 'the generated manifest'),
    ...contractFindings('generated-knowledge.json', knowledge, KNOWLEDGE_FILE, 'the generated knowledge'),
  );

  // Every use of a mapped control, once each however many pages render it.
  const found = new Map<string, Tier2Found>();
  for (const analysis of analyses.values()) for (const use of analysis.tier2Uses) found.set(`${use.file}:${use.line}:${use.tag}`, use);
  const uses = [...found.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const asUse = (u: Tier2Found): Tier2Use => ({ component: u.component, file: u.file, line: u.line, props: u.props });
  const uncontrolled = uses.filter(u => u.uncontrolled);
  const warnings = uncontrolled.map(u => ({
    file: u.file,
    line: u.line,
    message:
      `<${u.tag}> does not pass ${u.controlled}, the prop that shows its value: the assistant can set it, ` +
      `but the control will not show what it set. Pass ${u.controlled}, kept in state.` +
      (u.spread ? ' (A spread may carry it, but the build cannot see what a spread holds: write it out.)' : ''),
  }));

  const files = [
    { path: join(config.out, MANIFEST_FILE), content: `${stableStringify(manifest)}\n` },
    { path: join(config.out, KNOWLEDGE_FILE), content: `${stableStringify(knowledge)}\n` },
    ...bound,
  ];
  // A bound module whose mapping is gone is stale: listed, and removed on write.
  const boundDir = join(config.out, BOUND_DIR);
  const emitted = new Set(files.map(f => f.path));
  const obsolete = existsSync(boundDir)
    ? readdirSync(boundDir)
        .map(f => join(boundDir, f))
        .filter(f => !emitted.has(f))
        .sort()
    : [];

  return {
    manifest,
    knowledge,
    errors: errors.sort(
      (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.message.localeCompare(b.message),
    ),
    warnings,
    tier2: { uses: uses.map(asUse), uncontrolled: uncontrolled.map(asUse) },
    files,
    obsolete,
    stats: {
      pages: assembled.pages.length,
      actions: assembled.surfaces.reduce((n, s) => n + s.actions.length, 0),
      rooms: assembled.surfaces.filter(s => s.kind === 'room').length,
      unboundPages: config.unbound.length,
      boundModules: mappings.mappings.length,
    },
  };
}

/** Write the files, or (with `check`) list those whose committed content differs. */
export function writeOrCheck(result: GenerateResult, config: GeneratorConfig, check: boolean): string[] {
  const stale: string[] = [];
  for (const file of result.files) {
    const current = existsSync(file.path) ? readFileSync(file.path, 'utf8') : null;
    if (current === file.content) continue;
    if (check) {
      stale.push(relative(config.root, file.path));
    } else {
      mkdirSync(join(file.path, '..'), { recursive: true });
      writeFileSync(file.path, file.content);
    }
  }
  for (const path of result.obsolete) {
    if (check) stale.push(`${relative(config.root, path)} (no mapping emits it)`);
    else rmSync(path);
  }
  return stale;
}

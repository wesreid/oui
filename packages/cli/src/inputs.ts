/**
 * The declarations the generator reads besides the page trees: each
 * design-system package's control table, each room package's catalog, the
 * API's operations (from its OpenAPI document), the navigation and the routes.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

import {
  agentDeclaration,
  catalogData,
  CONTROL_KINDS,
  controlKindRegistrationProblem,
  isRegisteredKind,
  readControlTable,
  registerControlKind,
  type AgentCatalogManifestEntry,
  type AnyControlKind,
  type ControlDescriptor,
  type RoomCatalog,
  type RoomCatalogData,
} from '@ouispec/bindings';

import type { Finding } from './analyze.js';
import { CONFIG_FILE, type GeneratorConfig } from './config.js';
import { contractFindings } from './contract.js';
import {
  constInitializer,
  evaluate,
  jsxAttribute,
  objectProperty,
  UNKNOWN,
  unwrap,
  type JsxOpening,
  type Source,
} from './program.js';

/** A package's directory, found the way the app resolves it. */
function packageDir(root: string, pkg: string): string | null {
  const require = createRequire(join(root, 'package.json'));
  for (const probe of [`${pkg}/package.json`]) {
    try {
      return dirname(require.resolve(probe));
    } catch {
      // Exports maps can hide package.json; walk node_modules instead.
    }
  }
  let dir = root;
  for (;;) {
    const candidate = join(dir, 'node_modules', pkg);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Whether a package is installed where the app's own `node_modules` hold it (not on a global path). */
function installedInApp(root: string, pkg: string): boolean {
  for (let dir = root; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'node_modules', pkg, 'package.json'))) return true;
    if (dirname(dir) === dir) return false;
  }
}

function packageJson(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
}

/** A problem with what the app's settings point at, reported against `oui.config.json`. */
function configFinding(message: string): Finding {
  return { file: CONFIG_FILE, line: 0, message };
}

/**
 * The components a package says only the person may use (`oui.personOnly`:
 * export name → why), such as the approval card (ADR-0228): the assistant
 * must never be offered a way to operate them, so the generator refuses an
 * `agent` binding on one. Read on first use of each package the app imports;
 * a package that declares none has none.
 */
export function personOnlyLookup(config: GeneratorConfig): (pkg: string) => ReadonlyMap<string, string> {
  const cache = new Map<string, ReadonlyMap<string, string>>();
  return pkg => {
    let found = cache.get(pkg);
    if (!found) {
      const dir = packageDir(config.root, pkg);
      const declared = dir ? (packageJson(dir).oui as { personOnly?: unknown } | undefined)?.personOnly : undefined;
      found = new Map(
        declared && typeof declared === 'object'
          ? Object.entries(declared as Record<string, unknown>).filter(
              (e): e is [string, string] => typeof e[1] === 'string' && !!e[1].trim(),
            )
          : [],
      );
      cache.set(pkg, found);
    }
    return found;
  };
}

/** `package#Export` → how the generator reads that control. */
export type Controls = ReadonlyMap<string, ControlDescriptor>;

/**
 * Every listed design-system package's control table. A package the app
 * cannot resolve, one with no table, or one whose table is missing is an
 * error: skipping it would leave its controls unread and the build green.
 */
export function loadControls(config: GeneratorConfig): {
  controls: Controls;
  /** The packages whose tables were read: an error for any other names it, so its uses are not reported again. */
  loaded: ReadonlySet<string>;
  errors: Finding[];
} {
  const out = new Map<string, ControlDescriptor>();
  const loaded = new Set<string>();
  const errors: Finding[] = [];
  for (const pkg of config.designSystem) {
    let file: unknown = config.controlTables?.[pkg];
    if (!file) {
      const dir = packageDir(config.root, pkg);
      if (!dir) {
        errors.push(
          configFinding(
            `designSystem lists "${pkg}", which cannot be resolved from the app: install it, or remove it from "designSystem"`,
          ),
        );
        continue;
      }
      const declared = agentDeclaration(pkg, packageJson(dir), 'agentControls');
      if (declared.error) {
        errors.push(configFinding(declared.error));
        continue;
      }
      if (typeof declared.value !== 'string') {
        errors.push(
          configFinding(
            `designSystem lists "${pkg}", which declares no control table: its package.json needs "oui": { "agentControls": "<path to its control table>" }`,
          ),
        );
        continue;
      }
      const path = resolve(dir, declared.value);
      if (!existsSync(path)) {
        errors.push(configFinding(`"${pkg}" names ${declared.value} as its ${declared.source}, but it does not exist`));
        continue;
      }
      file = JSON.parse(readFileSync(path, 'utf8'));
    }
    const before = errors.length;
    const { controls, kinds } = readControlTable(file);
    // The kinds the design system adds, registered before any of its controls is read.
    const registered = new Set<string>();
    for (const registration of kinds) {
      const problem = controlKindRegistrationProblem(registration);
      if (problem) {
        errors.push(configFinding(`"${pkg}" registers a control kind that is not valid: ${problem}`));
        continue;
      }
      try {
        registerControlKind(registration);
        registered.add(registration.kind);
      } catch (err) {
        errors.push(configFinding(`"${pkg}": ${(err as Error).message}`));
      }
    }
    for (const [name, descriptor] of Object.entries(controls)) {
      const used = [
        descriptor.kind,
        descriptor.entries?.kind,
        ...Object.values(descriptor.slots ?? {}).map(slot => slot.kind),
      ].filter((k): k is AnyControlKind => !!k);
      const unknown = used.filter(k => (isRegisteredKind(k) ? !registered.has(k) : !CONTROL_KINDS.includes(k)));
      if (unknown.length) {
        for (const kind of new Set(unknown))
          errors.push(
            configFinding(
              isRegisteredKind(kind)
                ? `"${pkg}" gives ${name} the kind ${kind}, which its $kinds do not register`
                : `"${pkg}" gives ${name} the kind ${kind}, which is not a control kind: ${CONTROL_KINDS.join(', ')}, or an x- kind it registers`,
            ),
          );
        continue;
      }
      out.set(`${pkg}#${name}`, descriptor);
    }
    // Beyond what is named above, the table must be what the contract says a
    // control table is (`control-table.json`).
    if (errors.length === before) errors.push(...contractFindings('control-table.json', file, CONFIG_FILE, `"${pkg}"'s control table`));
    loaded.add(pkg);
  }
  return { controls: out, loaded, errors };
}

export interface LoadedCatalog {
  /** The package that declares it, or `app:<module>#<export>` for one the app declares. */
  package: string;
  /** For an app catalog: the module's absolute path and the export, to find where it is registered. */
  appModule?: { file: string; export: string };
  hosts: readonly string[];
  catalog: RoomCatalogData;
}

/** Why an app room catalog cannot be loaded without Vite, and what to do. */
export const VITE_REQUIRED =
  'appCatalogs are loaded through the app’s own Vite config, and vite cannot be resolved from the app: ' +
  'add vite to its devDependencies, or ship the catalog in a package under "oui.agentCatalog"';

/**
 * The room catalogs the app declares itself (`appCatalogs`), loaded through
 * the app's Vite config and reduced to their declarations. A catalog is code
 * (its entries may be made by functions), and its imports resolve only as
 * the app's build resolves them, so the app's own Vite loads it.
 */
export async function loadAppCatalogs(config: GeneratorConfig): Promise<LoadedCatalog[]> {
  if (config.appCatalogs.length === 0) return [];
  // Only the app's own vite: its config, its plugins, its resolution.
  if (!installedInApp(config.root, 'vite')) throw new Error(VITE_REQUIRED);
  const vitePath = createRequire(join(config.root, 'package.json')).resolve('vite');
  const vite = (await import(pathToFileURL(vitePath).href)) as typeof import('vite');
  const server = await vite.createServer({
    root: config.root,
    logLevel: 'error',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const out: LoadedCatalog[] = [];
    for (const entry of config.appCatalogs) {
      const file = resolve(config.root, entry.module);
      let mod: Record<string, unknown>;
      try {
        mod = (await server.ssrLoadModule(file)) as Record<string, unknown>;
      } catch (err) {
        throw new Error(
          `${entry.module} could not be loaded through the app’s Vite config: ${(err as Error).message}`,
          { cause: err },
        );
      }
      const catalog = mod[entry.export] as RoomCatalog<unknown> | undefined;
      if (!catalog || typeof catalog !== 'object' || !Array.isArray(catalog.actions)) {
        throw new Error(`${entry.module} has no room catalog exported as ${entry.export}`);
      }
      out.push({
        package: `app:${entry.module}#${entry.export}`,
        appModule: { file, export: entry.export },
        hosts: entry.hosts,
        catalog: JSON.parse(JSON.stringify(catalogData(catalog))) as RoomCatalogData,
      });
    }
    return out;
  } finally {
    await server.close();
  }
}

/** Every room catalog among the app's dependencies (`oui.agentCatalog`, or `closure.agentCatalog`). */
export function loadCatalogs(config: GeneratorConfig): { catalogs: LoadedCatalog[]; errors: Finding[] } {
  if (config.catalogs) return { catalogs: [...config.catalogs], errors: [] };
  const app = packageJson(config.root);
  const deps = Object.keys({ ...(app.dependencies as object), ...(app.devDependencies as object) }).sort();
  const out: LoadedCatalog[] = [];
  const errors: Finding[] = [];
  for (const pkg of deps) {
    const dir = packageDir(config.root, pkg);
    if (!dir) continue;
    const declared = agentDeclaration(pkg, packageJson(dir), 'agentCatalog');
    if (declared.error) {
      errors.push(configFinding(declared.error));
      continue;
    }
    if (!declared.value) continue;
    const entries = (Array.isArray(declared.value) ? declared.value : [declared.value]) as AgentCatalogManifestEntry[];
    for (const entry of entries) {
      const file = resolve(dir, entry.path);
      if (!existsSync(file)) {
        errors.push(configFinding(`"${pkg}" names ${entry.path} as its ${declared.source}, but it does not exist`));
        continue;
      }
      out.push({ package: pkg, hosts: entry.hosts, catalog: JSON.parse(readFileSync(file, 'utf8')) });
    }
  }
  return { catalogs: out, errors };
}

export interface ApiOperation {
  /** The operation's `operationId`, which a `mutate` effect names. */
  name: string;
  method: string;
  url: string;
  summary: string;
}

/** The API as the app declares it: its document, whether it could be read, and its operations. */
export interface ApiOperations {
  /** `apiSpec` as written; `null` for an app with no API. */
  spec: string | null;
  /** Whether the document was read: when not, the error says why, and no operation is checked against it. */
  readable: boolean;
  operations: ReadonlyMap<string, ApiOperation>;
  errors: Finding[];
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/**
 * The API's operations, from its OpenAPI 3 document (`apiSpec`), by
 * `operationId`: method, path and summary line. The document is named by
 * module path, so it is the one the installed API client ships; a path
 * inside the app is also read. `apiSpec: null` is an app with no API.
 */
export function loadApiOperations(config: GeneratorConfig): ApiOperations {
  const operations = new Map<string, ApiOperation>();
  const fail = (message: string): ApiOperations => ({
    spec: config.apiSpec,
    readable: false,
    operations,
    errors: [configFinding(`apiSpec "${config.apiSpec}" ${message}`)],
  });
  if (config.apiSpec === null) return { spec: null, readable: true, operations, errors: [] };

  const spec = config.apiSpec;
  // A module path resolves as the app resolves the package; anything else is a file of the app.
  let file: string | null = null;
  if (!spec.startsWith('.') && !isAbsolute(spec)) {
    try {
      file = createRequire(join(config.root, 'package.json')).resolve(spec);
    } catch {
      file = null;
    }
  }
  if (!file) {
    file = resolve(config.root, spec);
    const inside = relative(config.root, file);
    if (inside.startsWith('..') || isAbsolute(inside))
      return fail('is outside the app: name the document by its module path, as the installed API client ships it');
  }
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return fail(`cannot be read: ${(err as Error).message}`);
  }
  const d = doc as { openapi?: unknown; paths?: unknown };
  if (typeof d?.openapi !== 'string' || !d.openapi.startsWith('3.') || !d.paths || typeof d.paths !== 'object')
    return fail('is not an OpenAPI 3 document: it needs "openapi": "3.x" and "paths"');

  const errors: Finding[] = [];
  for (const [path, item] of Object.entries(d.paths as Record<string, Record<string, unknown>>)) {
    for (const method of HTTP_METHODS) {
      const op = item?.[method] as { operationId?: unknown; summary?: unknown; description?: unknown } | undefined;
      if (!op || typeof op.operationId !== 'string') continue;
      if (operations.has(op.operationId)) {
        errors.push(configFinding(`apiSpec "${spec}" has two operations with the operationId ${op.operationId}`));
        continue;
      }
      operations.set(op.operationId, {
        name: op.operationId,
        method: method.toUpperCase(),
        url: path,
        summary: operationSummary(op.summary, op.description),
      });
    }
  }
  return { spec, readable: true, operations, errors };
}

/**
 * An operation's summary, or the first line of its description; a trailing
 * code reference (`— \`client.call()\``) names the call, not what it does.
 */
function operationSummary(summary: unknown, description: unknown): string {
  const text = typeof summary === 'string' && summary.trim() ? summary : typeof description === 'string' ? description : '';
  return text
    .split('\n')[0]
    .replace(/\s*—\s*`[^`]+`\s*$/, '')
    .trim();
}

export interface NavEntry {
  label: string;
  route: string;
  group: string;
}

/** The navigation entries: every `{ label, route }` object literal in the nav files. */
export function loadNav(source: Source, files: readonly string[]): NavEntry[] {
  const out: NavEntry[] = [];
  for (const file of files) {
    const sf = source.program.getSourceFile(file);
    if (!sf) throw new Error(`Navigation file ${source.rel(file)} is not in the program`);
    const visit = (n: ts.Node) => {
      if (ts.isObjectLiteralExpression(n)) {
        const v = evaluate(source.checker, n) as Record<string, unknown>;
        if (typeof v.label === 'string' && typeof v.route === 'string' && v.showInNav !== false) {
          out.push({ label: v.label, route: v.route, group: typeof v.group === 'string' ? v.group : '' });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

/** The frame components the config names, each with the declaration that renders it. */
export function loadShell(
  source: Source,
  config: GeneratorConfig,
): { component: string; routes: string[]; declaration: ts.Node | null }[] {
  return config.shell.map(entry => {
    const sf = source.program.getSourceFile(entry.module);
    if (!sf) throw new Error(`Shell module ${source.rel(entry.module)} is not in the program`);
    const moduleSymbol = source.checker.getSymbolAtLocation(sf);
    let exported = moduleSymbol
      ? source.checker.getExportsOfModule(moduleSymbol).find(s => s.name === entry.export)
      : undefined;
    if (exported && exported.flags & ts.SymbolFlags.Alias) exported = source.checker.getAliasedSymbol(exported);
    return {
      component: entry.export,
      routes: [...(entry.routes ?? ['*'])],
      declaration: exported?.valueDeclaration ?? exported?.declarations?.[0] ?? null,
    };
  });
}

export interface RouteEntry {
  path: string;
  /** The page component's name as the routes name it (a lazy route module's, its file's). */
  component: string;
  /** The declaration of the page component. */
  declaration: ts.Node | null;
}

/** A layout route's element: rendered around the pages under it, as the app's frame is. */
export interface LayoutEntry {
  component: string;
  declaration: ts.Node;
  /** The routes it is rendered on: its pages', and its own when nothing renders in its place there. */
  routes: string[];
}

export interface AppRoutes {
  pages: RouteEntry[];
  layouts: LayoutEntry[];
  /** Routes the generator cannot read: each would otherwise be a page the assistant never knows. */
  errors: Finding[];
}

/** Calls that take the app's routes as data. */
const DATA_ROUTERS = new Set([
  'createBrowserRouter',
  'createHashRouter',
  'createMemoryRouter',
  'createStaticRouter',
  'useRoutes',
]);

/** One route, from JSX or from a data router, before its path is joined to its parent's. */
interface RouteNode {
  site: ts.Node;
  path: string | typeof UNKNOWN | undefined;
  index: boolean;
  /** What it renders: a component, a redirect, or nothing (a route that only groups its children). */
  renders: { component: string; declaration: ts.Node | null } | 'redirect' | null;
  children: RouteNode[];
}

/**
 * The app's routes, from the routes file: `<Route>` elements (nested ones
 * joined to their parent, `index` routes at their parent's path) and data
 * routers (`createBrowserRouter([...])` and its kin, `useRoutes`), with
 * `element`, `Component` and `lazy` route modules. Wrappers are resolved to
 * the page, `lazy` and `React.lazy` to the component they load.
 *
 * Not pages: splats, and redirects — a `<Navigate>`, and a component that
 * only ever renders one (a redirect that keeps the id). A redirect is not a
 * page, and naming it as one teaches an address that is not the destination.
 * A route's element that has child routes is a layout: it frames them.
 */
export function loadRoutes(source: Source, config: GeneratorConfig): AppRoutes {
  const sf = source.program.getSourceFile(config.routes);
  if (!sf) throw new Error(`Routes file ${source.rel(config.routes)} is not in the program`);
  const reader = new RouteReader(source, new Set(config.routeWrappers));
  const roots: RouteNode[] = [];
  const visit = (n: ts.Node) => {
    const route = routeElement(n);
    if (route) {
      roots.push(reader.fromJsx(route));
      return;
    }
    if (ts.isCallExpression(n) && DATA_ROUTERS.has(calleeName(n.expression)) && n.arguments[0]) {
      roots.push(...reader.fromArray(n.arguments[0]));
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  const pages = new Map<string, RouteEntry>();
  const layouts = new Map<string, LayoutEntry>();
  /** The pages' paths under a node, found while walking it. */
  const walk = (node: RouteNode, parent: string): string[] => {
    if (node.path === UNKNOWN) {
      reader.problem(node.site, 'A route’s path must be readable at build time: a literal or a constant');
      return [];
    }
    const full = node.index || node.path === undefined ? parent : joinPath(parent, node.path);
    if (node.path === '*') return [];
    if (node.children.length) {
      const under = node.children.flatMap(child => walk(child, full));
      if (node.renders && node.renders !== 'redirect' && node.renders.declaration) {
        const own = node.path !== undefined && !node.children.some(c => c.index) ? [full] : [];
        const entry = layouts.get(node.renders.component) ?? {
          component: node.renders.component,
          declaration: node.renders.declaration,
          routes: [],
        };
        entry.routes = [...new Set([...entry.routes, ...own, ...under])].sort();
        layouts.set(node.renders.component, entry);
      }
      return under;
    }
    if (!node.renders || node.renders === 'redirect' || pages.has(full)) return [];
    pages.set(full, { path: full, ...node.renders });
    return [full];
  };
  for (const root of roots) walk(root, '');

  return {
    pages: [...pages.values()].sort((a, b) => a.path.localeCompare(b.path)),
    layouts: [...layouts.values()].sort((a, b) => a.component.localeCompare(b.component)),
    errors: reader.errors,
  };
}

/** A child's path joined to its parent's; an absolute one is used as written. */
function joinPath(parent: string, path: string): string {
  const joined = path.startsWith('/') ? path : `${parent.replace(/\/+$/, '')}/${path}`;
  const clean = joined.replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1');
  return clean.startsWith('/') ? clean : `/${clean}`;
}

/** A `<Route>` element's opening tag, taken whole: its nested routes are read from it, not beside it. */
function routeElement(n: ts.Node): JsxOpening | null {
  const opening = ts.isJsxElement(n) ? n.openingElement : ts.isJsxSelfClosingElement(n) ? n : null;
  return opening && opening.tagName.getText() === 'Route' ? opening : null;
}

/** `createBrowserRouter`, `React.lazy`, `ReactRouter.useRoutes`: the called name. */
function calleeName(expr: ts.Expression): string {
  const e = unwrap(expr);
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return '';
}

/** Whether a call is `lazy(...)` or `React.lazy(...)`. */
export function isLazyCall(expr: ts.Expression): expr is ts.CallExpression {
  const e = unwrap(expr);
  return ts.isCallExpression(e) && calleeName(e.expression) === 'lazy';
}

class RouteReader {
  readonly errors: Finding[] = [];

  constructor(
    private readonly source: Source,
    private readonly wrappers: ReadonlySet<string>,
  ) {}

  problem(site: ts.Node, message: string): void {
    const sf = site.getSourceFile();
    this.errors.push({
      file: this.source.rel(sf),
      line: sf.getLineAndCharacterOfPosition(site.getStart()).line + 1,
      message,
    });
  }

  /** A `<Route>` and the `<Route>`s nested in it. */
  fromJsx(el: JsxOpening): RouteNode {
    const pathAttr = jsxAttribute(el, 'path');
    const indexAttr = jsxAttribute(el, 'index');
    const children: RouteNode[] = [];
    if (ts.isJsxOpeningElement(el)) {
      const visit = (n: ts.Node) => {
        const route = routeElement(n);
        if (route) {
          children.push(this.fromJsx(route));
          return;
        }
        ts.forEachChild(n, visit);
      };
      el.parent.children.forEach(visit);
    }
    return {
      site: el,
      path: pathAttr === undefined ? undefined : this.path(pathAttr === true ? undefined : pathAttr),
      index: indexAttr === true || (indexAttr !== undefined && evaluate(this.source.checker, indexAttr) === true),
      renders: this.renders(
        el,
        asExpression(jsxAttribute(el, 'element')),
        asExpression(jsxAttribute(el, 'Component')),
        asExpression(jsxAttribute(el, 'lazy')),
      ),
      children,
    };
  }

  /** The route objects of a data router's array: a literal, a constant, spreads of either. */
  fromArray(expr: ts.Expression, site: ts.Node = expr): RouteNode[] {
    const array = this.arrayLiteral(expr);
    if (!array) {
      this.problem(site, 'Routes must be readable at build time: an array literal of route objects, or a constant one');
      return [];
    }
    const out: RouteNode[] = [];
    for (const el of array.elements) {
      if (ts.isSpreadElement(el)) {
        out.push(...this.fromArray(el.expression, el));
        continue;
      }
      const obj = this.objectLiteral(el);
      if (!obj) {
        this.problem(el, 'A route must be readable at build time: an object literal, or a constant one');
        continue;
      }
      out.push(this.fromObject(obj));
    }
    return out;
  }

  private fromObject(obj: ts.ObjectLiteralExpression): RouteNode {
    const pathExpr = objectProperty(obj, 'path');
    const children = objectProperty(obj, 'children');
    return {
      site: obj,
      path: pathExpr === undefined ? undefined : this.path(pathExpr),
      index: evaluate(this.source.checker, objectProperty(obj, 'index')) === true,
      renders: this.renders(
        obj,
        objectProperty(obj, 'element'),
        objectProperty(obj, 'Component'),
        objectProperty(obj, 'lazy'),
      ),
      children: children ? this.fromArray(children) : [],
    };
  }

  private path(expr: ts.Expression | undefined): string | typeof UNKNOWN {
    const v = evaluate(this.source.checker, expr);
    return typeof v === 'string' ? v : UNKNOWN;
  }

  /** What a route renders, from its `element`, its `Component` or its `lazy` route module. */
  private renders(
    site: ts.Node,
    element: ts.Expression | undefined,
    component: ts.Expression | undefined,
    lazy: ts.Expression | undefined,
  ): RouteNode['renders'] {
    if (element) {
      const page = pageElement(unwrap(element), this.wrappers);
      if (!page) return null;
      if (page.tagName.getText() === 'Navigate') return 'redirect';
      const declaration = componentDeclaration(this.source, page.tagName);
      if (declaration && onlyRedirects(declaration)) return 'redirect';
      return { component: page.tagName.getText(), declaration };
    }
    if (component) {
      const id = unwrap(component);
      if (!ts.isIdentifier(id)) {
        this.problem(site, 'A route’s Component must be a component’s name');
        return null;
      }
      const declaration = componentDeclaration(this.source, id);
      if (declaration && onlyRedirects(declaration)) return 'redirect';
      return { component: id.text, declaration };
    }
    if (lazy) {
      const loaded = importedModule(this.source, lazy);
      const declaration = loaded && moduleExport(this.source, loaded, ['Component', 'default']);
      if (!loaded || !declaration) {
        this.problem(
          site,
          'A route’s lazy must be () => import(\'…\') of a route module that exports Component (or a default)',
        );
        return null;
      }
      return { component: basename(loaded.fileName, extname(loaded.fileName)), declaration };
    }
    return null;
  }

  private arrayLiteral(expr: ts.Expression): ts.ArrayLiteralExpression | null {
    const e = unwrap(expr);
    if (ts.isArrayLiteralExpression(e)) return e;
    if (ts.isIdentifier(e)) {
      const init = constInitializer(this.source.checker, e);
      return init ? this.arrayLiteral(init) : null;
    }
    return null;
  }

  private objectLiteral(expr: ts.Expression): ts.ObjectLiteralExpression | null {
    const e = unwrap(expr);
    if (ts.isObjectLiteralExpression(e)) return e;
    if (ts.isIdentifier(e)) {
      const init = constInitializer(this.source.checker, e);
      return init ? this.objectLiteral(init) : null;
    }
    return null;
  }
}

function asExpression(v: ts.Expression | true | undefined): ts.Expression | undefined {
  return v === true ? undefined : v;
}

/**
 * Whether a component only ever renders `<Navigate>`: every value it returns
 * (its arrow body, or each `return` of its own body, not of functions inside
 * it) is a `<Navigate>` element.
 */
function onlyRedirects(decl: ts.Node): boolean {
  const fn = ts.isVariableDeclaration(decl) && decl.initializer ? unwrap(decl.initializer) : decl;
  if (!ts.isFunctionDeclaration(fn) && !ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false;
  if (!fn.body) return false;
  const returned: ts.Expression[] = [];
  if (ts.isBlock(fn.body)) {
    const visit = (n: ts.Node) => {
      if (ts.isFunctionLike(n)) return;
      if (ts.isReturnStatement(n) && n.expression) returned.push(n.expression);
      ts.forEachChild(n, visit);
    };
    fn.body.statements.forEach(visit);
  } else {
    returned.push(fn.body);
  }
  const isNavigate = (e: ts.Expression): boolean => {
    const x = unwrap(e);
    if (ts.isJsxSelfClosingElement(x)) return x.tagName.getText() === 'Navigate';
    if (ts.isJsxElement(x)) return x.openingElement.tagName.getText() === 'Navigate';
    return false;
  };
  return returned.length > 0 && returned.every(isNavigate);
}

/** The first JSX element under `expr` that is not a wrapper. */
function pageElement(expr: ts.Node, wrappers: ReadonlySet<string>): JsxOpening | null {
  let result: JsxOpening | null = null;
  const visit = (n: ts.Node) => {
    if (result) return;
    if (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) {
      if (!wrappers.has(n.tagName.getText())) {
        result = n;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(expr);
  return result;
}

/**
 * The function that renders a component a JSX tag names: through imports and
 * re-exports, `lazy(() => import('./X'))` and `React.lazy(...)` (a default
 * export, or `.then(m => ({ default: m.X }))`), `forwardRef` and `memo`.
 */
export function componentDeclaration(source: Source, tag: ts.JsxTagNameExpression): ts.Node | null {
  const symbol = source.checker.getSymbolAtLocation(tag);
  let resolved = symbol;
  if (resolved && resolved.flags & ts.SymbolFlags.Alias) resolved = source.checker.getAliasedSymbol(resolved);
  const decl = resolved?.valueDeclaration ?? resolved?.declarations?.[0];
  if (!decl) return null;
  if (ts.isVariableDeclaration(decl) && decl.initializer && isLazyCall(decl.initializer)) {
    return lazyTarget(source, unwrap(decl.initializer) as ts.CallExpression);
  }
  return decl;
}

/** The component a `lazy(() => import('./X'))` loads: the default export, or the one `.then` picks. */
function lazyTarget(source: Source, call: ts.CallExpression): ts.Node | null {
  let exportName = 'default';
  const visit = (n: ts.Node) => {
    if (
      ts.isPropertyAssignment(n) &&
      n.name.getText() === 'default' &&
      ts.isPropertyAccessExpression(n.initializer)
    ) {
      exportName = n.initializer.name.text;
    }
    ts.forEachChild(n, visit);
  };
  visit(call);
  const target = importedModule(source, call);
  return target ? moduleExport(source, target, [exportName]) : null;
}

/** The app module a `() => import('./x')` (anywhere under `node`) loads. */
function importedModule(source: Source, node: ts.Node): ts.SourceFile | null {
  let importPath: string | null = null;
  const visit = (n: ts.Node) => {
    if (importPath) return;
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = n.arguments[0];
      if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) importPath = arg.text;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  if (!importPath) return null;
  const resolved = ts.resolveModuleName(
    importPath,
    node.getSourceFile().fileName,
    source.program.getCompilerOptions(),
    ts.sys,
  );
  return (resolved.resolvedModule && source.program.getSourceFile(resolved.resolvedModule.resolvedFileName)) ?? null;
}

/** The declaration of the first of `names` a module exports. */
function moduleExport(source: Source, file: ts.SourceFile, names: readonly string[]): ts.Node | null {
  const moduleSymbol = source.checker.getSymbolAtLocation(file);
  if (!moduleSymbol) return null;
  const exports = source.checker.getExportsOfModule(moduleSymbol);
  for (const name of names) {
    let exported = exports.find(s => s.name === name);
    if (exported && exported.flags & ts.SymbolFlags.Alias) exported = source.checker.getAliasedSymbol(exported);
    const decl = exported?.valueDeclaration ?? exported?.declarations?.[0];
    if (decl) return decl;
  }
  return null;
}

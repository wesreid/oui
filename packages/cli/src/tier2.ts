/**
 * Tier 2 (ADR-0226 §2.3): each mapping of a third-party design system the app
 * does not own becomes a bound module in `<out>/bound/`, and the generator
 * reads every use of a bound control as it reads a tier 1 control.
 *
 * - `loadMappings` reads and checks each mapping the config names.
 * - `boundModuleSource` is the module emitted for one: a wrapper per mapped
 *   control, built from `@ouispec/bindings/react`, under the
 *   package's own export names, with every other member of a namespace kept.
 * - `checkMappingTypes` holds each mapping to the package's types: every
 *   export it names exists, and every prop it names is one the component takes.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

import {
  CONTROL_KINDS,
  isRegisteredKind,
  registeredControlKind,
  stableStringify,
  tier2ControlTable,
  tier2Descriptor,
  tier2Parts,
  type ControlDescriptor,
  type Tier2Control,
  type Tier2Mapping,
} from '@ouispec/bindings';

import type { Finding } from './analyze.js';
import { CONFIG_FILE, type GeneratorConfig } from './config.js';
import { contractFindings } from './contract.js';
import type { Source } from './program.js';

/** Where the bound wrappers' runtime is imported from, in every emitted module. */
export const BINDINGS_REACT_MODULE = '@ouispec/bindings/react';

/** What adds `agent` to JSX for an app with bound modules, imported by every emitted module. */
export const BINDINGS_JSX_MODULE = '@ouispec/bindings/jsx';

/** The directory under `out` the bound modules go in. */
export const BOUND_DIR = 'bound';

/** One part of a mapped control, as the analyzer reads a use of it. */
export interface Tier2PartInfo {
  /** The mapped control's name in the mapping (`Select`). */
  control: string;
  part: 'root' | 'item';
  /** The control's mapping. */
  mapping: Tier2Control;
}

export interface LoadedMapping {
  /** The mapping file, relative to the app root, for messages. */
  file: string;
  package: string;
  /** How the analyzer names the bound module, where a tier 1 package name would be. */
  key: string;
  /** The bound module's file name, without extension (`mantine-core`). */
  slug: string;
  /** The bound module, absolute. */
  module: string;
  /** Its control table, absolute. */
  table: string;
  mapping: Tier2Mapping;
  /** Each part's export path (`Select`, `Select.Root`, `Tabs.Tab`) → how the analyzer reads its uses. */
  descriptors: ReadonlyMap<string, ControlDescriptor>;
  parts: ReadonlyMap<string, Tier2PartInfo>;
  /** The package's exports an app must import from the bound module instead: each part's first segment. */
  exports: ReadonlySet<string>;
}

/** `@mantine/core` → `mantine-core`: the bound module's name. */
export function boundModuleSlug(pkg: string): string {
  return pkg
    .replace(/^@/, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function finding(file: string, message: string): Finding {
  return { file, line: 0, message };
}

/**
 * Every mapping `oui.config.json` names, read and checked against the
 * contract and against each other: one mapping per package, never a package
 * also listed as a tier 1 design system, and every kind a built-in one or
 * one a design system registers.
 */
export function loadMappings(config: GeneratorConfig): { mappings: LoadedMapping[]; errors: Finding[] } {
  const mappings: LoadedMapping[] = [];
  const errors: Finding[] = [];
  const bySlug = new Map<string, LoadedMapping>();
  for (const path of config.mappings) {
    const file = relative(config.root, path);
    if (!existsSync(path)) {
      errors.push(finding(CONFIG_FILE, `"mappings" lists ${file}, which does not exist`));
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      errors.push(finding(file, `is not JSON: ${(err as Error).message}`));
      continue;
    }
    const contract = contractFindings('tier2-mapping.json', raw, file, 'the mapping');
    if (contract.length) {
      errors.push(...contract);
      continue;
    }
    const mapping = raw as Tier2Mapping;
    const before = errors.length;
    if (config.designSystem.includes(mapping.package)) {
      errors.push(
        finding(file, `maps ${mapping.package}, which "designSystem" also lists: a package is a tier 1 design system or mapped, never both`),
      );
    }
    const slug = boundModuleSlug(mapping.package);
    const twin = bySlug.get(slug);
    if (twin) {
      errors.push(
        finding(
          file,
          twin.package === mapping.package
            ? `maps ${mapping.package}, which ${twin.file} maps too: one mapping per package`
            : `maps ${mapping.package}, whose bound module would be ${slug}.ts, as ${twin.file}'s for ${twin.package} is`,
        ),
      );
    }

    const descriptors = new Map<string, ControlDescriptor>();
    const parts = new Map<string, Tier2PartInfo>();
    const exports = new Set<string>();
    for (const [name, control] of Object.entries(mapping.controls)) {
      const kind = control.kind;
      if (isRegisteredKind(kind) ? !registeredControlKind(kind) : !CONTROL_KINDS.includes(kind)) {
        errors.push(
          finding(
            file,
            isRegisteredKind(kind)
              ? `${name} has the kind ${kind}, which no design system in "designSystem" registers`
              : `${name} has the kind ${kind}, which is not a control kind: ${CONTROL_KINDS.join(', ')}`,
          ),
        );
        continue;
      }
      const where = tier2Parts(name, control);
      const own: [string, 'root' | 'item'][] = [[where.root, 'root'], ...(where.item ? [[where.item, 'item'] as [string, 'item']] : [])];
      for (const [path, part] of own) {
        const other = parts.get(path);
        if (other) {
          errors.push(finding(file, `${name}'s ${part} is ${path}, which ${other.control}'s ${other.part} is too`));
          continue;
        }
        parts.set(path, { control: name, part, mapping: control });
        // An item reports its option; only the root is a control.
        descriptors.set(path, part === 'root' ? tier2Descriptor(control) : { callbacks: [], titleProps: [] });
        exports.add(path.split('.')[0]);
      }
    }
    if (errors.length > before) continue;
    const module = join(config.out, BOUND_DIR, `${slug}.ts`);
    const loaded: LoadedMapping = {
      file,
      package: mapping.package,
      key: `bound:${mapping.package}`,
      slug,
      module,
      table: join(config.out, BOUND_DIR, `${slug}.agent-controls.json`),
      mapping,
      descriptors,
      parts,
      exports,
    };
    bySlug.set(slug, loaded);
    mappings.push(loaded);
  }
  return { mappings, errors };
}

/** A string as a TypeScript single-quoted literal. */
function quote(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

const lowerFirst = (name: string) => name.charAt(0).toLowerCase() + name.slice(1);

/** The bound module emitted for one mapping: deterministic, the same mapping always gives the same bytes. */
export function boundModuleSource(loaded: LoadedMapping): string {
  const pkg = loaded.package;
  const unbound = (segment: string) => `Unbound${segment}`;
  /** A part's path as an expression on the package's imports. */
  const ref = (path: string) => {
    const [head, member] = path.split('.');
    return member ? `${unbound(head)}.${member}` : unbound(head);
  };

  const lines: string[] = [];
  /** First segment → what each of its paths is bound to: the segment itself (`''`) or one member. */
  const members = new Map<string, Map<string, string>>();
  const put = (path: string, expr: string) => {
    const [head, member = ''] = path.split('.');
    const map = members.get(head) ?? new Map<string, string>();
    map.set(member, expr);
    members.set(head, map);
  };

  for (const [name, control] of Object.entries(loaded.mapping.controls).sort(([a], [b]) => a.localeCompare(b))) {
    const where = tier2Parts(name, control);
    const literal = stableStringify(control, 0);
    if (where.item) {
      const local = `${lowerFirst(name)}Parts`;
      lines.push(`const ${local} = boundCompound(${ref(where.root)}, ${ref(where.item)}, ${quote(name)}, ${literal});`);
      put(where.root, `${local}.root`);
      put(where.item, `${local}.item`);
    } else {
      put(where.root, `boundControl(${ref(where.root)}, ${quote(name)}, ${literal})`);
    }
  }

  const exported: string[] = [];
  for (const head of [...members.keys()].sort()) {
    const map = members.get(head)!;
    const base = map.get('') ?? unbound(head);
    const rest = [...map.entries()].filter(([member]) => member !== '').sort(([a], [b]) => a.localeCompare(b));
    exported.push(
      rest.length
        ? `export const ${head} = withMembers(${base}, { ${rest.map(([member, expr]) => `${member}: ${expr}`).join(', ')} });`
        : `export const ${head} = ${base};`,
    );
  }

  const heads = [...members.keys()].sort();
  const helpers = ['boundCompound', 'boundControl', 'withMembers'].filter(h => [...lines, ...exported].some(l => l.includes(`${h}(`)));
  return [
    '/**',
    ` * Generated by \`oui generate\` from ${loaded.file} (ADR-0226 §2.3). Do not edit: change the`,
    ' * mapping and run `oui generate`.',
    ' *',
    ` * Every control the mapping names, bound: import them from here, never from ${pkg}. Each`,
    ' * accepts `agent`, registers its binding with the app’s own callback, returns that callback’s',
    ` * result, and renders the ${pkg} component unchanged. Every other member of a namespace is`,
    ` * ${pkg}'s own.`,
    ' */',
    `import { ${heads.map(h => `${h} as ${unbound(h)}`).join(', ')} } from ${quote(pkg)};`,
    `import { ${helpers.join(', ')} } from ${quote(BINDINGS_REACT_MODULE)};`,
    // `agent` on JSX: a bound export keeps the component's own type, so the attribute is added once, for the app.
    `import ${quote(BINDINGS_JSX_MODULE)};`,
    '',
    ...lines,
    ...(lines.length ? [''] : []),
    ...exported,
    '',
  ].join('\n');
}

/** The control table emitted beside the bound module: it ships as a tier 1 package's does. */
export function boundTableSource(loaded: LoadedMapping): string {
  return `${stableStringify(tier2ControlTable(loaded.mapping))}\n`;
}

/** Whether `name` is a prop of `type`: `null` when the type cannot say (generic, polymorphic, indexed). */
function hasProp(checker: ts.TypeChecker, type: ts.Type, name: string, depth = 0): boolean | null {
  if (depth > 8 || type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return null;
  if (checker.getPropertyOfType(type, name)) return true;
  if (type.isUnionOrIntersection()) {
    const each = type.types.map(t => hasProp(checker, t, name, depth + 1));
    if (each.includes(true)) return true;
    return each.includes(null) ? null : false;
  }
  if (checker.getIndexInfosOfType(type).length) return null;
  const undecided =
    ts.TypeFlags.TypeParameter | ts.TypeFlags.Conditional | ts.TypeFlags.Substitution | ts.TypeFlags.Index | ts.TypeFlags.IndexedAccess;
  return type.flags & undecided ? null : false;
}

/** Whether a component of `type` takes the prop `name`, over every way it can be called. */
function takesProp(checker: ts.TypeChecker, type: ts.Type, name: string): boolean | null {
  const signatures = [...type.getCallSignatures(), ...type.getConstructSignatures()];
  if (!signatures.length) return null;
  let answer: boolean | null = false;
  for (const signature of signatures) {
    const param = signature.getParameters()[0];
    if (!param) continue;
    const declaration = param.valueDeclaration ?? param.declarations?.[0];
    const props = declaration ? checker.getTypeOfSymbolAtLocation(param, declaration) : checker.getDeclaredTypeOfSymbol(param);
    const has = hasProp(checker, props, name);
    if (has) return true;
    if (has === null) answer = null;
  }
  return answer;
}

/**
 * Each mapping held to its package's types, through its bound module as the
 * app compiles it: every diagnostic in the module (an export the package does
 * not have, a package the app cannot resolve), and every prop the mapping
 * names that its component does not take. A prop the types cannot decide (a
 * polymorphic component's) is left to the conformance kit.
 */
export function checkMappingTypes(source: Source, mappings: readonly LoadedMapping[]): Finding[] {
  const out: Finding[] = [];
  const { checker } = source;
  for (const loaded of mappings) {
    const sf = source.program.getSourceFile(loaded.module);
    if (!sf) {
      out.push(finding(loaded.file, `its bound module ${source.rel(loaded.module)} is not in the program`));
      continue;
    }
    const diagnostics = source.program.getSemanticDiagnostics(sf);
    for (const d of diagnostics) {
      out.push(
        finding(
          loaded.file,
          `does not fit ${loaded.package}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')} (in the bound module ${source.rel(loaded.module)})`,
        ),
      );
    }
    if (diagnostics.length) continue;

    // The package's exports, through the module's own imports.
    const imported = new Map<string, ts.Type>();
    for (const statement of sf.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      if (statement.moduleSpecifier.text !== loaded.package) continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const element of bindings.elements) {
        imported.set((element.propertyName ?? element.name).text, checker.getTypeAtLocation(element.name));
      }
    }
    const partType = (path: string): ts.Type | null => {
      const [head, member] = path.split('.');
      const base = imported.get(head);
      if (!base || !member) return base ?? null;
      const symbol = checker.getPropertyOfType(base, member);
      return symbol ? checker.getTypeOfSymbolAtLocation(symbol, sf) : null;
    };

    for (const [path, info] of loaded.parts) {
      const type = partType(path);
      if (!type) {
        out.push(finding(loaded.file, `${info.control}'s ${info.part} is ${path}, which ${loaded.package} does not export`));
        continue;
      }
      const control = info.mapping;
      const named: [string, string][] =
        info.part === 'root'
          ? [
              ...control.callbacks.map(cb => [cb, 'a callback'] as [string, string]),
              ...(control.controlled ? [[control.controlled, 'its controlled prop'] as [string, string]] : []),
              ...(control.options ? [[control.options.prop, 'its options'] as [string, string]] : []),
              ...Object.values(control.schemaProps ?? {}).map(p => [p, 'a schema prop'] as [string, string]),
              ...(control.titleProps ?? []).filter(p => p !== 'children').map(p => [p, 'a title prop'] as [string, string]),
            ]
          : [
              ...(control.parts?.item?.valueProp ? [[control.parts.item.valueProp, 'its items’ value'] as [string, string]] : []),
              ...(control.parts?.item?.titleProps ?? []).filter(p => p !== 'children').map(p => [p, 'its items’ title'] as [string, string]),
            ];
      for (const [prop, role] of named) {
        if (takesProp(checker, type, prop) === false) {
          out.push(finding(loaded.file, `${info.control} names ${prop} as ${role}, but ${loaded.package}'s ${path} takes no ${prop} prop`));
        }
      }
    }
  }
  return out;
}

/**
 * Which of a design system's exports take a callback, read from its types
 * (ADR-0226 §3.2, the second rule): a component whose props include a
 * callback is something a page can make interactive, so it must be in the
 * control table or excluded with a reason. "A callback" is what the generator
 * treats as one where a page uses a component: a function-typed prop named
 * `on…`, or one of the handlers that make an element interactive.
 */
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

import { CALLBACK_PROP, INTERACTIVE_HANDLERS } from '@ouispec/bindings';

export interface SourceEntry {
  /** The tsconfig the package compiles with. */
  tsconfig: string;
  /** The module whose exports are the package's public surface (`src/index.ts`). */
  entry: string;
}

export interface ExportedComponent {
  name: string;
  /** The props that take a callback. */
  callbacks: string[];
}

/** Every component the entry exports, with the callback props it takes. */
export function exportedComponents(source: SourceEntry): ExportedComponent[] {
  const tsconfig = resolve(source.tsconfig);
  const read = ts.readConfigFile(tsconfig, ts.sys.readFile);
  if (read.error) throw new Error(`Cannot read ${tsconfig}: ${ts.flattenDiagnosticMessageText(read.error.messageText, '\n')}`);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(tsconfig));
  const entry = resolve(source.entry);
  const program = ts.createProgram({ rootNames: [entry], options: { ...parsed.options, noEmit: true } });
  const checker = program.getTypeChecker();
  const file = program.getSourceFile(entry);
  if (!file) throw new Error(`${entry} is not part of the program ${tsconfig} makes`);
  const moduleSymbol = checker.getSymbolAtLocation(file);
  if (!moduleSymbol) return [];

  const out: ExportedComponent[] = [];
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const name = exported.getName();
    if (!/^[A-Z]/.test(name)) continue;
    const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    if (!(symbol.flags & (ts.SymbolFlags.Value | ts.SymbolFlags.Class))) continue;
    const type = checker.getTypeOfSymbolAtLocation(symbol, file);
    const props = propsOf(checker, type);
    if (!props) continue;
    const callbacks = new Set<string>();
    for (const part of props.isUnion() ? props.types : [props]) {
      for (const prop of checker.getPropertiesOfType(part)) {
        const propName = prop.getName();
        if (!(INTERACTIVE_HANDLERS.includes(propName) || CALLBACK_PROP.test(propName))) continue;
        const propType = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(prop, file));
        if (takesFunction(propType)) callbacks.add(propName);
      }
    }
    out.push({ name, callbacks: [...callbacks].sort() });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The props of a component type: its call signature's first parameter, or its constructor's. */
function propsOf(checker: ts.TypeChecker, type: ts.Type): ts.Type | null {
  const signatures = [...type.getCallSignatures(), ...type.getConstructSignatures()];
  for (const signature of signatures) {
    const first = signature.getParameters()[0];
    if (!first) continue;
    const declaration = first.valueDeclaration ?? first.declarations?.[0];
    if (!declaration) continue;
    const props = checker.getTypeOfSymbolAtLocation(first, declaration);
    if (props.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection | ts.TypeFlags.Union)) return props;
  }
  return null;
}

function takesFunction(type: ts.Type): boolean {
  if (type.isUnion()) return type.types.some(takesFunction);
  return type.getCallSignatures().length > 0;
}

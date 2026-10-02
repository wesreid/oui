/**
 * The app's source as the TypeScript compiler sees it, and what can be read
 * from it without running it: literals, constants, JSX text.
 */

import { dirname, relative } from 'node:path';
import ts from 'typescript';

export interface Source {
  program: ts.Program;
  checker: ts.TypeChecker;
  root: string;
  /** Whether a file is the app's own source (not a declaration, not a dependency). */
  isAppFile(file: ts.SourceFile): boolean;
  /** A file's path relative to the app root, for messages and `declaredIn`. */
  rel(file: ts.SourceFile | string): string;
}

/**
 * The app's program. `overlay` holds files the generator is about to emit (a
 * tier 2 bound module), by absolute path: the program reads them as written
 * now, not as they are on disk, so a page's imports of them resolve and type
 * against the output of this run, in `--check` too.
 */
export function loadSource(
  root: string,
  tsconfig: string,
  rootNames?: readonly string[],
  overlay: ReadonlyMap<string, string> = new Map(),
): Source {
  const read = ts.readConfigFile(tsconfig, ts.sys.readFile);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(tsconfig));
  const options = { ...parsed.options, noEmit: true };
  const host = ts.createCompilerHost(options);
  if (overlay.size) {
    const dirs = new Set([...overlay.keys()].map(f => dirname(f)));
    const { fileExists, readFile, getSourceFile, directoryExists } = host;
    host.fileExists = file => overlay.has(file) || fileExists.call(host, file);
    host.readFile = file => overlay.get(file) ?? readFile.call(host, file);
    host.directoryExists = dir => dirs.has(dir) || (directoryExists ? directoryExists.call(host, dir) : ts.sys.directoryExists(dir));
    host.getSourceFile = (file, languageVersion, onError, shouldCreate) => {
      const text = overlay.get(file);
      return text !== undefined
        ? ts.createSourceFile(file, text, languageVersion, true)
        : getSourceFile.call(host, file, languageVersion, onError, shouldCreate);
    };
  }
  const program = ts.createProgram({
    rootNames: [...(rootNames ?? parsed.fileNames), ...[...overlay.keys()].filter(f => /\.[cm]?tsx?$/.test(f))],
    options,
    projectReferences: parsed.projectReferences,
    host,
  });
  const checker = program.getTypeChecker();
  const src = `${root}/`;
  return {
    program,
    checker,
    root,
    isAppFile: file =>
      !file.isDeclarationFile && file.fileName.startsWith(src) && !file.fileName.includes('/node_modules/'),
    rel: file => relative(root, typeof file === 'string' ? file : file.fileName),
  };
}

/** A value that cannot be known without running the app. */
export const UNKNOWN: unique symbol = Symbol('unknown');
export type Evaluated = unknown | typeof UNKNOWN;

/** Strip `as`, `satisfies`, `!` and parentheses. */
export function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isTypeAssertionExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

/** The declaration a symbol finally stands for, through imports and re-exports. */
export function resolveSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return symbol;
}

/** The initializer of the constant an identifier names, if it is one. */
export function constInitializer(checker: ts.TypeChecker, id: ts.Identifier): ts.Expression | undefined {
  const symbol = resolveSymbol(checker, id);
  const decl = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
    const list = decl.parent;
    if (ts.isVariableDeclarationList(list) && list.flags & ts.NodeFlags.Const) return decl.initializer;
  }
  return undefined;
}

/** Arithmetic on numbers the evaluator reads, other than `+` (which also joins text). */
const ARITHMETIC = new Map<ts.SyntaxKind, (a: number, b: number) => number>([
  [ts.SyntaxKind.AsteriskToken, (a, b) => a * b],
  [ts.SyntaxKind.MinusToken, (a, b) => a - b],
  [ts.SyntaxKind.SlashToken, (a, b) => a / b],
]);

/**
 * The value an expression has without running anything: literals, arrays and
 * objects of them, constants (imported ones too), properties of constant
 * objects, arithmetic on known numbers, and strings built only from those — a template literal or a `+`
 * whose every part is itself known. Anything else, a call above all, is
 * `UNKNOWN` (inside objects and arrays too, so a partly-known value keeps what
 * is known). A text written once as a constant can so be a binding's
 * description without being copied into it.
 */
export function evaluate(checker: ts.TypeChecker, expr: ts.Expression | undefined, depth = 0): Evaluated {
  // Deep enough for a text built from constants built from constants.
  if (!expr || depth > 16) return UNKNOWN;
  const e = unwrap(expr);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isNumericLiteral(e)) return Number(e.text);
  if (e.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (e.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (e.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isIdentifier(e) && e.text === 'undefined') return undefined;
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken) {
    const v = evaluate(checker, e.operand, depth + 1);
    return typeof v === 'number' ? -v : UNKNOWN;
  }
  if (ts.isArrayLiteralExpression(e)) {
    const out: unknown[] = [];
    for (const el of e.elements) {
      if (ts.isSpreadElement(el)) {
        const spread = evaluate(checker, el.expression, depth + 1);
        if (Array.isArray(spread)) out.push(...spread);
        else return UNKNOWN;
      } else {
        out.push(evaluate(checker, el, depth + 1));
      }
    }
    return out;
  }
  if (ts.isObjectLiteralExpression(e)) {
    const out: Record<string, unknown> = {};
    for (const prop of e.properties) {
      if (ts.isPropertyAssignment(prop)) {
        const name = propertyName(prop.name);
        if (name !== null) out[name] = evaluate(checker, prop.initializer, depth + 1);
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        out[prop.name.text] = evaluate(checker, prop.name, depth + 1);
      } else if (ts.isSpreadAssignment(prop)) {
        const spread = evaluate(checker, prop.expression, depth + 1);
        if (spread && typeof spread === 'object') Object.assign(out, spread);
      }
    }
    return out;
  }
  if (ts.isIdentifier(e)) {
    const init = constInitializer(checker, e);
    return init ? evaluate(checker, init, depth + 1) : literalType(checker, e);
  }
  if (ts.isPropertyAccessExpression(e)) {
    const base = evaluate(checker, e.expression, depth + 1);
    if (base && typeof base === 'object' && e.name.text in base) {
      return (base as Record<string, unknown>)[e.name.text];
    }
    return literalType(checker, e);
  }
  if (ts.isTemplateExpression(e)) {
    let text = e.head.text;
    for (const span of e.templateSpans) {
      const part = evaluate(checker, span.expression, depth + 1);
      if (!isTextPart(part)) return UNKNOWN;
      text += String(part) + span.literal.text;
    }
    return text;
  }
  // A number built from constants: `30 * 60_000`, `HOUR - MINUTE`.
  if (ts.isBinaryExpression(e) && ARITHMETIC.has(e.operatorToken.kind)) {
    const left = evaluate(checker, e.left, depth + 1);
    const right = evaluate(checker, e.right, depth + 1);
    if (typeof left !== 'number' || typeof right !== 'number') return UNKNOWN;
    const value = ARITHMETIC.get(e.operatorToken.kind)!(left, right);
    return Number.isFinite(value) ? value : UNKNOWN;
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = evaluate(checker, e.left, depth + 1);
    const right = evaluate(checker, e.right, depth + 1);
    if (typeof left === 'number' && typeof right === 'number') return left + right;
    if (isTextPart(left) && isTextPart(right) && (typeof left === 'string' || typeof right === 'string')) {
      return String(left) + String(right);
    }
    return UNKNOWN;
  }
  return UNKNOWN;
}

/**
 * The one value a name's type allows, when its type is a single string or
 * number literal: a declared constant with no initializer to read, such as a
 * generated API schema's `readonly description: "…"` in a `.d.ts`.
 */
function literalType(checker: ts.TypeChecker, e: ts.Expression): Evaluated {
  const type = checker.getTypeAtLocation(e);
  if (type.isStringLiteral() || type.isNumberLiteral()) return type.value;
  return UNKNOWN;
}

/** A value a template or a `+` can put in a string as JavaScript would, and the same on every build. */
function isTextPart(v: Evaluated): v is string | number | boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

export function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

/** An object literal's property, by name. */
export function objectProperty(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && propertyName(prop.name) === name) return prop.initializer;
    if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === name) return prop.name;
  }
  return undefined;
}

export type JsxOpening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

/** A JSX element's attribute expression (`true` for a bare attribute), by name. */
export function jsxAttribute(el: JsxOpening, name: string): ts.Expression | true | undefined {
  for (const attr of el.attributes.properties) {
    if (ts.isJsxAttribute(attr) && attr.name.getText() === name) {
      if (!attr.initializer) return true;
      if (ts.isStringLiteral(attr.initializer)) return attr.initializer;
      if (ts.isJsxExpression(attr.initializer)) return attr.initializer.expression;
      return undefined;
    }
  }
  return undefined;
}

export function hasJsxAttribute(el: JsxOpening, name: string): boolean {
  return el.attributes.properties.some(a => ts.isJsxAttribute(a) && a.name.getText() === name);
}

/**
 * The label a JSX element's own children show: its direct text, and for an
 * expression that is not static (`{busy ? 'Saving…' : 'Save'}`) its resting
 * label, the last alternative. Nested elements (icons, badges) are not read:
 * their text is not the control's name.
 */
export function jsxText(checker: ts.TypeChecker, node: ts.Node): string {
  const parts: string[] = [];
  const children = ts.isJsxElement(node) ? node.children : ts.isJsxFragment(node) ? node.children : [];
  for (const n of children) {
    if (ts.isJsxText(n)) parts.push(n.text);
    else if (ts.isJsxExpression(n) && n.expression) {
      const v = evaluate(checker, n.expression);
      if (typeof v === 'string' || typeof v === 'number') parts.push(String(v));
      else {
        const literals = stringLiterals(n.expression);
        if (literals.length) parts.push(literals[literals.length - 1]);
      }
    } else if (ts.isJsxFragment(n)) parts.push(jsxText(checker, n));
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** `voices.detail.preview-save-sound` → `Preview save sound`: a name when the code gives none. */
export function humanizeId(id: string): string {
  const last = id.split('.').pop() ?? id;
  const words = last
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : id;
}

/** Every string literal in an expression: the words a conditional title or description can show. */
export function stringLiterals(expr: ts.Node | undefined): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      // Not a comparison operand (`scope === 'extended'`): only the values shown.
      const parent = n.parent;
      if (parent && ts.isBinaryExpression(parent) && isComparison(parent.operatorToken.kind)) return;
      out.push(n.text);
    }
    ts.forEachChild(n, visit);
  };
  if (expr) visit(expr);
  return [...new Set(out.map(s => s.trim()).filter(Boolean))];
}

export function isComparison(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    kind === ts.SyntaxKind.EqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsToken
  );
}

/**
 * What a page offers, read from its component tree (ADR-0220 §2.4).
 *
 * From the route's page component, through the app's own components, every
 * design-system control is recorded with its binding, the props its schema
 * comes from, and the containers a person goes through to reach it: the tab
 * that shows it, the dialog that holds it (and the controls that open that
 * dialog), the menu it is an entry of. Rooms are recorded where a page
 * registers one or renders one of its hosts.
 */

import ts from 'typescript';

import {
  CALLBACK_PROP,
  effectKind,
  INTERACTIVE_HANDLERS,
  INTERACTIVE_TAGS,
  isAgentBinding,
  type ActionEffect,
  type AgentBinding,
  type AnyControlKind,
  type ControlDescriptor,
  type ReachStep,
  type SchemaProps,
} from '@ouispec/bindings';

import { componentDeclaration, type Controls, type LoadedCatalog } from './inputs.js';
import {
  evaluate,
  hasJsxAttribute,
  humanizeId,
  isComparison,
  jsxAttribute,
  jsxText,
  objectProperty,
  resolveSymbol,
  stringLiterals,
  UNKNOWN,
  unwrap,
  type JsxOpening,
  type Source,
} from './program.js';

/** A dialog on the page, whose openers are found once the whole page is read. */
export interface DialogStep {
  kind: 'dialog' | 'panel';
  binding?: string;
  title: string;
  openedBy: string[];
  /** Resolution inputs, dropped before output. */
  owner?: ts.Node;
  setters?: string[];
  site?: string;
}

export interface FoundControl {
  /** Where the binding is declared: file, position and slot or entry. */
  site: string;
  binding: AgentBinding;
  kind: AnyControlKind;
  title: string;
  itemized: boolean;
  schemaProps: SchemaProps;
  reach: (ReachStep | DialogStep)[];
  declaredIn: string;
  line: number;
  /** The component whose JSX declares it. */
  component: string;
  /** The navigate target its callback calls with a literal, when it declares no effect. */
  inferredNavigate?: string;
  /**
   * What the field itself tells the person, when it is known at build time:
   * its hint (under any control) and its placeholder (in a text field). The PA
   * reads what the person reads.
   */
  hint?: string;
  placeholder?: string;
  /** Resolution inputs for dialog openers: each callback where it is written, and the component it is in. */
  owner: ts.Node;
  callbacks: { expr: ts.Expression; owner: ts.Node }[];
}

/** A display that shows facts (a clip's parameters): not a control, reported in the page state. */
export interface FoundDisplay {
  site: string;
  binding: AgentBinding;
  title: string;
  /** Its facts' labels, when they are known at build time. */
  labels: string[];
  reach: (ReachStep | DialogStep)[];
  declaredIn: string;
  line: number;
}

export interface Finding {
  file: string;
  line: number;
  message: string;
}

export interface PageAnalysis {
  controls: FoundControl[];
  rooms: Set<LoadedCatalog>;
  dialogs: DialogStep[];
  /** The page's own PageHeader: its title and every description it can show. */
  header: { title: string | null; subtitles: string[] };
  /** Displays of facts, each with its binding. */
  displays: FoundDisplay[];
  /** Interactive design-system controls with no binding. */
  unbound: Finding[];
  /** Declarations that are wrong wherever they are. */
  errors: Finding[];
}

interface PropSource {
  expr: ts.Expression;
  owner: ts.Node;
  ctx: WalkContext;
}

interface WalkContext {
  reach: (ReachStep | DialogStep)[];
  itemized: boolean;
  props: ReadonlyMap<string, PropSource>;
  depth: number;
  /** The element that rendered this component, in its parent. */
  element?: JsxOpening;
}

const ITERATORS = new Set(['map', 'flatMap']);

export class PageAnalyzer {
  /** Entry objects made once per row, by a `map` or `flatMap`. */
  private readonly rowEntries = new Set<ts.ObjectLiteralExpression>();

  constructor(
    private readonly source: Source,
    private readonly controls: Controls,
    private readonly catalogs: readonly LoadedCatalog[],
    private readonly designSystem: readonly string[],
    /** The design-system packages whose tables were read. */
    private readonly tablesRead: ReadonlySet<string> = new Set(designSystem),
    /** A package's person-only components (`oui.personOnly`), by export name, with why. */
    private readonly personOnly: (pkg: string) => ReadonlyMap<string, string> = () => new Map(),
  ) {}

  analyze(pageDecl: ts.Node): PageAnalysis {
    const result: PageAnalysis = {
      controls: [],
      rooms: new Set(),
      dialogs: [],
      header: { title: null, subtitles: [] },
      displays: [],
      unbound: [],
      errors: [],
    };
    const seen = new Set<string>();
    this.walk(pageDecl, { reach: [], itemized: false, props: new Map(), depth: 0 }, result, seen, true);
    this.resolveOpeners(result);
    this.checkApprovedOnce(result);
    return result;
  }

  // ─── Components ────────────────────────────────────────────────────────────

  private body(decl: ts.Node): ts.Node | null {
    if (ts.isFunctionDeclaration(decl) || ts.isFunctionExpression(decl) || ts.isArrowFunction(decl)) {
      return decl.body ?? null;
    }
    if (ts.isVariableDeclaration(decl) && decl.initializer) {
      const init = unwrap(decl.initializer);
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init.body;
      if (ts.isCallExpression(init)) {
        // forwardRef(...), memo(...), memo(forwardRef(...))
        for (const arg of init.arguments) {
          const inner = unwrap(arg);
          if (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) return inner.body;
          if (ts.isCallExpression(inner)) {
            const f = inner.arguments
              .map(unwrap)
              .find(a => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
            if (f && (ts.isArrowFunction(f) || ts.isFunctionExpression(f))) return f.body;
          }
        }
      }
    }
    return null;
  }

  private componentFunction(decl: ts.Node): ts.SignatureDeclaration | null {
    if (ts.isFunctionDeclaration(decl) || ts.isFunctionExpression(decl) || ts.isArrowFunction(decl))
      return decl;
    if (ts.isVariableDeclaration(decl) && decl.initializer) {
      const init = unwrap(decl.initializer);
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
      if (ts.isCallExpression(init)) {
        for (const arg of init.arguments) {
          const inner = unwrap(arg);
          if (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) return inner;
        }
      }
    }
    return null;
  }

  private componentName(decl: ts.Node): string {
    if (
      (ts.isFunctionDeclaration(decl) || ts.isVariableDeclaration(decl)) &&
      decl.name &&
      ts.isIdentifier(decl.name)
    ) {
      return decl.name.text;
    }
    return '(anonymous)';
  }

  /** The props a component destructures: local name → prop name. */
  private destructuredProps(decl: ts.Node): Map<string, string> {
    const fn = this.componentFunction(decl);
    const out = new Map<string, string>();
    const param = fn?.parameters[0];
    if (param && ts.isObjectBindingPattern(param.name)) {
      for (const el of param.name.elements) {
        if (ts.isIdentifier(el.name)) {
          const prop = el.propertyName ? el.propertyName.getText() : el.name.text;
          out.set(el.name.text, prop);
        }
      }
    }
    return out;
  }

  private walk(decl: ts.Node, ctx: WalkContext, out: PageAnalysis, seen: Set<string>, isPage: boolean): void {
    const body = this.body(decl);
    if (!body) return;
    const sf = decl.getSourceFile();
    if (!this.source.isAppFile(sf)) return;
    const key = `${sf.fileName}:${decl.pos}:${ctx.element ? `${ctx.element.getSourceFile().fileName}@${ctx.element.pos}` : ''}:${ctx.reach.map(r => JSON.stringify({ ...r, owner: undefined, setters: undefined })).join('>')}:${ctx.itemized}`;
    if (seen.has(key) || ctx.depth > 40) return;
    seen.add(key);

    const component = this.componentName(decl);
    const tabs = this.boundTabs(body);

    // Rooms this component registers, itself or through the app's own hooks.
    this.findRegistrations(body, out, new Set());

    const visit = (n: ts.Node) => {
      if (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n))
        this.element(n, decl, component, body, ctx, tabs, out, seen, isPage);
      ts.forEachChild(n, visit);
    };
    visit(body);
  }

  /**
   * `useRoomRegistration(catalog, …)` in a body, or in an app hook it calls
   * (`useVectorBoardSurface()`), followed hook by hook.
   */
  private findRegistrations(
    node: ts.Node,
    out: PageAnalysis,
    seen: Set<string>,
    args: ReadonlyMap<string, ts.Expression> = new Map(),
  ): void {
    // An argument named by one of the hook's own parameters is what its caller passed.
    const passed = (expr: ts.Expression): ts.Expression => {
      const e = unwrap(expr);
      return ts.isIdentifier(e) && args.has(e.text) ? args.get(e.text)! : expr;
    };
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        if (callee.getText() === 'useRoomRegistration' && n.arguments[0]) {
          const catalog = this.catalogFor(passed(n.arguments[0]));
          if (catalog) out.rooms.add(catalog);
        } else if (ts.isIdentifier(callee) && /^use[A-Z]/.test(callee.text)) {
          const symbol = resolveSymbol(this.source.checker, callee);
          const decl = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
          if (decl && this.source.isAppFile(decl.getSourceFile())) {
            // A hook that registers the catalog it is given is followed once per catalog it is given.
            const callArgs = n.arguments.map(passed);
            const key = `${decl.getSourceFile().fileName}:${decl.pos}:${callArgs.map(a => a.getText()).join(',')}`;
            if (!seen.has(key)) {
              seen.add(key);
              const body = this.body(decl);
              const params = this.componentFunction(decl)?.parameters ?? [];
              const inner = new Map<string, ts.Expression>();
              params.forEach((param, i) => {
                if (ts.isIdentifier(param.name) && callArgs[i]) inner.set(param.name.text, callArgs[i]);
              });
              if (body) this.findRegistrations(body, out, seen, inner);
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
  }

  /** The catalog an expression names: a package's, by import, or the app's own, by module and export. */
  private catalogFor(expr: ts.Expression): LoadedCatalog | undefined {
    const pkg = this.importSource(expr);
    const byPackage = pkg ? this.catalogs.find(c => c.package === pkg) : undefined;
    if (byPackage) return byPackage;
    const id = unwrap(expr);
    if (!ts.isIdentifier(id)) return undefined;
    const symbol = resolveSymbol(this.source.checker, id);
    const decl = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (!decl || !symbol) return undefined;
    const file = decl.getSourceFile().fileName;
    return this.catalogs.find(c => c.appModule?.file === file && c.appModule.export === symbol.name);
  }

  /** The package a JSX tag or identifier is imported from, when it is a bare package specifier. */
  private importSource(node: ts.Node): string | null {
    const id = ts.isPropertyAccessExpression(node) ? node.expression : node;
    if (!ts.isIdentifier(id)) return null;
    const symbol = this.source.checker.getSymbolAtLocation(id);
    const decl = symbol?.declarations?.[0];
    if (!decl) return null;
    let n: ts.Node | undefined = decl;
    while (n && !ts.isImportDeclaration(n)) n = n.parent;
    if (!n || !ts.isImportDeclaration(n) || !ts.isStringLiteral(n.moduleSpecifier)) return null;
    return n.moduleSpecifier.text;
  }

  /** The exported name a JSX tag imports from a package (through `as` renames). */
  private importedName(tag: ts.JsxTagNameExpression): string {
    const id = ts.isPropertyAccessExpression(tag) ? tag.expression : tag;
    const symbol = this.source.checker.getSymbolAtLocation(id);
    const decl = symbol?.declarations?.[0];
    if (decl && ts.isImportSpecifier(decl)) return (decl.propertyName ?? decl.name).text;
    return tag.getText();
  }

  // ─── One JSX element ───────────────────────────────────────────────────────

  private element(
    el: JsxOpening,
    decl: ts.Node,
    component: string,
    body: ts.Node,
    ctx: WalkContext,
    tabs: Map<string, { binding: string; options: Map<string, string> }>,
    out: PageAnalysis,
    seen: Set<string>,
    isPage: boolean,
  ): void {
    const tagText = el.tagName.getText();
    if (!/^[A-Z]/.test(tagText.split('.').pop() ?? '')) {
      this.intrinsic(el, tagText, out);
      return;
    }
    const pkg = this.importSource(el.tagName);
    const local = this.localReach(el, body, tabs, out, decl, ctx);
    const reach = [...ctx.reach, ...local.reach];
    const itemized = local.itemized ?? ctx.itemized;

    if (pkg && this.designSystem.includes(pkg)) {
      const name = this.importedName(el.tagName);
      if (isPage && name === 'PageHeader' && out.header.title === null) {
        const title = evaluate(this.source.checker, asExpr(jsxAttribute(el, 'title')));
        out.header.title = typeof title === 'string' ? title : null;
        out.header.subtitles = stringLiterals(asExpr(jsxAttribute(el, 'subtitle')));
      }
      const descriptor = this.controls.get(`${pkg}#${name}`);
      if (descriptor) this.control(el, descriptor, decl, component, ctx, reach, itemized, out);
      else if (this.tablesRead.has(pkg))
        this.foreign(el, tagText, pkg, out, `is not in ${pkg}'s control table: bind it there`);
      return;
    }

    const personOnly = pkg ? this.personOnly(pkg).get(this.importedName(el.tagName)) : undefined;
    if (pkg && personOnly) {
      this.personOnlyElement(el, tagText, pkg, personOnly, out);
      return;
    }

    const room =
      pkg && this.catalogs.find(c => c.package === pkg && c.hosts.includes(this.importedName(el.tagName)));
    if (room) {
      out.rooms.add(room);
      return;
    }

    // One of the app's own components: read it with what this element passes it.
    const target = this.appComponent(el.tagName);
    if (!target) {
      this.foreign(el, tagText, pkg, out, 'is neither a design-system control nor a room host: use a bound control that does the same');
      return;
    }
    const appRoom = this.catalogs.find(c => c.appModule && c.hosts.includes(tagText));
    if (appRoom) out.rooms.add(appRoom);
    const props = new Map<string, PropSource>();
    for (const attr of el.attributes.properties) {
      if (
        ts.isJsxAttribute(attr) &&
        attr.initializer &&
        ts.isJsxExpression(attr.initializer) &&
        attr.initializer.expression
      ) {
        props.set(attr.name.getText(), { expr: attr.initializer.expression, owner: decl, ctx });
      }
    }
    this.walk(target, { reach, itemized, props, depth: ctx.depth + 1, element: el }, out, seen, false);
  }

  /** The app's own component a tag names, through `lazy` and `React.lazy`; null for anything else. */
  private appComponent(tag: ts.JsxTagNameExpression): ts.Node | null {
    const decl = componentDeclaration(this.source, tag);
    return decl && this.source.isAppFile(decl.getSourceFile()) ? decl : null;
  }

  /**
   * A component with no control table entry — a third-party library's, or a
   * design-system export the table leaves out — cannot carry a binding, so a
   * callback passed to it is something someone can use that the assistant
   * never can. On an enforced page it must be bound, or say why the assistant
   * never needs it with `data-non-agent="<reason>"`. `fix` says which.
   */
  private foreign(el: JsxOpening, tag: string, pkg: string | null, out: PageAnalysis, fix: string): void {
    const callbacks = el.attributes.properties.flatMap(attr =>
      ts.isJsxAttribute(attr) && CALLBACK_PROP.test(attr.name.getText()) && this.takesFunction(attr)
        ? [attr.name.getText()]
        : [],
    );
    if (!callbacks.length || this.nonAgentReason(el)) return;
    const sf = el.getSourceFile();
    out.unbound.push({
      file: this.source.rel(sf),
      line: sf.getLineAndCharacterOfPosition(el.getStart()).line + 1,
      message:
        `<${tag}> from ${pkg ?? 'outside the app'} takes ${callbacks.join(', ')}, but ${fix}, or data-non-agent="<reason>"`,
    });
  }

  /**
   * A component only the person may use (ADR-0228 §2.2.3): it takes no `agent`
   * binding, not even `nonAgent`, and no spread, which could carry one the
   * build cannot read. What it renders is the package's own and never bound,
   * so its callbacks are not something the assistant is missing.
   */
  private personOnlyElement(el: JsxOpening, tag: string, pkg: string, why: string, out: PageAnalysis): void {
    const sf = el.getSourceFile();
    const at = { file: this.source.rel(sf), line: sf.getLineAndCharacterOfPosition(el.getStart()).line + 1 };
    if (hasJsxAttribute(el, 'agent')) {
      out.errors.push({ ...at, message: `<${tag}> from ${pkg} is the person's own and takes no agent binding: ${why}` });
    }
    if (el.attributes.properties.some(attr => ts.isJsxSpreadAttribute(attr))) {
      out.errors.push({
        ...at,
        message: `<${tag}> from ${pkg} is the person's own: write its props out, not as a spread, so the build can see none is an agent binding`,
      });
    }
  }

  /** Whether an attribute's value is a function: written as one, or typed as one. */
  private takesFunction(attr: ts.JsxAttribute): boolean {
    const init = attr.initializer;
    if (!init || !ts.isJsxExpression(init) || !init.expression) return false;
    const e = unwrap(init.expression);
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return true;
    const type = this.source.checker.getNonNullableType(this.source.checker.getTypeAtLocation(e));
    return type.getCallSignatures().length > 0;
  }

  /** `data-non-agent="<reason>"`, when it gives a reason. */
  private nonAgentReason(el: JsxOpening): boolean {
    const reason = jsxAttribute(el, 'data-non-agent');
    if (reason === undefined || reason === true) return false;
    const text = evaluate(this.source.checker, reason);
    return typeof text === 'string' && !!text.trim();
  }

  /**
   * A raw element someone can use — a `<button>`, an `<input>`, a clickable
   * `<div>` — can carry no binding, so the assistant can never use it. On an
   * enforced page it must be a design-system control instead, or say why the
   * assistant never needs it with `data-non-agent="<reason>"`.
   */
  private intrinsic(el: JsxOpening, tag: string, out: PageAnalysis): void {
    const interactive = INTERACTIVE_TAGS.has(tag) || INTERACTIVE_HANDLERS.some(h => hasJsxAttribute(el, h));
    if (!interactive) return;
    if (
      tag === 'input' &&
      ['hidden', 'file'].includes(String(evaluate(this.source.checker, asExpr(jsxAttribute(el, 'type')))))
    ) {
      if (!INTERACTIVE_HANDLERS.some(h => hasJsxAttribute(el, h))) return;
    }
    if (this.nonAgentReason(el)) return;
    const sf = el.getSourceFile();
    out.unbound.push({
      file: this.source.rel(sf),
      line: sf.getLineAndCharacterOfPosition(el.getStart()).line + 1,
      message: `A raw <${tag}> someone can use cannot carry a binding: use the design system's control, or data-non-agent="<reason>"`,
    });
  }

  // ─── Where an element sits in its component ────────────────────────────────

  /** SimpleTabs-like containers bound in this component, by the expression their state prop reads. */
  private boundTabs(body: ts.Node) {
    const out = new Map<string, { binding: string; options: Map<string, string> }>();
    const visit = (n: ts.Node) => {
      if (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) {
        const pkg = this.importSource(n.tagName);
        const descriptor = pkg ? this.controls.get(`${pkg}#${this.importedName(n.tagName)}`) : undefined;
        if (descriptor?.container?.kind === 'tabs') {
          const state = asExpr(jsxAttribute(n, descriptor.container.stateProp));
          const agent = evaluate(this.source.checker, asExpr(jsxAttribute(n, 'agent')));
          if (state && isAgentBinding(agent)) {
            const options = new Map<string, string>();
            for (const o of this.options(n, descriptor)) options.set(String(o.value), o.title);
            out.set(state.getText(), { binding: agent.id, options });
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(body);
    return out;
  }

  /** The containers between an element and its component's root, and whether it is rendered per row. */
  private localReach(
    el: JsxOpening,
    body: ts.Node,
    tabs: Map<string, { binding: string; options: Map<string, string> }>,
    out: PageAnalysis,
    decl: ts.Node,
    ctx: WalkContext,
  ): { reach: (ReachStep | DialogStep)[]; itemized: boolean | null } {
    const steps: (ReachStep | DialogStep)[] = [];
    // Whether the element is one of a list's rows. A dialog between it and a
    // list resets that: a dialog rendered per row is open for one row at a
    // time. `null` means nothing here decides, so the parent's answer stands.
    let itemized: boolean | null = null;
    let child: ts.Node = ts.isJsxOpeningElement(el) ? el.parent : el;
    let node: ts.Node | undefined = child.parent;
    while (node && node !== body) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ITERATORS.has(node.expression.name.text)
      ) {
        if (node.arguments.includes(child as ts.Expression) && itemized === null) itemized = true;
      }
      const tab = this.tabCondition(node, child, tabs);
      if (tab) steps.unshift(tab);
      const panel = tab ? null : this.panelCondition(node, child, out, decl, ctx);
      if (panel) steps.unshift(panel);
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const opening = ts.isJsxElement(node) ? node.openingElement : node;
        const dialog = this.dialogStep(opening, out, decl, ctx);
        if (dialog && opening !== el) {
          steps.unshift(dialog);
          if (itemized === null) itemized = false;
        }
      }
      child = node;
      node = node.parent;
    }
    return { reach: steps, itemized };
  }

  /**
   * `selectedId && <Panel/>` or `open ? <Panel/> : …`: a part of the page shown
   * once some state is set. Its openers are the bound controls whose callback
   * sets that state (found with the dialogs' openers).
   */
  private panelCondition(
    node: ts.Node,
    child: ts.Node,
    out: PageAnalysis,
    decl: ts.Node,
    ctx: WalkContext,
  ): DialogStep | null {
    let condition: ts.Expression | null = null;
    let branch: ts.Node | null = null;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      child === node.right
    ) {
      condition = node.left;
      branch = node.right;
    } else if (ts.isConditionalExpression(node) && child === node.whenTrue) {
      condition = node.condition;
      branch = node.whenTrue;
    }
    if (!condition || !branch) return null;
    const gates = gateIdentifiers(condition);
    if (!gates.length) return null;
    const site = `${node.getSourceFile().fileName}:${node.pos}:panel`;
    const existing = out.dialogs.find(d => d.site === site);
    if (existing) return existing;
    const resolved = gates.map(g => this.throughProps(g, decl, ctx));
    const tag = firstComponentTag(branch);
    const step: DialogStep = {
      kind: 'panel',
      title: tag ? words(tag) : humanizeId(gates[0].getText()),
      openedBy: [],
      site,
      owner: resolved[0].owner,
      setters: resolved.flatMap(r => identifiers(r.expr)).map(n => `set${n[0].toUpperCase()}${n.slice(1)}`),
    };
    out.dialogs.push(step);
    return step;
  }

  /** `tab === 'x' ? <A/> : …` or `tab === 'x' && <A/>`, where `tab` is a bound tab set's state. */
  private tabCondition(
    node: ts.Node,
    child: ts.Node,
    tabs: Map<string, { binding: string; options: Map<string, string> }>,
  ): ReachStep | null {
    let condition: ts.Expression | null = null;
    let whenTrue = true;
    if (ts.isConditionalExpression(node) && (child === node.whenTrue || child === node.whenFalse)) {
      condition = node.condition;
      whenTrue = child === node.whenTrue;
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      child === node.right
    ) {
      condition = node.left;
    }
    if (!condition) return null;
    const c = unwrap(condition);
    if (!ts.isBinaryExpression(c) || !isComparison(c.operatorToken.kind)) return null;
    const negated =
      c.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      c.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken;
    if (negated === whenTrue) return null;
    const [stateSide, literalSide] = ts.isStringLiteral(unwrap(c.right))
      ? [c.left, c.right]
      : [c.right, c.left];
    const value = evaluate(this.source.checker, literalSide);
    const tab = tabs.get(unwrap(stateSide).getText());
    if (!tab || typeof value !== 'string') return null;
    return { kind: 'tab', binding: tab.binding, value, title: tab.options.get(value) ?? value };
  }

  private dialogStep(
    opening: JsxOpening,
    out: PageAnalysis,
    decl: ts.Node,
    ctx: WalkContext,
  ): DialogStep | null {
    const pkg = this.importSource(opening.tagName);
    if (!pkg || !this.designSystem.includes(pkg)) return null;
    const descriptor = this.controls.get(`${pkg}#${this.importedName(opening.tagName)}`);
    if (descriptor?.container?.kind !== 'dialog') return null;
    const site = `${opening.getSourceFile().fileName}:${opening.pos}`;
    const existing = out.dialogs.find(d => d.site === site);
    if (existing) return existing;
    const titleProp = descriptor.titleProps[0];
    const title = titleProp
      ? evaluate(this.source.checker, asExpr(jsxAttribute(opening, titleProp)))
      : UNKNOWN;
    const agent = evaluate(this.source.checker, asExpr(jsxAttribute(opening, 'agent')));
    const bound = isAgentBinding(agent) ? agent : null;
    const step: DialogStep = {
      kind: 'dialog',
      title:
        bound?.title ??
        (typeof title === 'string' && title.trim()
          ? title
          : bound
            ? humanizeId(bound.id)
            : words(this.componentName(decl))),
      openedBy: [],
      site,
      ...(isAgentBinding(agent) ? { binding: agent.id } : {}),
    };
    const state = asExpr(jsxAttribute(opening, descriptor.container.stateProp));
    if (state) {
      const resolved = this.throughProps(state, decl, ctx);
      step.owner = resolved.owner;
      step.setters = identifiers(resolved.expr).map(n => `set${n[0].toUpperCase()}${n.slice(1)}`);
    }
    out.dialogs.push(step);
    return step;
  }

  /**
   * An expression followed up through the props it was passed down as: a
   * dialog's `open={open}` in a child is the parent's `open={createOpen}`,
   * and a button's `onClick={onCreate}` is the parent's `onCreate={() => …}`.
   * Returns the expression where it is written and the component it is in.
   */
  private throughProps(
    expr: ts.Expression,
    owner: ts.Node,
    ctx: WalkContext,
  ): { expr: ts.Expression; owner: ts.Node } {
    const e = unwrap(expr);
    if (ts.isIdentifier(e)) {
      const prop = this.destructuredProps(owner).get(e.text);
      const from = prop !== undefined ? ctx.props.get(prop) : undefined;
      if (from) return this.throughProps(from.expr, from.owner, from.ctx);
    }
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
      const fn = this.componentFunction(owner);
      const param = fn?.parameters[0];
      if (param && ts.isIdentifier(param.name) && param.name.text === e.expression.text) {
        const from = ctx.props.get(e.name.text);
        if (from) return this.throughProps(from.expr, from.owner, from.ctx);
      }
    }
    return { expr, owner };
  }

  /**
   * The `agent` a control is given, followed through the props of the
   * wrappers that forward it. `missing` is the wrapper element that forwards
   * nothing because its own user gave it no binding.
   */
  private forwardedAgent(
    expr: ts.Expression | undefined,
    owner: ts.Node,
    ctx: WalkContext,
  ): { expr?: ts.Expression; missing?: JsxOpening } {
    if (!expr) return {};
    const e = unwrap(expr);
    let prop: string | undefined;
    if (ts.isIdentifier(e)) prop = this.destructuredProps(owner).get(e.text);
    else if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
      const param = this.componentFunction(owner)?.parameters[0];
      if (param && ts.isIdentifier(param.name) && param.name.text === e.expression.text) prop = e.name.text;
    }
    if (prop === undefined) return { expr };
    const from = ctx.props.get(prop);
    if (!from) return ctx.element ? { missing: ctx.element } : { expr };
    return this.forwardedAgent(from.expr, from.owner, from.ctx);
  }

  // ─── One design-system control ─────────────────────────────────────────────

  private control(
    el: JsxOpening,
    descriptor: ControlDescriptor,
    decl: ts.Node,
    component: string,
    ctx: WalkContext,
    reachIn: (ReachStep | DialogStep)[],
    itemized: boolean,
    out: PageAnalysis,
  ): void {
    let reach = reachIn;
    const sf = el.getSourceFile();
    const resolved = (e: ts.Expression | undefined) => (e ? [this.throughProps(e, decl, ctx)] : []);
    const at = { file: this.source.rel(sf), line: sf.getLineAndCharacterOfPosition(el.getStart()).line + 1 };
    const tag = this.importedName(el.tagName);
    // A wrapper may forward its own `agent` prop to the control it renders:
    // the binding is then declared where the wrapper is used.
    const forwarded = this.forwardedAgent(asExpr(jsxAttribute(el, 'agent')), decl, ctx);
    if (forwarded.missing) {
      const parent = forwarded.missing;
      const psf = parent.getSourceFile();
      out.unbound.push({
        file: this.source.rel(psf),
        line: psf.getLineAndCharacterOfPosition(parent.getStart()).line + 1,
        message: `<${parent.tagName.getText()}> passes no agent to the <${tag}> it renders`,
      });
      return;
    }
    const agentExpr = forwarded.expr;
    // A binding forwarded through a wrapper is declared where the wrapper is used,
    // so each use is its own site, even when the uses sit in the wrapper's own file.
    const isForwarded = !!agentExpr && agentExpr !== asExpr(jsxAttribute(el, 'agent'));
    const agent = agentExpr ? evaluate(this.source.checker, agentExpr) : undefined;
    if (agentExpr && (agent === UNKNOWN || typeof agent !== 'object' || agent === null)) {
      out.errors.push({
        ...at,
        message: `<${tag} agent={…}> must be readable at build time: an object literal or a constant`,
      });
      return;
    }
    if (agentExpr && isForwarded) {
      const asf = agentExpr.getSourceFile();
      at.file = this.source.rel(asf);
      at.line = asf.getLineAndCharacterOfPosition(agentExpr.getStart()).line + 1;
    }
    const siteOf = (suffix = '') =>
      `${at.file}:${agentExpr && isForwarded ? agentExpr.pos : el.pos}${suffix}`;
    const agentObj = (agent ?? null) as Record<string, unknown> | null;

    const base = {
      declaredIn: at.file,
      line: at.line,
      component,
      owner: decl,
      schemaProps: this.schemaProps(el, descriptor),
    };
    const slotItem = agentObj && 'item' in agentObj;
    // A dialog's own buttons (confirm, cancel, close) are in the dialog.
    if (descriptor.container?.kind === 'dialog') {
      const own = this.dialogStep(el, out, decl, ctx);
      if (own) reach = [...reach, own];
    }

    // A display of facts: not a control; bound, it names what the page reports.
    if (descriptor.display) {
      if (agentObj && !('nonAgent' in agentObj)) {
        const binding = this.binding(agentObj, at, tag, out);
        if (binding) {
          // Its facts' labels, read as a menu's entries are: literals, spreads, conditionals, a .map.
          const labelKey = descriptor.display.labelKey;
          const labels = [
            ...new Set(
              this.arrayOf(asExpr(jsxAttribute(el, descriptor.display.itemsProp)), []).flatMap(o => {
                const label = evaluate(this.source.checker, objectProperty(o, labelKey));
                return typeof label === 'string' ? [label] : [];
              }),
            ),
          ];
          out.displays.push({
            site: siteOf(),
            binding,
            title: binding.title ?? this.title(el, descriptor),
            labels,
            reach,
            declaredIn: at.file,
            line: at.line,
          });
        }
      }
      return;
    }

    // The control itself.
    if (descriptor.kind) {
      const interactive =
        descriptor.callbacks.length === 0 || descriptor.callbacks.some(cb => hasJsxAttribute(el, cb));
      if (!agentObj) {
        if (interactive) out.unbound.push({ ...at, message: `<${tag}> has no agent binding` });
      } else if (!('nonAgent' in agentObj)) {
        const binding = this.binding(agentObj, at, tag, out);
        if (binding) {
          out.controls.push({
            ...base,
            ...this.fieldGuidance(el, descriptor.kind),
            site: siteOf(),
            binding,
            kind: descriptor.kind,
            title: binding.title ?? this.title(el, descriptor),
            itemized: 'item' in agentObj || !!descriptor.rows,
            reach,
            callbacks: descriptor.callbacks.flatMap(cb => resolved(asExpr(jsxAttribute(el, cb)))),
          });
          this.checkRow(itemized, 'item' in agentObj || !!descriptor.rows, at, binding.id, out);
        }
      } else if (typeof agentObj.nonAgent !== 'string' || !agentObj.nonAgent.trim()) {
        out.errors.push({
          ...at,
          message: `<${tag} agent={{ nonAgent }}> needs the reason it is not for the assistant`,
        });
      }
    }

    // A composite's slots.
    for (const [slot, { kind, callback, rows, defaults }] of Object.entries(descriptor.slots ?? {})) {
      // The prop that makes the slot interactive: a callback, or a flag (a table's bare `sortable`).
      // A slot with no such prop is always interactive.
      const attr = callback ? jsxAttribute(el, callback) : true;
      if (attr === undefined) continue;
      const cbExpr = asExpr(attr);
      const slotValue = agentObj?.[slot];
      // An EmptyState's `action` is an object whose own `agent` binds it.
      // It may differ by state (`cond ? { label, onClick } : undefined`): each object is bound.
      const objects = cbExpr ? objectsOf(cbExpr).filter(o => objectProperty(o, 'onClick')) : [];
      if (objects.length) {
        for (const o of objects)
          this.entry(o, kind, 'onClick', 'label', decl, component, reach, itemized, tag, base, out);
        continue;
      }
      if (slotValue === undefined) {
        out.unbound.push({
          ...at,
          message: callback
            ? `<${tag}> has ${callback} but no agent binding for "${slot}"`
            : `<${tag}> has no agent binding for "${slot}"`,
        });
        continue;
      }
      if (slotValue && typeof slotValue === 'object' && 'nonAgent' in slotValue) continue;
      const binding = this.binding(slotValue as Record<string, unknown>, at, `${tag} ${slot}`, out);
      if (!binding) continue;
      const titleFromEl = this.title(el, descriptor);
      out.controls.push({
        ...base,
        ...(defaults ? { schemaProps: this.schemaProps(el, descriptor, defaults) } : {}),
        site: siteOf(`:${slot}`),
        binding,
        kind,
        title: binding.title ?? `${humanizeId(slot)}${titleFromEl ? ` (${titleFromEl})` : ''}`,
        itemized: !!slotItem || !!rows,
        reach,
        callbacks: cbExpr ? resolved(cbExpr) : [],
      });
      this.checkRow(itemized, !!slotItem || !!rows, at, binding.id, out);
    }

    // Entries of a toolbar, menu or selection bar.
    if (descriptor.entries) {
      const entriesExpr = asExpr(jsxAttribute(el, descriptor.entries.prop));
      const blind: ts.Node[] = [];
      const arr = this.arrayOf(entriesExpr, blind);
      for (const node of blind) {
        const nsf = node.getSourceFile();
        out.unbound.push({
          file: this.source.rel(nsf),
          line: nsf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          message:
            `Entries of <${tag}>'s \`${descriptor.entries.prop}\` are built where the generator cannot read them ` +
            `(\`${node.getText().slice(0, 60)}\`): build them as an array literal, a .map, or pushes of object literals`,
        });
      }
      const menuStep: ReachStep | null =
        descriptor.entries.prop === 'items' && descriptor.kind === undefined && tag !== 'Toolbar'
          ? { kind: 'menu', title: this.title(el, descriptor) || tag }
          : null;
      for (const obj of arr) {
        this.entry(
          obj,
          descriptor.entries.kind,
          descriptor.entries.callback,
          descriptor.entries.titleKey,
          decl,
          component,
          menuStep ? [...reach, menuStep] : reach,
          itemized,
          tag,
          base,
          out,
        );
      }
    }
  }

  private entry(
    obj: ts.ObjectLiteralExpression,
    kind: AnyControlKind,
    callback: string,
    titleKey: string,
    _decl: ts.Node,
    component: string,
    reach: (ReachStep | DialogStep)[],
    itemized: boolean,
    tag: string,
    base: { declaredIn: string; line: number; owner: ts.Node; schemaProps: SchemaProps },
    out: PageAnalysis,
  ): void {
    const cb = objectProperty(obj, callback);
    const agentExpr = objectProperty(obj, 'agent');
    const sf = obj.getSourceFile();
    const here = {
      file: this.source.rel(sf),
      line: sf.getLineAndCharacterOfPosition(obj.getStart()).line + 1,
    };
    if (!agentExpr) {
      if (cb)
        out.unbound.push({ ...here, message: `An entry of <${tag}> has ${callback} but no agent binding` });
      return;
    }
    const agent = evaluate(this.source.checker, agentExpr);
    if (agent === UNKNOWN || !agent || typeof agent !== 'object') {
      out.errors.push({
        ...here,
        message: `An entry's agent binding in <${tag}> must be readable at build time`,
      });
      return;
    }
    if ('nonAgent' in (agent as object)) return;
    const binding = this.binding(agent as Record<string, unknown>, here, tag, out);
    if (!binding) return;
    const title = evaluate(this.source.checker, objectProperty(obj, titleKey));
    out.controls.push({
      ...base,
      component,
      declaredIn: here.file,
      line: here.line,
      site: `${here.file}:${obj.pos}`,
      binding,
      kind,
      title: binding.title ?? (typeof title === 'string' && title.trim() ? title : humanizeId(binding.id)),
      itemized: 'item' in (agent as object),
      reach,
      callbacks: cb ? [{ expr: cb, owner: base.owner }] : [],
    });
    this.checkRow(itemized || this.rowEntries.has(obj), 'item' in (agent as object), here, binding.id, out);
  }

  private checkRow(
    rendered: boolean,
    hasItem: boolean,
    at: { file: string; line: number },
    id: string,
    out: PageAnalysis,
  ) {
    if (rendered && !hasItem) {
      out.errors.push({
        ...at,
        message: `"${id}" is rendered once per row, so its binding needs \`item\` naming the row`,
      });
    }
  }

  private binding(
    value: Record<string, unknown>,
    at: { file: string; line: number },
    tag: string,
    out: PageAnalysis,
  ): AgentBinding | null {
    const { id, description, title, effect, destructive, confirm } = value;
    if (typeof id !== 'string' || typeof description !== 'string' || !description.trim()) {
      out.errors.push({ ...at, message: `<${tag}>'s binding needs a literal \`id\` and \`description\`` });
      return null;
    }
    if (title !== undefined && typeof title !== 'string') {
      out.errors.push({ ...at, message: `"${id}": \`title\` must be a literal` });
      return null;
    }
    if (
      effect !== undefined &&
      (effect === UNKNOWN || (typeof effect !== 'string' && typeof effect !== 'object'))
    ) {
      out.errors.push({ ...at, message: `"${id}": \`effect\` must be a literal` });
      return null;
    }
    return {
      id,
      description: description.trim(),
      ...(typeof title === 'string' ? { title } : {}),
      ...(effect !== undefined ? { effect: effect as ActionEffect } : {}),
      ...(destructive === true ? { destructive: true } : {}),
      ...(confirm === true ? { confirm: true } : {}),
    };
  }

  private title(el: JsxOpening, descriptor: ControlDescriptor): string {
    for (const prop of descriptor.titleProps) {
      if (prop === 'children') {
        const parent = ts.isJsxOpeningElement(el) ? el.parent : null;
        const text = parent ? jsxText(this.source.checker, parent) : '';
        if (text) return text;
        continue;
      }
      const v = evaluate(this.source.checker, asExpr(jsxAttribute(el, prop)));
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  }

  private options(
    el: JsxOpening,
    descriptor: ControlDescriptor,
  ): { value: string | number; title: string; disabled?: boolean }[] {
    if (!descriptor.options) return [];
    const v = evaluate(this.source.checker, asExpr(jsxAttribute(el, descriptor.options.prop)));
    if (!Array.isArray(v)) return [];
    const out: { value: string | number; title: string; disabled?: boolean }[] = [];
    for (const o of v) {
      if (!o || typeof o !== 'object') return [];
      const rec = o as Record<string, unknown>;
      const value = rec[descriptor.options.value];
      const title = rec[descriptor.options.title];
      if ((typeof value !== 'string' && typeof value !== 'number') || typeof title !== 'string') return [];
      out.push({ value, title, ...(rec.disabled === true ? { disabled: true } : {}) });
    }
    return out;
  }

  /**
   * A control's `hint`, and a text field's `placeholder`, when each is a
   * literal or a constant: the words the person reads beside the field. A
   * value only known at run time (a count, a prop) is left out, so the output
   * is the same on every build.
   */
  private fieldGuidance(el: JsxOpening, kind: AnyControlKind): { hint?: string; placeholder?: string } {
    const text = (prop: string): string | undefined => {
      const attr = jsxAttribute(el, prop);
      if (attr === undefined || attr === true) return undefined;
      const v = evaluate(this.source.checker, attr);
      return typeof v === 'string' && v.trim() ? v.trim() : undefined;
    };
    const hint = text('hint');
    const placeholder = kind === 'text' ? text('placeholder') : undefined;
    return { ...(hint ? { hint } : {}), ...(placeholder ? { placeholder } : {}) };
  }

  private schemaProps(el: JsxOpening, descriptor: ControlDescriptor, slotDefaults?: Readonly<SchemaProps>): SchemaProps {
    const props: Record<string, unknown> = { ...(descriptor.defaults ?? {}), ...(slotDefaults ?? {}) };
    for (const [key, prop] of Object.entries(descriptor.schemaProps ?? {})) {
      const attr = jsxAttribute(el, prop as string);
      if (attr === undefined) continue;
      const v = attr === true ? true : evaluate(this.source.checker, attr);
      if (v === UNKNOWN) continue;
      props[key] = v;
    }
    const options = this.options(el, descriptor);
    if (options.length) props.options = options;
    return props as SchemaProps;
  }

  /**
   * The object literals of an array prop: a literal, a constant, a
   * `useMemo(() => [...])`, a `.map`/`.flatMap` per row, or an array built with
   * `push` (in a loop, entries per row). What it cannot read — a prop passed
   * from elsewhere, a call, a push of something unknown — goes in `blind`, so
   * entries the PA would never see are reported rather than silently missing.
   */
  private arrayOf(expr: ts.Expression | undefined, blind: ts.Node[], depth = 0): ts.ObjectLiteralExpression[] {
    if (!expr) return [];
    if (depth > 4) {
      blind.push(expr);
      return [];
    }
    const e = unwrap(expr);
    if (ts.isArrayLiteralExpression(e)) {
      return e.elements.flatMap(el => this.arrayElement(el, blind, depth));
    }
    // `items.map(i => ({ …, agent }))` and `groups.flatMap(g => [...])`: entries made per row.
    if (
      ts.isCallExpression(e) &&
      ts.isPropertyAccessExpression(e.expression) &&
      ITERATORS.has(e.expression.name.text)
    ) {
      const fn = e.arguments[0] && unwrap(e.arguments[0]);
      if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
        const body = ts.isBlock(fn.body)
          ? fn.body.statements.find(ts.isReturnStatement)?.expression
          : fn.body;
        if (!body) return [];
        const inner = unwrap(body);
        const objects = ts.isObjectLiteralExpression(inner) ? [inner] : this.arrayOf(inner, blind, depth + 1);
        for (const o of objects) this.rowEntries.add(o);
        return objects;
      }
    }
    if (ts.isConditionalExpression(e))
      return [...this.arrayOf(e.whenTrue, blind, depth + 1), ...this.arrayOf(e.whenFalse, blind, depth + 1)];
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
      return this.arrayOf(e.right, blind, depth + 1);
    if (ts.isIdentifier(e)) {
      const symbol = this.source.checker.getSymbolAtLocation(e);
      const decl = symbol?.valueDeclaration;
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer && symbol) {
        return [...this.arrayOf(decl.initializer, blind, depth + 1), ...this.pushed(decl, symbol, blind, depth)];
      }
      blind.push(e);
      return [];
    }
    if (ts.isCallExpression(e) && /^(useMemo|useCallback)$/.test(e.expression.getText())) {
      const fn = e.arguments[0] && unwrap(e.arguments[0]);
      if (fn && ts.isArrowFunction(fn)) {
        if (!ts.isBlock(fn.body)) return this.arrayOf(fn.body, blind, depth + 1);
        const ret = fn.body.statements.find(ts.isReturnStatement);
        return this.arrayOf(ret?.expression, blind, depth + 1);
      }
    }
    blind.push(e);
    return [];
  }

  /** One element of an array literal, or of a `push`: an entry, or entries spread into it. */
  private arrayElement(el: ts.Expression, blind: ts.Node[], depth: number): ts.ObjectLiteralExpression[] {
    const x = unwrap(ts.isSpreadElement(el) ? el.expression : el);
    if (ts.isObjectLiteralExpression(x)) return [x];
    if (ts.isConditionalExpression(x))
      return [...this.arrayOf(x.whenTrue, blind, depth + 1), ...this.arrayOf(x.whenFalse, blind, depth + 1)];
    if (ts.isArrayLiteralExpression(x) || ts.isIdentifier(x) || ts.isCallExpression(x))
      return this.arrayOf(x, blind, depth + 1);
    // A divider or a separator string is not an entry; anything else is unread.
    if (!ts.isStringLiteral(x) && x.kind !== ts.SyntaxKind.NullKeyword && x.kind !== ts.SyntaxKind.FalseKeyword)
      blind.push(x);
    return [];
  }

  /**
   * The entries `push`ed onto an array declared in the same function: each
   * call `name.push(...)` whose receiver is this declaration. A push inside a
   * loop, or inside a callback such as `forEach`, makes entries per row.
   */
  private pushed(
    decl: ts.VariableDeclaration,
    symbol: ts.Symbol,
    blind: ts.Node[],
    depth: number,
  ): ts.ObjectLiteralExpression[] {
    const scope = enclosingScope(decl);
    if (!scope) return [];
    const out: ts.ObjectLiteralExpression[] = [];
    const visit = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === 'push' &&
        ts.isIdentifier(n.expression.expression) &&
        this.source.checker.getSymbolAtLocation(n.expression.expression) === symbol
      ) {
        const perRow = repeats(n, scope);
        for (const arg of n.arguments) {
          const objects = this.arrayElement(arg, blind, depth + 1);
          if (perRow) for (const o of objects) this.rowEntries.add(o);
          out.push(...objects);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(scope);
    return out;
  }

  // ─── Dialog openers ────────────────────────────────────────────────────────

  /**
   * Each dialog's openers: the bound controls whose callback — directly or
   * through a function of the same component — calls the setter of the state
   * the dialog's `open` reads, with something other than false or null; and
   * any control whose binding declares `effect: { kind: 'open', container }`.
   */
  private resolveOpeners(out: PageAnalysis): void {
    for (const dialog of out.dialogs) {
      const openers = new Set<string>();
      for (const c of out.controls) {
        const effect = c.binding.effect;
        if (
          effect &&
          typeof effect === 'object' &&
          effect.kind === 'open' &&
          dialog.binding &&
          effect.container === dialog.binding
        ) {
          openers.add(c.binding.id);
        }
      }
      if (dialog.setters?.length && dialog.owner) {
        const setters = new Set(dialog.setters);
        const localFns = openerFunctions(dialog.owner, setters);
        for (const c of out.controls) {
          if (c.reach.includes(dialog)) continue;
          if (c.callbacks.some(cb => cb.owner === dialog.owner && callsSetter(cb.expr, setters, localFns))) {
            openers.add(c.binding.id);
          }
        }
      }
      dialog.openedBy = [...openers].sort();
    }
  }

  /**
   * A destructive step runs only on the person's approval of that call
   * (ADR-0228), so the control that only opens the dialog where it is
   * confirmed must not be destructive too: the person would approve opening a
   * dialog, then approve the step itself. A control that does something of
   * its own before the dialog shows is approved for that, and is left alone.
   */
  private checkApprovedOnce(out: PageAnalysis): void {
    for (const dialog of out.dialogs) {
      const step = out.controls.find(c => c.binding.destructive && c.reach.includes(dialog));
      if (!step) continue;
      for (const opener of out.controls) {
        if (!opener.binding.destructive || !dialog.openedBy.includes(opener.binding.id) || opener.reach.includes(dialog)) continue;
        // A control that does something itself (rotates a key, then shows the new
        // one in a dialog) is approved for that; only one that just opens is not.
        const effect = opener.binding.effect;
        if (effect !== undefined && effectKind(effect) !== 'open') continue;
        out.errors.push({
          file: opener.declaredIn,
          line: opener.line,
          message:
            `"${opener.binding.id}" opens the "${dialog.title}" dialog, where "${step.binding.id}" is the destructive step: ` +
            `the person approves that one, so "${opener.binding.id}" is not destructive itself. Remove its \`destructive\``,
        });
      }
    }
  }
}

function asExpr(v: ts.Expression | true | undefined): ts.Expression | undefined {
  return v === true ? undefined : v;
}

/** The object literals an expression can be: through conditionals and `&&`. */
function objectsOf(expr: ts.Expression): ts.ObjectLiteralExpression[] {
  const e = unwrap(expr);
  if (ts.isObjectLiteralExpression(e)) return [e];
  if (ts.isConditionalExpression(e)) return [...objectsOf(e.whenTrue), ...objectsOf(e.whenFalse)];
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
    return objectsOf(e.right);
  return [];
}

/** The state a condition waits for: `x`, `!!x`, `x != null`, joined by `&&`. Comparisons with literals are tabs, not state. */
function gateIdentifiers(condition: ts.Expression): ts.Identifier[] {
  const e = unwrap(condition);
  if (ts.isIdentifier(e)) return [e];
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
    const inner = unwrap(e.operand);
    if (ts.isPrefixUnaryExpression(inner) && inner.operator === ts.SyntaxKind.ExclamationToken) {
      return gateIdentifiers(inner.operand);
    }
    return [];
  }
  if (ts.isBinaryExpression(e)) {
    if (e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return [...gateIdentifiers(e.left), ...gateIdentifiers(e.right)];
    }
    const notNull =
      (e.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken ||
        e.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) &&
      (e.right.kind === ts.SyntaxKind.NullKeyword || e.right.getText() === 'undefined');
    const left = unwrap(e.left);
    if (notNull && ts.isIdentifier(left)) return [left];
  }
  return [];
}

/** The first component (capitalized JSX tag) a branch renders. */
function firstComponentTag(node: ts.Node): string | null {
  let found: string | null = null;
  const visit = (n: ts.Node) => {
    if (found) return;
    if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && /^[A-Z]/.test(n.tagName.getText())) {
      found = n.tagName.getText();
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** `VoiceDetailPanel` → `Voice Detail Panel`. */
function words(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
}

function identifiers(expr: ts.Expression): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n))
      out.push(n.text);
    ts.forEachChild(n, visit);
  };
  visit(expr);
  return [...new Set(out)];
}

const CLOSING = new Set(['false', 'null', 'undefined']);

function callsSetter(node: ts.Node, setters: ReadonlySet<string>, localFns: ReadonlySet<string>): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText();
      const arg = n.arguments[0]?.getText();
      if (setters.has(callee) && arg !== undefined && !CLOSING.has(arg)) found = true;
      if (localFns.has(callee)) found = true;
    }
    if (ts.isIdentifier(n) && localFns.has(n.text)) found = true;
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** Functions declared in a component whose body opens the dialog: `const openCreate = () => setOpen(true)`. */
function openerFunctions(owner: ts.Node, setters: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const init = unwrap(n.initializer);
      const fn =
        ts.isArrowFunction(init) || ts.isFunctionExpression(init)
          ? init
          : ts.isCallExpression(init) && init.expression.getText() === 'useCallback'
            ? init.arguments[0]
            : undefined;
      if (fn && callsSetter(fn, setters, new Set())) out.add(n.name.text);
    }
    if (ts.isFunctionDeclaration(n) && n.name && n.body && callsSetter(n.body, setters, new Set()))
      out.add(n.name.text);
    ts.forEachChild(n, visit);
  };
  visit(owner);
  return out;
}

/** Literal routes a callback navigates to: `navigate('/voices/create')`. */
export function navigateTargets(nodes: readonly ts.Node[]): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && /(^|\.)navigate$/.test(n.expression.getText())) {
      const arg = n.arguments[0];
      if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) out.push(arg.text);
    }
    ts.forEachChild(n, visit);
  };
  nodes.forEach(visit);
  return [...new Set(out)];
}

/** The function or source file a declaration is in: where its pushes are. */
function enclosingScope(node: ts.Node): ts.Node | undefined {
  let n: ts.Node | undefined = node.parent;
  while (n && !ts.isFunctionLike(n) && !ts.isSourceFile(n)) n = n.parent;
  return n;
}

/** Whether a call runs once per row: inside a loop, or a callback, below `scope`. */
function repeats(node: ts.Node, scope: ts.Node): boolean {
  for (let n = node.parent; n && n !== scope; n = n.parent) {
    if (
      ts.isForStatement(n) ||
      ts.isForOfStatement(n) ||
      ts.isForInStatement(n) ||
      ts.isWhileStatement(n) ||
      ts.isDoStatement(n) ||
      ts.isArrowFunction(n) ||
      ts.isFunctionExpression(n)
    )
      return true;
  }
  return false;
}

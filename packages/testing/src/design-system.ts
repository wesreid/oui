/**
 * A tier 1 design system against the contract (ADR-0226 §2.2, §3.2): its
 * control table and declaration match the schemas, every entry registers with
 * the kind it declares, every export that takes a callback is accounted for,
 * and every binding's `run` returns what the consumer's callback returned.
 */
import { createElement, Fragment } from 'react';

import {
  agentDeclaration,
  controlKindRegistrationProblem,
  readControlTable,
  registerControlKind,
  type AnyControlKind,
  type ControlDescriptor,
  type ControlRegistration,
} from '@ouispec/bindings';
import { contractProblems } from '@ouispec/contract/validate';

import { exportedComponents, type SourceEntry } from './exports.js';
import {
  describeError,
  exampleContext,
  exampleRender,
  exampleValue,
  kitBindingId,
  mount,
  runRegistration,
  sameValue,
  type ControlExample,
  type Wrapper,
} from './harness.js';
import { ReportBuilder, type ConformanceReport } from './report.js';
import { sampleValue } from './sample.js';

export interface DesignSystemSpec {
  /** The package's name, as apps import it. */
  name: string;
  /** Its `package.json`: where it declares its control table (`oui.agentControls`, or `closure.agentControls` during the transition). */
  packageJson: Readonly<Record<string, unknown>>;
  /** Its control table, exactly as it ships (`agent-controls.json`, with `$kinds`). */
  table: unknown;
  /** The package's exports: its module namespace. */
  exports: Readonly<Record<string, unknown>>;
  /** An example of each table entry. */
  examples: Readonly<Record<string, ControlExample>>;
  /** Exports that are not controls, or are operated only by the person: export → why. */
  excluded?: Readonly<Record<string, string>>;
  /** Where its types are, to find every export that takes a callback. */
  source: SourceEntry;
  /** Providers its controls need around them. */
  wrapper?: Wrapper;
}

/** One thing a table entry binds: the control itself, one of its slots, or its entries. */
interface Part {
  name: string;
  kind: AnyControlKind;
  /** The consumer callbacks that running it calls; empty when it has none (its own state). */
  callbacks: readonly string[];
}

function partsOf(descriptor: ControlDescriptor): Part[] {
  const parts: Part[] = [];
  if (descriptor.kind && !descriptor.display) parts.push({ name: 'self', kind: descriptor.kind, callbacks: descriptor.callbacks });
  for (const [slot, d] of Object.entries(descriptor.slots ?? {})) {
    parts.push({ name: slot, kind: d.kind, callbacks: d.callback ? [d.callback] : [] });
  }
  if (descriptor.entries) parts.push({ name: 'entries', kind: descriptor.entries.kind, callbacks: [descriptor.entries.callback] });
  return parts;
}

/** The sentinel a consumer's callback returns, which `run` must hand back unchanged. */
const RESULT = { ok: true, data: { returnedBy: 'the consumer callback' } } as const;
const JOB_ID = 'oui-conformance-kit-job';
const JOB_RESULT = { ok: true, pending: { jobId: JOB_ID } } as const;

export async function checkDesignSystem(spec: DesignSystemSpec): Promise<ConformanceReport> {
  const out = new ReportBuilder(spec.name);

  // ─── The contract: what ships and what is declared ─────────────────────────
  const declared = agentDeclaration(spec.name, spec.packageJson, 'agentControls');
  out.check(
    'matches-contract',
    'package.json',
    declared.error ??
      (typeof declared.value === 'string' && declared.value.trim()
        ? null
        : 'declares no control table: its package.json needs "oui": { "agentControls": "<path to its control table>" }'),
  );
  const schemaProblems = contractProblems('control-table.json', spec.table);
  out.check('matches-contract', 'control table', schemaProblems.length ? schemaProblems.join('; ') : null);
  const { controls, kinds } = readControlTable(spec.table);
  for (const registration of kinds) {
    const problem = controlKindRegistrationProblem(registration);
    if (!out.check('matches-contract', `$kinds ${registration.kind}`, problem)) continue;
    try {
      registerControlKind(registration);
    } catch (err) {
      out.check('matches-contract', `$kinds ${registration.kind}`, describeError(err));
    }
  }

  const registered = new Set<string>(kinds.map(k => k.kind));
  for (const [name, descriptor] of Object.entries(controls)) {
    const unknown = partsOf(descriptor).filter(p => p.kind.startsWith('x-') && !registered.has(p.kind));
    out.check(
      'matches-contract',
      name,
      unknown.length ? `uses ${unknown.map(p => p.kind).join(', ')}, which the table's $kinds do not register` : null,
    );
  }

  // ─── Every export that takes a callback is accounted for ───────────────────
  const excluded = spec.excluded ?? {};
  const components = exportedComponents(spec.source);
  const exported = new Set(Object.keys(spec.exports));
  for (const component of components) {
    if (!component.callbacks.length) continue;
    const reason = excluded[component.name];
    out.check(
      'callbacks-accounted',
      component.name,
      component.name in controls || (typeof reason === 'string' && reason.trim())
        ? null
        : `takes ${component.callbacks.join(', ')} but is neither in the control table nor excluded with a reason`,
    );
  }
  for (const [name, reason] of Object.entries(excluded)) {
    out.check(
      'callbacks-accounted',
      name,
      !exported.has(name)
        ? 'is excluded but the package does not export it'
        : name in controls
          ? 'is both in the control table and excluded'
          : !reason.trim()
            ? 'is excluded without a reason'
            : null,
    );
  }
  for (const name of Object.keys(controls)) {
    out.check('callbacks-accounted', name, exported.has(name) ? null : 'is in the control table but the package does not export it');
  }

  // ─── Each entry registers its kind, and returns its callback's result ──────
  for (const [name, descriptor] of Object.entries(controls)) {
    await checkEntry(spec, name, descriptor, out);
  }
  return out.report();
}

async function checkEntry(spec: DesignSystemSpec, name: string, descriptor: ControlDescriptor, out: ReportBuilder): Promise<void> {
  const parts = partsOf(descriptor);
  if (!parts.length && !descriptor.display) return;
  const example = spec.examples[name];
  if (!example) {
    out.check('registers-declared-kind', name, 'has no example, so the kit cannot mount it: add one to `examples`');
    return;
  }
  const slots = Object.keys(descriptor.slots ?? {});

  // Mount every state once, and find what each part registered.
  const mountAll = async (plan: unknown) => {
    const run = exampleContext(name, slots);
    run.plan(plan);
    const elements = exampleRender(example)(run.ctx);
    const states = Array.isArray(elements) ? elements : [elements];
    const mounted = [];
    for (const state of states) mounted.push(await mount(createElement(Fragment, null, state), spec.wrapper));
    return { run, mounted };
  };

  let first;
  try {
    first = await mountAll(undefined);
  } catch (err) {
    out.check('registers-declared-kind', name, `its example failed to mount: ${describeError(err)}`);
    return;
  }
  try {
    if (descriptor.display) {
      const id = kitBindingId(name, 'self');
      const shown = first.mounted.some(m => m.registry.facts().some(f => f.id === id));
      out.check('registers-declared-kind', name, shown ? null : `is a display, and did not report its facts under its binding (${id})`);
    }
    for (const part of parts) {
      const id = kitBindingId(name, part.name);
      const regs = first.mounted.flatMap(m => m.registry.controls().filter(c => c.id === id));
      const subject = part.name === 'self' ? name : `${name} ${part.name}`;
      if (!regs.length) {
        out.check('registers-declared-kind', subject, `did not register its binding (${id}): the example must render it with \`agent\``);
        continue;
      }
      const wrong = regs.find(r => r.kind !== part.kind);
      out.check('registers-declared-kind', subject, wrong ? `registers as "${wrong.kind}", but its table entry declares "${part.kind}"` : null);
    }
  } finally {
    for (const m of first.mounted) await m.unmount();
  }

  // Running each part that calls a consumer callback returns that callback's result, a job's too.
  for (const part of parts) {
    if (!part.callbacks.length) continue;
    const subject = part.name === 'self' ? name : `${name} ${part.name}`;
    for (const [plan, what] of [
      [RESULT, 'result'],
      [JOB_RESULT, 'job'],
    ] as const) {
      const { run, mounted } = await mountAll(plan);
      try {
        const id = kitBindingId(name, part.name);
        const reg = mounted.flatMap(m => m.registry.controls().filter(c => c.id === id))[0];
        if (!reg) break; // reported above
        const problem = await runPart(reg, part, example, run.calls, plan, what);
        out.check('run-returns-result', `${subject} (${what})`, problem);
        if (problem) break;
      } finally {
        for (const m of mounted) await m.unmount();
      }
    }
  }
}

async function runPart(
  reg: ControlRegistration,
  part: Part,
  example: ControlExample,
  calls: Map<string, unknown[][]>,
  plan: unknown,
  what: 'result' | 'job',
): Promise<string | null> {
  if (reg.disabled) return 'registered as disabled: the example must render it usable';
  const given = exampleValue(example, part.name);
  const value = given.given ? given.value : reg.valueSchema ? sampleValue(reg.valueSchema, reg.value) : undefined;
  if (reg.valueSchema && value === undefined) {
    return `the kit cannot make a value its schema accepts (${JSON.stringify(reg.valueSchema)}): give one in the example's \`values\``;
  }
  calls.clear();
  let result;
  try {
    result = await runRegistration(reg, value);
  } catch (err) {
    return `run threw: ${describeError(err)}`;
  }
  const called = part.callbacks.filter(cb => calls.has(cb));
  if (!called.length) {
    return `running it did not call ${part.callbacks.join(' or ')}${result.ok ? '' : ` (it answered ${result.code}: ${result.message})`}`;
  }
  if (!sameValue(result, plan)) {
    return what === 'job'
      ? `its ${called[0]} returned { ok: true, pending: { jobId } }, but run returned ${JSON.stringify(result)}: a job control must report pending.jobId`
      : `its ${called[0]} returned ${JSON.stringify(plan)}, but run returned ${JSON.stringify(result)}`;
  }
  return null;
}

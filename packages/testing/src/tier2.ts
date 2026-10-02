/**
 * Tier 2 against its mapping (ADR-0226 §2.3, §3.2, the fifth rule): each
 * generated wrapper registers the mapped kind, hands the app's callback the
 * value where `valueFrom` says the third-party component puts it, and returns
 * that callback's result; and every use of a mapped control that does not
 * pass its `controlled` prop is reported by the generator.
 */
import { createElement, Fragment } from 'react';

import type { Tier2Mapping } from '@ouispec/bindings';
import { contractProblems } from '@ouispec/contract/validate';

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

/** One use of a mapped control in the app's source, as the generator found it. */
export interface Tier2Use {
  /** The mapped export (`Select`). */
  component: string;
  /** The file, relative to the app. */
  file: string;
  line: number;
  /** The props the use passes. */
  props: readonly string[];
}

export interface Tier2Spec {
  /** The mapping file's contents. */
  mapping: unknown;
  /** The bound module's exports: one wrapper per mapped control, by its export name. */
  wrappers: Readonly<Record<string, unknown>>;
  /** An example of each wrapper, used as an app uses it (its callback named as the mapping's first). */
  examples: Readonly<Record<string, ControlExample>>;
  /** Every use of a mapped control in the app, as the generator found them. */
  uses?: readonly Tier2Use[];
  /** The uses the generator reported as uncontrolled. */
  reported?: readonly Tier2Use[];
  wrapper?: Wrapper;
}

const RESULT = { ok: true, data: { returnedBy: 'the app callback' } } as const;

/** The value at `path` (dotted) inside `arg`. */
function at(arg: unknown, path: string | undefined): unknown {
  if (!path) return arg;
  let node = arg;
  for (const key of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

export async function checkTier2(spec: Tier2Spec): Promise<ConformanceReport> {
  const problems = contractProblems('tier2-mapping.json', spec.mapping);
  const pkg = (spec.mapping as { package?: unknown } | null)?.package;
  const out = new ReportBuilder(`the tier 2 mapping of ${typeof pkg === 'string' ? pkg : 'an unnamed package'}`);
  if (!out.check('matches-contract', 'mapping', problems.length ? problems.join('; ') : null)) return out.report();
  const mapping = spec.mapping as Tier2Mapping;

  for (const [name, control] of Object.entries(mapping.controls)) {
    const subject = `${name} wrapper`;
    if (typeof spec.wrappers[name] !== 'function' && typeof spec.wrappers[name] !== 'object') {
      out.check('tier2-forwards-value', subject, 'the bound module exports no wrapper for it');
      continue;
    }
    const example = spec.examples[name];
    if (!example) {
      out.check('tier2-forwards-value', subject, 'has no example, so the kit cannot mount it: add one to `examples`');
      continue;
    }
    const callback = control.callbacks[0];
    const run = exampleContext(name, []);
    run.plan(RESULT);
    let mounted;
    try {
      const elements = exampleRender(example)(run.ctx);
      mounted = await mount(createElement(Fragment, null, ...(Array.isArray(elements) ? elements : [elements])), spec.wrapper);
    } catch (err) {
      out.check('tier2-forwards-value', subject, `its example failed to mount: ${describeError(err)}`);
      continue;
    }
    try {
      const id = kitBindingId(name, 'self');
      const reg = mounted.registry.controls().find(c => c.id === id);
      if (!reg) {
        out.check('registers-declared-kind', subject, `did not register its binding (${id}): a wrapper calls useAgentBinding with \`agent\``);
        continue;
      }
      out.check('registers-declared-kind', subject, reg.kind === control.kind ? null : `registers as "${reg.kind}", but the mapping declares "${control.kind}"`);

      const given = exampleValue(example, 'self');
      const value = given.given ? given.value : reg.valueSchema ? sampleValue(reg.valueSchema, reg.value) : undefined;
      run.calls.clear();
      const result = await runRegistration(reg, value);
      const calls = run.calls.get(callback) ?? [];
      if (!calls.length) {
        out.check('tier2-forwards-value', subject, `running it did not call the app's ${callback}${result.ok ? '' : ` (${result.code}: ${result.message})`}`);
        continue;
      }
      if (control.valueFrom) {
        const passed = at(calls[0][control.valueFrom.arg], control.valueFrom.path);
        const where = `argument ${control.valueFrom.arg}${control.valueFrom.path ? `.${control.valueFrom.path}` : ''}`;
        out.check(
          'tier2-forwards-value',
          subject,
          sameValue(passed, value)
            ? null
            : `set to ${JSON.stringify(value)}, it called ${callback} with ${JSON.stringify(passed)} at ${where}, where the mapping says the value is`,
        );
      }
      out.check(
        'run-returns-result',
        subject,
        sameValue(result, RESULT) ? null : `its ${callback} returned ${JSON.stringify(RESULT)}, but run returned ${JSON.stringify(result)}`,
      );
    } finally {
      await mounted.unmount();
    }
  }

  // Every uncontrolled use is reported, so the app learns its control would not show the value.
  const reported = new Set((spec.reported ?? []).map(u => `${u.component}@${u.file}:${u.line}`));
  for (const use of spec.uses ?? []) {
    const controlled = mapping.controls[use.component]?.controlled;
    if (!controlled || use.props.includes(controlled)) continue;
    out.check(
      'tier2-reports-uncontrolled',
      `${use.component} at ${use.file}:${use.line}`,
      reported.has(`${use.component}@${use.file}:${use.line}`)
        ? null
        : `does not pass ${controlled}, so the control would not show a value the assistant sets, and the generator did not report it`,
    );
  }
  return out.report();
}

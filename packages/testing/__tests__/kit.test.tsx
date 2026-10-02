/**
 * The conformance kit's acceptance (ADR-0226 §3.2, W3): a design system, an
 * app and a tier 2 mapping written to the contract pass every rule, and the
 * deliberately broken fixtures fail each rule exactly once.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkApp, checkDesignSystem, checkTier2, CONFORMANCE_RULES, formatReport, type ConformanceReport, type ConformanceRule } from '../src/index';
import { TABLE as BROKEN_TABLE } from './fixtures/broken-ds/agent-controls';
import * as broken from './fixtures/broken-ds/index';
import { BROKEN_EXAMPLES, EXCLUDED, GOOD_EXAMPLES } from './fixtures/examples';
import { OrdersPage } from './fixtures/app/src/OrdersPage';
import { PACKAGE_JSON, TABLE } from './fixtures/good-ds/agent-controls';
import * as good from './fixtures/good-ds/index';
import * as bound from './fixtures/tier2/bound';
import MAPPING from './fixtures/tier2/mapping.json';
import { FIXTURES, fixtureManifest } from './support/app-manifest';

const goodSpec = {
  name: '@kit/ds',
  packageJson: PACKAGE_JSON,
  table: TABLE,
  exports: good,
  examples: GOOD_EXAMPLES,
  excluded: EXCLUDED,
  source: { tsconfig: join(FIXTURES, 'good-ds/tsconfig.json'), entry: join(FIXTURES, 'good-ds/index.tsx') },
};

const brokenSpec = {
  ...goodSpec,
  table: BROKEN_TABLE,
  exports: broken,
  examples: BROKEN_EXAMPLES,
  source: { tsconfig: join(FIXTURES, 'broken-ds/tsconfig.json'), entry: join(FIXTURES, 'broken-ds/index.tsx') },
};

const PAGES = {
  // Two states: the cancel button shows only with an open order.
  'page:OrdersPage': [<OrdersPage key="none" />, <OrdersPage key="open" order={{ id: 'o-1' }} />],
};

const USES = [
  { component: 'ThirdSelect', file: 'src/Screener.tsx', line: 12, props: ['label', 'data', 'value', 'onChange', 'agent'] },
  { component: 'ThirdSelect', file: 'src/Screener.tsx', line: 20, props: ['label', 'data', 'onChange', 'agent'] },
  { component: 'ThirdButton', file: 'src/Screener.tsx', line: 24, props: ['onClick', 'agent'] },
];
const TIER2_EXAMPLES = {
  ThirdSelect: ({ agent, on }: { agent: () => never; on: (c: string) => never }) => (
    <bound.ThirdSelect label="Market" value="us" data={[{ value: 'us', label: 'US' }, { value: 'eu', label: 'EU' }]} agent={agent()} onChange={on('onChange')} />
  ),
  ThirdButton: ({ agent, on }: { agent: () => never; on: (c: string) => never }) => (
    <bound.ThirdButton agent={agent()} onClick={on('onClick')}>
      Screen
    </bound.ThirdButton>
  ),
};

const byRule = (report: ConformanceReport) => {
  const counts: Partial<Record<ConformanceRule, number>> = {};
  for (const v of report.violations) counts[v.rule] = (counts[v.rule] ?? 0) + 1;
  return counts;
};

describe('a design system, an app and a mapping written to the contract pass every rule', () => {
  it('the design system: its table, its kinds, its exports and its results', async () => {
    const report = await checkDesignSystem(goodSpec);
    expect(report.violations, formatReport(report)).toEqual([]);
    // Every design-system rule ran, over every entry.
    expect(report.checked['matches-contract']).toBeGreaterThanOrEqual(2);
    expect(report.checked['registers-declared-kind']).toBe(7); // Button, Choice, PriceRange, Facts, and OrderCard's open, cancel and entries
    expect(report.checked['callbacks-accounted']).toBeGreaterThan(0);
    expect(report.checked['run-returns-result']).toBe(12); // six callback parts × a result and a job
  });

  it('the app: every action its generated manifest declares has a mounted handler', async () => {
    const report = await checkApp({ name: 'the fixture app', manifest: await fixtureManifest(), pages: PAGES });
    expect(report.violations, formatReport(report)).toEqual([]);
    expect(report.checked['actions-mounted']).toBe(3);
  });

  it('the mapping: its wrappers forward the value where valueFrom says, and every uncontrolled use is reported', async () => {
    const report = await checkTier2({
      mapping: MAPPING,
      wrappers: bound,
      examples: TIER2_EXAMPLES as never,
      uses: USES,
      reported: [USES[1]],
    });
    expect(report.violations, formatReport(report)).toEqual([]);
    expect(report.checked['tier2-forwards-value']).toBe(1);
    expect(report.checked['tier2-reports-uncontrolled']).toBe(1);
  });
});

describe('the broken fixtures fail each rule once', () => {
  it('the design system fails matches-contract, registers-declared-kind, callbacks-accounted and run-returns-result once each', async () => {
    const report = await checkDesignSystem(brokenSpec);
    expect(byRule(report), formatReport(report)).toEqual({
      'matches-contract': 1,
      'registers-declared-kind': 1,
      'callbacks-accounted': 1,
      'run-returns-result': 1,
    });
    expect(report.violations.map(v => [v.rule, v.subject])).toEqual([
      ['matches-contract', 'control table'],
      ['callbacks-accounted', 'Slider'],
      ['registers-declared-kind', 'Toggle'],
      ['run-returns-result', 'SaveButton (result)'],
    ]);
    expect(report.violations[0].message).toBe('/Choice has "placeholder", which the contract does not define');
    expect(report.violations[1].message).toBe('takes onChange but is neither in the control table nor excluded with a reason');
    expect(report.violations[2].message).toBe('registers as "button", but its table entry declares "toggle"');
    expect(report.violations[3].message).toMatch(/^its onSave returned \{"ok":true,"data":\{"returnedBy":"the consumer callback"\}\}, but run returned \{"ok":true\}$/);
  });

  it('the broken mapping fails tier2-forwards-value and tier2-reports-uncontrolled once each', async () => {
    const report = await checkTier2({
      mapping: MAPPING,
      wrappers: { ...bound, ThirdSelect: bound.BrokenThirdSelect },
      examples: {
        ...TIER2_EXAMPLES,
        ThirdSelect: (({ agent, on }: { agent: () => never; on: (c: string) => never }) => (
          <bound.BrokenThirdSelect label="Market" value="us" data={[{ value: 'us', label: 'US' }, { value: 'eu', label: 'EU' }]} agent={agent()} onChange={on('onChange')} />
        )) as never,
      } as never,
      uses: USES,
      reported: [],
    });
    expect(byRule(report), formatReport(report)).toEqual({ 'tier2-forwards-value': 1, 'tier2-reports-uncontrolled': 1 });
    expect(report.violations.map(v => v.message)).toEqual([
      'set to "eu", it called onChange with undefined at argument 1, where the mapping says the value is',
      'does not pass value, so the control would not show a value the assistant sets, and the generator did not report it',
    ]);
  });

  it('the integrator guide documents every rule', () => {
    const guide = readFileSync(createRequire(import.meta.url).resolve('@ouispec/contract/INTEGRATOR-GUIDE.md'), 'utf8');
    for (const rule of Object.keys(CONFORMANCE_RULES)) expect(guide).toContain(`| \`${rule}\` |`);
  });

  it('covers every rule the kit has', () => {
    expect(Object.keys(CONFORMANCE_RULES)).toEqual([
      'matches-contract',
      'registers-declared-kind',
      'callbacks-accounted',
      'run-returns-result',
      'actions-mounted',
      'tier2-forwards-value',
      'tier2-reports-uncontrolled',
    ]);
  });
});

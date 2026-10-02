## The conformance kit

`@ouispec/testing` runs in your own test runner, in any DOM environment (jsdom, happy-dom, a browser), and reports against these schemas (ADR-0226 §3.2). Each check returns a report; `assertConformant(report)` throws with every violation listed, under its rule.

| Rule | What it holds |
|---|---|
| `matches-contract` | What the package ships and declares matches the schemas: its control table and `$kinds`, its `oui.agentControls` declaration, a manifest, a mapping. |
| `registers-declared-kind` | Every table entry registers at runtime with the kind it declares. |
| `callbacks-accounted` | Every export that takes a callback is in the table, or excluded with a reason. |
| `run-returns-result` | Every binding's `run` returns its callback's result, and a job control reports `pending.jobId`. |
| `actions-mounted` | Every generated manifest action has a mounted handler on the page that offers it. |
| `tier2-forwards-value` | Every tier 2 wrapper forwards `valueFrom` correctly. |
| `tier2-reports-uncontrolled` | Every use of a mapped control that does not pass its `controlled` prop is reported. |

### A design system

```tsx
import { assertConformant, checkDesignSystem, readShippedPackage } from '@ouispec/testing';
import * as ui from '../src';

it('passes the OUI conformance kit', async () => {
  assertConformant(
    await checkDesignSystem({
      ...readShippedPackage(packageDir),           // package.json and the table it declares, as built
      exports: ui,
      source: { tsconfig: 'tsconfig.json', entry: 'src/index.ts' }, // finds every export that takes a callback
      excluded: { Avatar: 'display' },             // exports that are not controls, each with why
      wrapper: ThemeProvider,
      examples: {
        Button: ({ agent, on }) => <Button agent={agent()} onClick={on('onClick')}>Save</Button>,
        Card: ({ slots, agent, on }) => (
          <Card agent={slots()} onOpen={on('onOpen')} menuItems={[{ label: 'Rename', onClick: on('onClick'), agent: agent('entries') }]} />
        ),
      },
    }),
  );
});
```

Each example renders a control the way a page uses it, with the kit's bindings (`agent()`, `agent('<slot>')`, `agent('entries')`, `slots()`) and callbacks (`on('<callback as the table names it>')`). Return several elements when parts only show in some state (a dialog open, a row present). The kit runs every part with a value its live schema accepts, and requires the named callback to be called and its result — and, in a second run, `{ ok: true, pending: { jobId } }` — to come back from `run` unchanged.

### An app

`checkApp({ name, manifest, pages })` mounts each surface's page (several states if needed) and requires a handler for every action the generated manifest declares on it.

### A tier 2 mapping

`checkTier2({ mapping, wrappers, examples, uses, reported })` mounts each bound wrapper, runs it, and requires the app's callback to receive the value where `valueFrom` says, and its result back from `run`; and it requires every use the generator found without the `controlled` prop to be among those it reported. The generator returns both lists, so the kit is fed what the build found:

```ts
const result = await generate(loadConfig('oui.config.json'));
assertConformant(await checkTier2({
  mapping, wrappers: await import('./src/agent/generated/bound/mantine-core'), examples,
  uses: result.tier2.uses, reported: result.tier2.uncontrolled, wrapper: MantineProvider,
}));
```

A compound control's wrapper is its namespace (`Select`), and its example renders the root and its items.

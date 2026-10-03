## The conformance kit

`@ouispec/testing` runs in your own test runner, in any DOM environment (jsdom, happy-dom, a browser), and reports against these schemas (ADR-0226 §3.2). Each check returns a report; `assertConformant(report)` throws with every violation listed, under its rule.

| Rule | What it holds |
|---|---|
| `matches-contract` | What the package ships and declares matches the schemas: its control table and `$kinds`, its `oui.agentControls` declaration, a manifest, a mapping. |
| `registers-declared-kind` | Every table entry registers at runtime with the kind it declares. |
| `callbacks-accounted` | Every export that takes a callback is in the table, or excluded with a reason. |
| `run-returns-result` | Every binding's `run` returns its callback's result, and a job control reports `pending.jobId`. |
| `actions-mounted` | Every generated manifest action has a mounted handler on the page that offers it. |
| `lists-readable` | Every list a room reports is declared with how its rows are addressed, and its `query` and `inspect` return what the room holds. |
| `within-budgets` | Every action's index entry and definition, and every surface's index, is within the size the assistant's transport carries. |
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

### A room

```ts
it('lets the assistant read what the room holds', async () => {
  const room = mountLedgerWithPositions();
  assertConformant(
    await checkRoom({
      name: '@acme/ledger',
      catalog: catalogData(ledgerCatalog),
      run: (id, input) => room.controller.run(id, input),
      observations: { ledger: room.observation() },
    }),
  );
});
```

The room is checked holding something to read: the kit queries every declared list, compares it row for row with what the room reports, and inspects a row of each.

### Sizes

`oui generate` fails a build that offers the assistant more than its transport carries, naming the action or surface:

| Budget | Limit |
|---|---|
| One action's index entry | 512 bytes |
| One action's definition | 256 KB |
| One surface's index | 128 KB |

`checkBudgets({ name, manifest, budgets })` runs the same check in your own tests, against your own limits when your transport carries less:

```ts
assertConformant(checkBudgets({ name: 'desk', manifest, budgets: { surfaceIndexBytes: 64 * 1024 } }));
```

An action over its definition budget usually inlines a catalogue. Split the action, or expose the catalogue as a reader (`query`) the assistant asks.

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

## Tier 3: rooms

A room is an editor with its own editing model — a canvas, a chart, a timeline, a player — whose operations are not one control each. It publishes a typed catalog of everything a person can do in it, declared where the room implements it (ADR-0220 §2.3):

- **actions**: its operations, each run through the room's own reducer and commands, with a JSON Schema for the input (one object schema, never a union at the top);
- **fields**: its inspector's fields, from the same definitions the inspector renders, each with its value's schema, its unit and range, what it applies to, and — only in a room with a timeline — its `animation`;
- **commands**: its keymap;
- **observations**: what the host reports about the room's state, including a `problems` list in the room's own vocabulary;
- **recipes**: tasks only the room knows, built from its own tools.

Derive each action's input from the schema the reducer already validates with (`z.toJSONSchema`), and check the input with the same schema before applying it. A room with fields also declares a `set-properties` action and a room with available commands a `run-command` action; the generator builds their inputs from the rest of the catalog.

### Worked example

```ts
import type { RoomCatalog } from '@ouispec/bindings';

export const ledgerCatalog: RoomCatalog<LedgerRuntime> = {
  room: 'ledger',
  title: 'Ledger',
  description: 'The account’s positions and orders.',
  actions: [
    {
      kind: 'action',
      id: 'close-position',
      title: 'Close position',
      description: 'Sells the whole position at market.',
      control: 'The Close button on a position',
      input: { type: 'object', properties: { id: { type: 'string', description: 'The position' } }, required: ['id'] },
      effect: { kind: 'transaction', operation: 'closePosition' },
      run: (ctx, { id }) => ctx.close(id),
    },
  ],
  fields: [],
  commands: [],
  observations: [{ id: 'positions', description: 'The open positions', schema: { type: 'array' } }],
  problems: [{ kind: 'order-rejected', description: 'The broker refused the order' }],
  recipes: [{ name: 'Flatten the book', trigger: 'When asked to close everything', steps: ['Close each position with {action:close-position}.'] }],
};
```

The room registers itself while it is mounted, and pushes its observations and problems as they change:

```tsx
useRoomRegistration(catalogData(ledgerCatalog), {
  run: (id, input) => controller.run(id, input),
  observations: { positions },
  problems,
});
```

A room package ships `catalogData(catalog)` as `agent-catalog.json` and names it, with the components that mount the room:

```json
{ "oui": { "agentCatalog": { "path": "./dist/agent-catalog.json", "hosts": ["Ledger"] } } }
```

A catalog in the app itself is listed in `oui.config.json` under `appCatalogs`; the generator loads it through the app's own Vite config, so the app needs `vite` among its own dependencies.

<!-- schema: room-catalog-data.json -->

<!-- schema: room-catalog-data.json#/$defs/RoomActionData -->

<!-- schema: room-catalog-data.json#/$defs/RoomFieldData -->

<!-- schema: room-catalog-data.json#/$defs/RoomRecipe -->

### Lists, and reading them

A room that holds things its actions address — a document's layers, a ledger's positions — declares each list once, and everything that reads it is built from that declaration:

```ts
const POSITIONS: RoomList<LedgerContext> = {
  id: 'ledger/positions',                              // <observation id>/<list property>
  title: 'Positions',
  rows: { ref: 'id', title: 'symbol', index: ['side'], selection: 'selection' },
  list: ctx => ctx.positions().map(row),               // each row as the observation reports it
  detail: (ctx, id) => everythingAbout(ctx, id),       // all its panels show
};

const catalog: RoomCatalog<LedgerContext> = {
  …,
  actions: [...actions, ...roomReaders({ title: 'Ledger' }, [POSITIONS])],
  observations: [{ id: 'ledger', description: '…', schema: { type: 'object', properties: {
    selection: { type: 'array', items: { type: 'string' } },
    positions: { type: 'array', 'x-rows': POSITIONS.rows, items: { type: 'object', properties: { id: …, symbol: …, side: … } } },
  } } }],
};
```

- **`x-rows`** on the list in the observation's schema says how a row is addressed (`ref`), what a person calls it (`title`), and what an index row keeps. A list too long for the page state is cut to index rows, never to a count; the selected rows, and the rows an action just changed, stay whole.
- **`roomReaders`** makes the room's `inspect` (everything about the rows named) and `query` (a list's rows, narrowed by an indexed property or by name, a page at a time). Both only read.
- **`x-ref`** on an input that takes a row (`{ type: 'string', ...refTo(POSITIONS) }`) names the list it addresses. The runtime then takes a row's exact name where its id is expected, when one row has it, and refuses an ambiguous one with the ids it could mean.
- **`changed`** on an action's result reports the rows it changed, added or removed, each as `inspect` would return it now (`changedRows(lists, ctx, refs)`), so the assistant checks an edit against what the room holds, not against what it meant to do.

The generator refuses a catalog whose observation lists things with an `id` and no `x-rows`, a list without its readers, and an `x-ref` to a list the room does not declare.

<!-- schema: json-schema.json#/$defs/RowList -->

<!-- schema: room-catalog-data.json#/$defs/RoomChangedRow -->

### What a number is measured in

`x-unit` names a number's unit (`px`, `%`, `°`, `s`); `x-space` names the frame a length, a point or a fraction is measured in, in the room's own words (`artboard`, `canvas`, `artboard-fraction`). A value that moves something else when it changes says so in its description: an assistant sets a value it has not seen explained by guessing, and a guess about a frame of reference is how a layer leaves the page.

Every input, value and observation schema, here and in tier 1, is written in the same subset of JSON Schema, which is what assistant tool inputs are written in; `x-unit` names a number's unit, `x-space` the frame it is measured in, and `x-rows` and `x-ref` the lists of addressable rows and the inputs that address them.

<!-- schema: json-schema.json -->

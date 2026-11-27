# @ouispec/bindings

## 0.21.0

### Patch Changes

- Updated dependencies
  - @ouispec/contract@0.21.0
  - @ouispec/agent-events@0.44.0

## 0.20.0

### Patch Changes

- Updated dependencies
  - @ouispec/contract@0.20.0
  - @ouispec/agent-events@0.42.0

## 0.19.0

### Patch Changes

- A page may say what it is for to the assistant only, apart from its visible copy: the `@agentDescription` tag of its component's doc comment. Declared, it is the page's description in place of its header's subtitle or what it offers: its surface's description in the manifest, its knowledge's summary and detail, and its line on the app's map, which carries its first sentence as `says` (a new optional field of the map's page line) and says it before what the page offers. It is held to a subtitle's rule (three words or more, not a loading state), and one that breaks it fails the generation, naming where it is written. Under route gates it goes only where its page goes: a session that may not see the page is never told it, an open page's `says` loses a sentence that names a page the session may not see, and a page's summary or detail all of whose sentences name such pages is said by the page's name and open routes instead of as it was. A page that declares none is described exactly as before (the fixture apps' golden manifest and knowledge are unchanged). The integrator guide says how.
- Updated dependencies
  - @ouispec/contract@0.19.0
  - @ouispec/agent-events@0.40.0

## 0.18.0

### Minor Changes

- One build can serve several brands or audiences, and the assistant is told of the app only as the session's person sees it.

  - cli: `routeGates` in `oui.config.json` names the route wrappers that open their page only to some sessions, each with the prop whose value names the gate (`{ "FeatureRoute": "feature" }`); each must also be in `routeWrappers`. Every route records the gates its element and its parent routes' elements are wrapped in, outermost first, read at build time from a literal or a constant (`FEATURE_KEYS.campaigns`). A gate the build cannot read, or a gating wrapper without the prop, fails the build as an unreadable path does. On the app's map a page goes under another only when that page is open whenever it is. A config that names no gates generates exactly what it did before, byte for byte (the fixture apps' output of 0.17.1 is held in `__tests__/fixtures/golden/`).
  - contract: a page's manifest surface and knowledge carry `gates` (`RouteGates`: route → its gates), and the knowledge carries the app's map line by line (`map`, `AppMapLine`) when any route is gated. `overview.content` is still the whole map. `oui-config.json` gains `routeGates`.
  - bindings: the host says which gates the session may see with `allows: (gate) => boolean`. `connectBindings({ knowledge, allows })` then offers `app.navigate` only the open pages and answers `oui.find` and `oui.guide` only of them; `createKnowledgeLookup({ allows })` does the same on its own, and `resolveKnowledge(knowledge, path, { allows })` gives the map without the other pages, and no page's knowledge on a page the session may not see. A route is open when every one of its gates is allowed, and a page when any of its routes is. A page the session may not see is named nowhere the assistant reads: not in a surface's, an action's or an observation's description (a shared part's "on /, /war-room" keeps only its open routes, and "It goes to /war-room." is left out), not in the navigation action, not in a page's entries, relationships or recipes (a sentence that names it by its route or an address on it is left out, a route list loses it, a heading whose items all went goes too), not in the map or its frame lines, and not in `oui.find` or `oui.guide`. A control that only goes to such a page is not offered (it leads nowhere for the session), and a route step to such a page leaves an action's reach. `scopeKnowledge`, `scopeManifest`, `scopedNavigationSurface`, `scopeText`, `routeScope`, `appMapContent`, `routeOpen`, `openRoutes`, `buildGates`, `openPageForPath` and `pageRouteForPath` are exported. Without `allows`, or for a build with no gates, nothing changes.

### Patch Changes

- One record drawn twice on a page (the same row key in two places, a vehicle on a lead's card and again in the list) is one row. A row action's `item` enum names it once and its count says how many rows there are, so a provider compiles the schema (on Nova, an enum that repeated a key had every call to the action refused). The page state lists it once, as first drawn; a title names it once, so it is not "several rows"; and a call runs through a drawing that can be used when one can. `uniqueRows` is exported.
- Updated dependencies
  - @ouispec/contract@0.18.0
  - @ouispec/agent-events@0.39.0

## 0.17.2

### Patch Changes

- Depends on the current `@ouispec/contract`, which adds the eval expectation `history`. Nothing else changes.
- Updated dependencies
  - @ouispec/contract@0.17.2

## 0.17.1

### Patch Changes

- Depends on the current `@ouispec/contract`, which adds the eval expectation `whileWorking`. Nothing else changes.
- Updated dependencies
- Updated dependencies
  - @ouispec/agent-events@0.37.0
  - @ouispec/contract@0.17.1

## 0.17.0

### Minor Changes

- The start a surface's action ids share is declared from its whole catalog, and a folded name never runs another action.

  - oui-spec: `OUISurface.idPrefix` and `OUISurfaceIndex.idPrefix` (§7.3.8). This is the start every action id of the surface's whole catalog shares; an empty string declares there is none. `sharedIdPrefix(ids)` computes it in whole `_` words, from at least three ids, with each id keeping a word of its own.
  - bindings: every surface the bindings mount declares `idPrefix` from the build's manifest surface, not from the controls shown now. So the names an agent's index gives stay the same between turns as sections open and close. Re-exports `sharedIdPrefix`.
  - agent-worker: a declared start is folded whenever every action offered starts with it, so a name never moves. Without one, the start is taken from what is offered, as in 0.35. Fix: a surface is not folded on a page where a name it would give is another action's full id. On /audio/compose, the Song room's `song_voice_track` would have been listed as `voice_track`, the page's own action, and a call by that name ran the page's. `foldedPrefixes(page)` is the one folding that `indexText` and `resolveActionName` share.
  - cli: `oui generate` warns of each surface that can't be folded on a route because one of its folded names is another action's id there, naming both.

### Patch Changes

- Updated dependencies
  - oui-spec@0.16.0
  - @ouispec/agent-events@0.36.0

## 0.16.0

### Minor Changes

- Room action families. `roomActionFamily` gathers a room's near-identical actions (an effect's add, set, switch and move) into one action whose input names the member by `op`. Each member still runs through its own `run`, with its input checked against its own schema first. The family's `op` lists its members a line each, "op = Title: what it does", the form run-command lists its commands in. The family is refused when the catalog is built if the members cannot be one action: fewer than two, a destructive member (a removal stays its own action, approved as one), effects that differ, or a property two members take with different schemas. The app-wide search finds each member by its own words, with its op to pass (`roomChoices`, which replaces the run-command-only parsing: any string-enum property described a line per value is expanded, called as `<property>: <id>`). `gatherRoomFamilies(actions, families)` gathers the families a room declares by its members' ids: each family takes its first member's place, so a room keeps each member's definition and its tests where they were. A family's `op` names each member by its own id under `x-members` (`ROOM_FAMILY_MEMBERS`, read with `roomFamilyMembers`), for a generator and a reason that names a member.

## 0.15.2

### Patch Changes

- The app-wide search (`createKnowledgeLookup`, `searchWords`) treats a photo, a picture, a pic and an image as one word, as a person says them interchangeably. "Remove an object from a photo" now finds an image editor's Remove, as "from an image" does.

## 0.15.1

### Patch Changes

- A file control that takes several files says its limit in its description ("at most 20"). Before, the assistant read the unfilled text "at most ${ATTACHMENT_LIST_MAX}".

## 0.15.0

### Minor Changes

- The assistant knows what the whole app can do: the generated map says, for every page, how to reach it and what it offers, and the tab searches every action of the build for it.

  - **The app's map (cli).** The knowledge's `overview` is now the app's map: every page under its sidebar group, a page opened from another indented under it with the control that opens it, the pages reached only by address, then the frame, each followed by what it offers, grouped by where it is (a room's menu, a tab) and most telling first. It is fitted to `mapChars` (`oui.config.json`, 2,000–20,000, default 8,000): every page keeps its line, and what is left goes to the pages that make things. It is the same for every page of a build.
  - **Descriptions (cli).** A `PageHeader` subtitle describes its page only when it is a whole literal of three words or more and not a loading state: a fragment of a template literal ("s" in `` `${n} item${n === 1 ? '' : 's'}` ``) no longer does. A page that declares no description is described by what it offers ("Offers Remove, Generative Fill and Relight, among 261 actions."), or by what it shows, or, as a last resort, by its component's doc comment; one with none of these fails the generation, unless it is in `unbound`.
  - **Capabilities only a person can reach (cli).** A `nonAgent` control is the only way into what it does when no bound control on its page calls an app function its handlers call, and its reason names no action, tool or command of the build. The generation fails on one, naming it, unless it is listed on purpose in `<out>/oui-non-agent.allow.json`, which `oui generate --allow-non-agent` writes from what the build finds; a listing nothing matches fails too, so the list only shrinks. `GenerateResult.nonAgentOnly` lists them, and `generate(config, { allowNonAgent })` takes the flag.
  - **Picture inputs (cli).** A control that takes a picture says so where the knowledge lists it: any picture the assistant can reach, the sources its own input names, and the file slot beside it through which a file the person attached arrives.
  - **The app as a whole (bindings).** New: `surfacesOfPage`, `actionsOfPage`, `capabilitiesOf`, `actionRank`, `actionGroup`, `describedByActions`, `pageLinks`, `wayTo`, `wayWords`, `actionNeeds`, `takesPicture`, `pictureSources`, `takesAttachment`, `attachmentMediaTypes`, `pageForRoute`, `routeTakesId` and `describeStep` (moved from the cli), one implementation for the map, the descriptions and the search.
  - **The tab's lookup (bindings).** `createKnowledgeLookup({ knowledge, manifest, location })` answers `oui.find` (BM25 over every action's title, its own words, where a person finds it and its page, with each room's fields and commands; each result with its page, the way to it from the page the person is on, what it needs first, and what pictures it takes) and `oui.guide` (one page's knowledge by route, address or title, 12,000 characters at a time). `connectBindings({ knowledge })` installs it in the tab's runtime and removes it on disconnect.
  - **resolveKnowledge (bindings).** The map also comes apart, as `ResolvedKnowledge.map`, so an agent runtime can keep it where the prompt cache reads it on every turn; it stays the first of `entries` for a runtime that reads only those.
  - **Contract.** `oui-config.json` takes `mapChars`; the knowledge's `overview` is described as the map.

### Patch Changes

- Updated dependencies
  - @ouispec/contract@0.15.0
  - @ouispec/agent-events@0.33.4

## 0.14.7

### Patch Changes

- Updated dependencies
  - oui-spec@0.15.0
  - @ouispec/agent-events@0.33.2

## 0.14.4

### Patch Changes

- A file control can take several files at once. A control whose schema props say `multiple` (an upload zone that takes several files) takes a list of attached files' ids, from 1 to `ATTACHMENT_LIST_MAX` (20), as its `value`. The page resolves each id and runs the handler once, with every file in the order given, the way the person's own choice of several files does. A call that names any file the control does not take is refused whole, and its handler never runs. `multiple` is a new `SchemaProps` key, and a control table can map it (`SchemaPropSources.multiple`). `ATTACHMENT_LIST_MAX` is now exported from `oui-spec/spec` as well as `oui-spec/core`.
- Updated dependencies
  - @ouispec/contract@0.14.4
  - oui-spec@0.14.1

## 0.14.2

### Patch Changes

- An eval's page runs work that outlives its call as the product's tab does.

  - `@ouispec/contract`: a page's declared action, and a product control, can start a job (`job`: its id, when it settles, and its outcome, `complete` with the result fields or `failed` with the reason), in `AgentEvalPageAction`, `AgentEvalPageControl` and their cases.
  - `@ouispec/bindings`: an action that settles on a job answers `started` with what its handler returned beside `status` and `jobId`, where it dropped the handler's data (a capture's address and the links it found, an export's settings), so the assistant knows what it started while it runs; `startedAnswer` and `jobOutcomePolling` are exported, for a host that builds such an action itself.
  - `@ouispec/agent-evals`: such an action answers started, and settles on the scripted outcome through the runtime's own polling (`jobOutcomePolling`) of a scripted job tracker; a control's job is followed through `connectBindings`' tracker. Requests arrive, and both answers leave, on the tab's socket in memory through OUI's own transport, so the agent waits for the outcome as for the product's: in the call for its job wait, then with `ui_wait`. Before, a fixture's action answered once and never settled, so a capture an agent waited for was reported as nothing running. A job on an action or control whose effect does not settle on one is refused.

- Updated dependencies
  - @ouispec/contract@0.14.2

## 0.14.1

### Patch Changes

- A room the app's frame registers is described in the knowledge. `oui generate` gave a `shell` entry's rooms a surface on every page (`routes: ['*']`) but left them out of the knowledge: the frame's detail and recipes skipped them, so the assistant held the room's tools with nothing saying what they were for. The frame's knowledge now describes each room it registers ("in the app’s frame, whatever page is open") with its actions, fields and commands, and carries the room's recipes; a page that registers the same room no longer repeats it. `resolveKnowledge` gives a frame's recipes, first, on every page the frame is on.

## 0.14.0

### Patch Changes

- Updated dependencies
  - @ouispec/contract@0.14.0
  - @ouispec/agent-events@0.26.0

## 0.12.3

### Patch Changes

- Updated dependencies
  - oui-spec@0.14.0
  - @ouispec/contract@0.12.3
  - @ouispec/agent-events@0.25.0

## 0.12.2

### Patch Changes

- Released again to depend on `@ouispec/contract` 0.12.1, whose integrator guide documents `ui_wait`. No change of their own.
- Updated dependencies
  - @ouispec/agent-events@0.24.1

## 0.12.0

### Minor Changes

- A long form's page state fits what the model reads, and an index carries only what is read.

  - **`@ouispec/bindings`:** in the page state, a list's rows that all take one value schema leave it to their action's definition, which offers exactly that schema. A row keeps its own schema when the list's rows differ. On a form with a control per field per row, the same schema on row after row was three quarters of the page state.
  - **`oui-spec` (§7.3.8):** an observation in index form is its id, and its schema reduced to what leads to an `x-rows` declaration (`observationIndexEntry`, `OUIObservationIndexEntry`). A surface in full form keeps the whole declaration.
  - **`@ouispec/agent-worker`:**
    - Page state over budget: a form of short lists now fits. After the frame around the page is left out, short lists lose their rows' schemas, then become index rows, then counts, and the summary says how to read a list. A page or room is left out, or text cut off, only after all of that.
    - The index over budget: surfaces are listed by id in a fixed order, the frame first, then shared surfaces, then pages and rooms, the longest mounted first, so what the person opened last keeps its lines longest.
    - `Turn usage` gives `ui.snapshotBytes`, `ui.snapshotCuts` and `ui.pageState` (`chars`, `outcome`, `omitted`).
    - The root exports `DEFAULT_PAGE_STATE_CHARS`, `observationSchemas`, `observationsText` and `pageStateFit`, so a product can hold its pages to these limits in a test.

### Patch Changes

- Updated dependencies
  - oui-spec@0.13.0
  - @ouispec/agent-events@0.23.0

## 0.11.0

### Minor Changes

- Every display a page shows is in its manifest, and a frame on every page says so.

  - **The generator records every `useAgentFacts` a page reaches.** The app's own calls, in a component (a `<ReportFacts agent={…} />` the page renders) or an app hook, are read where the page reaches them, and their binding is followed through the props that pass it down to where it is written, a binding built from those props (`id: factsId`, `PRODUCT_META[product].title`) included, and a design-system display's binding the same. Props a component destructures in its body (`const { tableAgent } = props as TableProps`) are followed as those it destructures in its parameter. A component one parent renders twice is read once per use, with each use's props. A binding the build cannot read fails `generate --check`, where it is written: the page would report facts its manifest does not record.
  - **A control table declares every display, not only a description list.** `display` no longer needs `itemsProp` and `labelKey` (`labels` names the facts it always reports), and sits beside `kind`, `slots` or `entries`: a card bound to open reports under the same binding; a composite under its `slot` binding (`facts`) when the page gives one, else under the first of its `parts` the page bound. The conformance kit checks a composite display reports under that binding.
  - **A display may share its id** with the control whose rows it describes, or with itself shown from several places, described the same way everywhere; one id described two ways fails.
  - **A frame or a shared component on every page says so.** "around every page under /dashboard", not a list of every route in its description, which every turn's index carried. The manifest's `routes` are unchanged.
  - **The bindings mount a page for what it shows.** With none of its controls mounted (a page of figures, a Home whose cards gave way to a conversation), a page whose manifest entry records a display that is reporting is mounted, with no actions, so its state carries `shown`; where several pages record it, the page at the address. Evals get the same.

### Patch Changes

- Updated dependencies
  - @ouispec/contract@0.11.0
  - @ouispec/agent-events@0.22.1

## 0.10.0

### Minor Changes

- **An eval's page shows what the product's pages show.** The fixture page (`AgentEvalPage`) declares `shown`, each display's facts in the shape `useAgentFacts` reports them (`id`, `title`, `facts` by label, `item` for a card of a list), and `problems`, each page area's problems as `useAgentProblems` reports them (`source`, `problems`). They are registered with the binding registry as the product's displays and page areas register them, so the page state carries the Home's numbers and a list's cards under `shown` exactly as the product's tab does: by display, a long list kept as an index of its rows (`x-rows`), the rest read with `ui_read` at the display's own offset; and the page's problems in its `problems` observation, or the navigation surface's when no page is open. Each is shown on its `routes` and while the address holds its `query`. A surface declared in the suite takes `shown` (its `state` observation, declared with `x-rows`) and `problems` too.

  **The manifest records each page's displays.** The generator writes each display a page or shell shows on its surface (`displays`: binding id, title, description, the labels the build can read; `ManifestDisplay`), so a fixture names a display as the build does: an id the manifest does not record fails the page, a title left out is the manifest's, and an entry with no `routes` is shown where its page is. A page with no display records none; a manifest generated before this release is read as before.

  **A control follows the address's query.** A fixture control bound to a query parameter (`query: view`) takes its value from the page's address, read with the page's declared query as the generator records it in `app.navigate` (`pageQueryOf`, then `readQuery`: its default when the address leaves it out), follows the address when `app.navigate` goes to the page with another query, and writes the value a run gives it back to the address (`writeQuery`), so `/dashboard/service-lane?view=declined` opens on the declined tab. A parameter no page declares, or `query` on a list's control, fails the page.

  **The conversation store is given the turn it reads for.** `EvalHistory.getHistory`, and `createMemoryHistory`'s `window`, now receive `request.turn` beside the worker's request (`EvalHistoryRequest`, `EvalHistoryTurn`): the turn's id and place, its suite, scenario and channel, the customer (`user`), the context it is sent with (the scenario's view, the page's `currentPath`, `oui` and `uiKnowledge`), and where the page is (`at`). A step context written from the page needs no pass-through `beforeTurn`. A store that ignores it is unchanged.

  **Bindings.** `pageQueryOf` reads a page's query schema back into its declaration; `generatedNavigationSurface` is the navigation surface the generator emits, now shared by the generator and the eval page, whose own navigation surface now carries the `problems` observation, as the generator's does.

### Patch Changes

- Updated dependencies
  - @ouispec/contract@0.10.0
  - @ouispec/agent-events@0.22.0

## 0.9.0

### Patch Changes

- Updated dependencies
  - @ouispec/contract@0.9.0
  - @ouispec/agent-events@0.21.0

## 0.8.1

### Patch Changes

- **A long list of cards keeps an index of its rows in the page state, never a bare count.** The generated page state declares `x-rows` on `shown`: a display's facts that describe one row of a list (a card each) are addressed by the row's `item.key`, called by its `item.title`, and indexed with their display's `id`. `x-rows` takes a dotted path to a row's property (`rowValue`, `indexRow` and the row lookup read one), and the bindings report each display's rows together (`factsByDisplay`). Over budget, the worker keeps a display's first rows and the rows an action just changed whole and the rest as index rows, as it does any declared list; when even the index does not fit, it says how many rows are left out and the `ui_read` call (`path: /shown`, `offset`, `limit`) that returns exactly them, one display at a time. A page generated before the declaration is indexed the same way.
- Updated dependencies
  - @ouispec/contract@0.8.1

## 0.8.0

### Minor Changes

- **The assistant opens a page already filtered, in one call.** A page declares the query it reads from its address once, with `defineQuery` (`@ouispec/bindings`), and reads and writes it with `readQuery` and `writeQuery`: typed values, a value the page does not take falling back to its default, defaults left out of the address. The generator reads the declaration where the page, a component it renders or an app hook reads it, holds it to the new `page-query.json` schema, and the generated `app.navigate` takes `query` (one alternative per page, its routes in `x-routes`) and `params` (a route's `:parameters`, filled and encoded). `path` names each page's parameters, and the page's knowledge lists them. The runtime builds the address from the path, `params` and `query`, each part encoded, refuses a path that could leave the app (`//host`, a backslash, `.` or `..` segments) and a query parameter or value a declaring page does not take, naming what it takes, and does nothing, saying `alreadyThere`, when the person is already at that address. A build that declares no query is generated as before, with `params` added.

  **An action called as a tool runs once, through `ui_act`.** When the model calls an action of the page by its id as if it were a tool of its own (`app_navigate`), the worker runs it as the `ui_act` call it means, once, validated, judged by policy and approved as any `ui_act` call, instead of refusing it and having the model call it again. A name that is no action of the page is answered by the SDK as before.

### Patch Changes

- Updated dependencies
  - @ouispec/contract@0.8.0
  - @ouispec/agent-events@0.20.2

## 0.7.0

### Patch Changes

- Updated dependencies
  - @ouispec/contract@0.7.0
  - @ouispec/agent-events@0.20.1

## 0.6.0

### Patch Changes

- Updated dependencies
  - @ouispec/agent-events@0.19.0
  - @ouispec/contract@0.6.0
  - oui-spec@0.12.0

## 0.5.0

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @ouispec/agent-events@0.18.0
  - @ouispec/contract@0.5.0

## 0.4.9

### Patch Changes

- Updated dependencies
  - @ouispec/agent-events@0.17.0
  - @ouispec/contract@0.4.9

## 0.4.8

### Patch Changes

- Updated dependencies
  - @ouispec/agent-events@0.16.0
  - @ouispec/contract@0.4.8

## 0.4.7

### Patch Changes

- Updated dependencies
  - @ouispec/agent-events@0.14.0

## 0.4.6

### Patch Changes

- README and docs cleanup.
- Updated dependencies
  - @ouispec/agent-events@0.13.1
  - @ouispec/contract@0.4.6
  - oui-spec@0.11.1

## 0.4.5

### Patch Changes

- **A question is answered in words.** The tool strategy's new "Answering Questions" rule and `present_options`' description say that a question (what something is, how it works, why) is answered in the reply. A card is never the answer: it only follows when a choice does, and a question asked again is answered, not met with another offer. On Closure's dev, a person asked "What is the push channel?" twice and got only a card offering to set one up (`textLength: 0` both times). The new live eval `ui-questions` asks that question fresh, after a card, and again after a card that didn't answer it, under the neutral persona (12/12). With Closure's persona it fails before the rule and passes after (16/16). Its control, "set one up", still sets one up.

  **`ui_guide` finds the entry a name means.** It tries, in order: the exact title; the title in any case; the one page entry whose title, less its route, is the name ("Experience Studio" for "Experience Studio (/distribution/experiences/:partId)"); and the one entry the name begins (`findNamed`). A name that two entries could mean finds neither, and the error still lists them all.

  **An option says what it means.** `ControlOption.description` is new: what choosing the option means, as the control shows it beside its title. `deriveInputSchema` names it with the option (`token = Recipient token (A field of the recipient, such as {{firstName}})`) for choices, tabs and multi-choices, live and generated alike (`describeOption`). The generator reads it from source through a control table's new `OptionsSource.description` key, and a tier 2 mapping's options through `mappedOptions`.

  `liveTurn` (evals) takes the conversation before the message, the client's knowledge and a product's persona.

- Updated dependencies
  - @ouispec/contract@0.4.5

## 0.4.4

### Patch Changes

- A choice or tabs control whose live options are all gone (none given, or every one disabled) is not offered and is listed unavailable, as a disabled control is; a clearable one can still be cleared. Its schema's enum is empty rather than missing, so the assistant is never offered a free string that the page would take for an option's value.

## 0.4.0

### Minor Changes

- An action input can take a file the user attached (spec §7.3.11).

  - **oui-spec:** an input declared `{ type: 'string', format: 'oui-attachment', 'x-oui-attachment': { as: 'file' | 'text', mediaTypes } }` is sent the attachment's id.
    - The runtime resolves the id before the handler runs, through `createSurfaceRuntime({ attachments: { resolve } })`, and hands the handler the `File` or the file's text.
    - It refuses an id it cannot resolve, or a file of a type the input does not take (`ATTACHMENT_UNAVAILABLE`), and refuses outright when it has no resolver (`ATTACHMENTS_UNSUPPORTED`).
    - The type is checked for an input that takes text too: the host resolves it to the `File` or to `{ name, mediaType, text }` (`AttachmentText`), and bare text is taken only by an input that accepts any type.
    - A file input anywhere other than a property of the input or a list property's items is refused (`ATTACHMENT_INPUT_UNSUPPORTED`, `misplacedAttachmentInputs`).
    - A file named twice in a request is resolved once, a list's files at most four at a time, and a list input takes at most 20 files (`ATTACHMENT_LIST_MAX`).
    - The index describes the input as `file(…)`.
    - Exports `OUI_ATTACHMENT_FORMAT`, `isAttachmentId`, `attachmentInputOf`, `attachmentInputs`, `attachmentIdsIn`, `acceptsMediaType` and `misplacedAttachmentInputs`.
  - **contract:** the JSON Schema subset declares `x-oui-attachment` and documents the format. The control kinds add `file`, and `SchemaProps` adds `accept`.
  - **bindings:** a `file` control (an upload zone, a file button) derives that input from `accept`. Run by the assistant, its handler receives the file, as from the person's own choice. Its value must be the file itself (a `Blob`), or the text for an input that takes text: an unresolved id or a URL is not one.
  - **testing:** the kit samples a file, of a type the control accepts, for a control that takes one, and measures an attachment input against the budgets.
  - **cli:** released again on the new bindings and contract.

### Patch Changes

- Updated dependencies
- Updated dependencies
  - oui-spec@0.11.0
  - @ouispec/contract@0.4.0
  - @ouispec/agent-events@0.8.0

## 0.3.3

### Patch Changes

- Work that failed ends its action as a failure. A polling `resolve` may now return `{ done: true, data, error: { code, message } }`. The runtime then sends the final result with `success: false` and that error, and keeps `data`. The spec says so in §7.3.3: an async action whose work failed sends its final result as a failure.

  `@ouispec/bindings` ends a job whose declared failure arrived this way, with error `JOB_FAILED` and the declared reason as its message, and keeps the outcome as data. Before, a failed job answered `success: true` with `data.status: 'failed'`. The assistant's record of the call then said it succeeded, and so did the stored chat.

- Updated dependencies
- Updated dependencies
  - oui-spec@0.10.0
  - @ouispec/agent-events@0.7.0

## 0.3.1

### Patch Changes

- Updated dependencies
  - oui-spec@0.9.0
  - @ouispec/agent-events@0.5.0

## 0.2.3

### Patch Changes

- A colour control that offers mesh gradients says so in its schema. With `'mesh-gradient'` among a `color` control's `paintKinds`, the derived input schema accepts `{ kind: 'mesh-gradient', rows, columns, points }`: a grid of (rows + 1) × (columns + 1) points, each placed as fractions of the painted shape with a CSS colour, an optional opacity and optional `left`, `right`, `up` and `down` handles that bend the grid lines leaving it. A mesh has no stops, so it is no longer listed among the stop gradients' kinds. Controls that do not offer the kind are unchanged.

## 0.2.2

### Patch Changes

- The room readers' descriptions open with a short sentence. An index carries an action's first sentence (up to 160 characters), and `inspect` and `query` opened with sentences of 155 and 246 characters, in every room that declares lists. They now open with "Reads everything about the things named, as they are now." and "Lists the rows of one of the room's lists, to find a thing by its name."; the rest of each description is unchanged in substance and is read through the action's definition.

## 0.2.1

### Patch Changes

- Updated dependencies
  - oui-spec@0.8.0
  - @ouispec/agent-events@0.2.2

## 0.2.0

### Minor Changes

- The assistant scales to a whole app, and reads what a page holds. This release breaks 0.1: read the list before upgrading.

  **The page sends an index of its actions (needs `oui-spec` 0.7).**
  - A client created with `createSurfaceRuntime({ form: 'index' })` sends one line per action. The worker fetches a definition from the page when an action is first used (`oui.describe`). A client that sends every definition keeps working.
  - The model is given three UI tools whatever the page offers: `ui_act` (run one action by its id), `ui_describe` (what actions take) and `ui_read` (part of the page's state). A large definition is described in outline and opened by path. **Breaking:** a UI action is no longer its own model tool, and a stored tool call of one is `ui_act` with `{ action, input }`. Quota, tool policy, approval, the turn record and the `agent:tool_call_*` events still name the action.
  - Nothing that changes the page runs while the page cannot be seen: after an answer that arrived without the page's state, only reads run, and two refused changes end the turn's UI work.
  - Size budgets, checked by `oui generate` and by the conformance kit (`within-budgets`): an index entry is at most 512 bytes, a definition 256 KB, and a surface's index 128 KB.
  - **Breaking exports in `@ouispec/agent-worker`:** `readClientSnapshot` is `readClientPage`; `buildUITools` takes the page and returns `describe` and `read`; a UI result names `page.nowOffers`, `page.actionsAdded` and `page.actionsRemoved` in place of `toolsAdded` and `toolsRemoved`.

  **The assistant reads what the page holds, and knows what a value means.**
  - A room's lists are readable: a row index in the page state, and generated `inspect` and `query` actions. A name is accepted where an id is.
  - An edit says what it changed (`changed`), and that row is kept whole in the page state it comes with.
  - Every number in a generated action says its unit and its space (`x-unit`, `x-space`), and the generator refuses one that does not.
  - The turn keeps a record of what ran and what it could not confirm.

  **Questions, approvals and pictures.**
  - **Breaking:** `present_options` requires `context`: what the person needs to know before choosing. The card shows it above the question.
  - An approved action is one call with one result.
  - A picture in an action's answer (`data.image = { mediaType, base64, width, height }`; PNG, JPEG or WebP, up to 256 KB of base64) is given to the model as an image, and its base64 is kept nowhere.
  - The Lambda and container adapters take `uiActions.maxIndexChars`.

  **Also.**
  - A model that takes no temperature is sent none (`temperature: null`).
  - The contract's JSON Schema subset gains `x-unit`, `x-space`, `x-ref` and `x-rows`, and a room catalog declares its rows.
  - The paint controls' schema takes freeform gradients and patterns.

### Patch Changes

- Updated dependencies
  - @ouispec/agent-events@0.2.0
  - @ouispec/contract@0.2.0

## 0.1.1

### Patch Changes

- Updated dependencies
  - oui-spec@0.7.0
  - @ouispec/agent-events@0.1.1

## 0.1.0

### Minor Changes

- d6144bb: First public release, under the MIT licence, published from the open `oui` repository with provenance. The code continues Closure Studio's internal packages of the same purpose (`oui-contract`, `oui-bindings`, `oui-generator` as `@ouispec/cli`, `oui-testing`, and the `agent-sdk-*` family as `@ouispec/agent-*`), with the package names as the only change. The generator's command is `oui`; `closure-oui` remains as an alias for a transition.

### Patch Changes

- Updated dependencies [d6144bb]
  - @ouispec/contract@0.1.0
  - @ouispec/agent-events@0.1.0

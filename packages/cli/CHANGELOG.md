# @ouispec/cli

## 0.19.0

### Minor Changes

- A page may say what it is for to the assistant only, apart from its visible copy: the `@agentDescription` tag of its component's doc comment. Declared, it is the page's description in place of its header's subtitle or what it offers: its surface's description in the manifest, its knowledge's summary and detail, and its line on the app's map, which carries its first sentence as `says` (a new optional field of the map's page line) and says it before what the page offers. It is held to a subtitle's rule (three words or more, not a loading state), and one that breaks it fails the generation, naming where it is written. Under route gates it goes only where its page goes: a session that may not see the page is never told it, an open page's `says` loses a sentence that names a page the session may not see, and a page's summary or detail all of whose sentences name such pages is said by the page's name and open routes instead of as it was. A page that declares none is described exactly as before (the fixture apps' golden manifest and knowledge are unchanged). The integrator guide says how.

### Patch Changes

- Updated dependencies
  - @ouispec/bindings@0.19.0
  - @ouispec/contract@0.19.0

## 0.18.0

### Minor Changes

- One build can serve several brands or audiences, and the assistant is told of the app only as the session's person sees it.

  - cli: `routeGates` in `oui.config.json` names the route wrappers that open their page only to some sessions, each with the prop whose value names the gate (`{ "FeatureRoute": "feature" }`); each must also be in `routeWrappers`. Every route records the gates its element and its parent routes' elements are wrapped in, outermost first, read at build time from a literal or a constant (`FEATURE_KEYS.campaigns`). A gate the build cannot read, or a gating wrapper without the prop, fails the build as an unreadable path does. On the app's map a page goes under another only when that page is open whenever it is. A config that names no gates generates exactly what it did before, byte for byte (the fixture apps' output of 0.17.1 is held in `__tests__/fixtures/golden/`).
  - contract: a page's manifest surface and knowledge carry `gates` (`RouteGates`: route → its gates), and the knowledge carries the app's map line by line (`map`, `AppMapLine`) when any route is gated. `overview.content` is still the whole map. `oui-config.json` gains `routeGates`.
  - bindings: the host says which gates the session may see with `allows: (gate) => boolean`. `connectBindings({ knowledge, allows })` then offers `app.navigate` only the open pages and answers `oui.find` and `oui.guide` only of them; `createKnowledgeLookup({ allows })` does the same on its own, and `resolveKnowledge(knowledge, path, { allows })` gives the map without the other pages, and no page's knowledge on a page the session may not see. A route is open when every one of its gates is allowed, and a page when any of its routes is. A page the session may not see is named nowhere the assistant reads: not in a surface's, an action's or an observation's description (a shared part's "on /, /war-room" keeps only its open routes, and "It goes to /war-room." is left out), not in the navigation action, not in a page's entries, relationships or recipes (a sentence that names it by its route or an address on it is left out, a route list loses it, a heading whose items all went goes too), not in the map or its frame lines, and not in `oui.find` or `oui.guide`. A control that only goes to such a page is not offered (it leads nowhere for the session), and a route step to such a page leaves an action's reach. `scopeKnowledge`, `scopeManifest`, `scopedNavigationSurface`, `scopeText`, `routeScope`, `appMapContent`, `routeOpen`, `openRoutes`, `buildGates`, `openPageForPath` and `pageRouteForPath` are exported. Without `allows`, or for a build with no gates, nothing changes.

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @ouispec/contract@0.18.0
  - @ouispec/bindings@0.18.0

## 0.17.2

### Patch Changes

- Depends on the current `@ouispec/contract`, which adds the eval expectation `history`. Nothing else changes.
- Updated dependencies
- Updated dependencies
  - @ouispec/bindings@0.17.2
  - @ouispec/contract@0.17.2

## 0.17.1

### Patch Changes

- Depends on the current `@ouispec/contract`, which adds the eval expectation `whileWorking`. Nothing else changes.
- Updated dependencies
- Updated dependencies
  - @ouispec/bindings@0.17.1
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
  - @ouispec/bindings@0.17.0

## 0.16.0

### Minor Changes

- A room action family's members (`roomActionFamily`, named under `x-members` on its `op`) are names the build has, by their own ids: a `nonAgent` reason that names one ("the editor catalog's update-segment sets the same property") names the assistant's way in, and a reason's parenthesised name may be one.

### Patch Changes

- Updated dependencies
  - @ouispec/bindings@0.16.0

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
  - @ouispec/bindings@0.15.0

## 0.14.5

### Patch Changes

- A composite's slot can take its schema from props of the component where the page uses it. In a control table, `SlotDescriptor.schemaProps` maps `SchemaProps` keys to the component's props, the way a control's own `schemaProps` do, and they are applied over the slot's `defaults`. The generator reads them from the element. So an upload zone used with `multiple` declares a choose slot that takes a list of files, and the list it registers live narrows that declaration instead of widening it.
- Updated dependencies
  - @ouispec/contract@0.14.5

## 0.14.1

### Patch Changes

- A room the app's frame registers is described in the knowledge. `oui generate` gave a `shell` entry's rooms a surface on every page (`routes: ['*']`) but left them out of the knowledge: the frame's detail and recipes skipped them, so the assistant held the room's tools with nothing saying what they were for. The frame's knowledge now describes each room it registers ("in the app’s frame, whatever page is open") with its actions, fields and commands, and carries the room's recipes; a page that registers the same room no longer repeats it. `resolveKnowledge` gives a frame's recipes, first, on every page the frame is on.
- Updated dependencies
  - @ouispec/bindings@0.14.1

## 0.14.0

### Patch Changes

- Updated dependencies
  - @ouispec/contract@0.14.0
  - @ouispec/bindings@0.14.0

## 0.13.0

### Minor Changes

- A control shared between pages is a surface of the outermost component that renders it on exactly those pages, not of the component its JSX is written in. A tree of components two pages render together (a document whose sections are each a component) is one `shared:` surface named by its root, instead of one per component, each repeating its name and routes in the assistant's index. A component that also renders on another page stays a surface of its own. Every action keeps its id; only surface ids and titles change.

## 0.12.2

### Patch Changes

- Released again to depend on `@ouispec/contract` 0.12.1, whose integrator guide documents `ui_wait`. No change of their own.
- Updated dependencies
  - @ouispec/bindings@0.12.2

## 0.12.0

### Patch Changes

- Updated dependencies
  - @ouispec/bindings@0.12.0

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
  - @ouispec/bindings@0.11.0

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
  - @ouispec/bindings@0.10.0

## 0.9.0

### Patch Changes

- Updated dependencies
  - @ouispec/contract@0.9.0
  - @ouispec/bindings@0.9.0

## 0.8.1

### Patch Changes

- **A long list of cards keeps an index of its rows in the page state, never a bare count.** The generated page state declares `x-rows` on `shown`: a display's facts that describe one row of a list (a card each) are addressed by the row's `item.key`, called by its `item.title`, and indexed with their display's `id`. `x-rows` takes a dotted path to a row's property (`rowValue`, `indexRow` and the row lookup read one), and the bindings report each display's rows together (`factsByDisplay`). Over budget, the worker keeps a display's first rows and the rows an action just changed whole and the rest as index rows, as it does any declared list; when even the index does not fit, it says how many rows are left out and the `ui_read` call (`path: /shown`, `offset`, `limit`) that returns exactly them, one display at a time. A page generated before the declaration is indexed the same way.
- Updated dependencies
  - @ouispec/contract@0.8.1
  - @ouispec/bindings@0.8.1

## 0.8.0

### Minor Changes

- **The assistant opens a page already filtered, in one call.** A page declares the query it reads from its address once, with `defineQuery` (`@ouispec/bindings`), and reads and writes it with `readQuery` and `writeQuery`: typed values, a value the page does not take falling back to its default, defaults left out of the address. The generator reads the declaration where the page, a component it renders or an app hook reads it, holds it to the new `page-query.json` schema, and the generated `app.navigate` takes `query` (one alternative per page, its routes in `x-routes`) and `params` (a route's `:parameters`, filled and encoded). `path` names each page's parameters, and the page's knowledge lists them. The runtime builds the address from the path, `params` and `query`, each part encoded, refuses a path that could leave the app (`//host`, a backslash, `.` or `..` segments) and a query parameter or value a declaring page does not take, naming what it takes, and does nothing, saying `alreadyThere`, when the person is already at that address. A build that declares no query is generated as before, with `params` added.

  **An action called as a tool runs once, through `ui_act`.** When the model calls an action of the page by its id as if it were a tool of its own (`app_navigate`), the worker runs it as the `ui_act` call it means, once, validated, judged by policy and approved as any `ui_act` call, instead of refusing it and having the model call it again. A name that is no action of the page is answered by the SDK as before.

### Patch Changes

- Updated dependencies
  - @ouispec/contract@0.8.0
  - @ouispec/bindings@0.8.0

## 0.7.0

### Minor Changes

- **Pages the assistant is never on.** `oui.config.json` takes `outside`: pages before sign-in and public pages a link opens, each named by `component` or by `route`, with its `reason` (`OutsideEntry`). An outside page has no surface, its controls are not enforced, `app_navigate` does not list it, and the knowledge's overview says the assistant is not on its routes. Until now such a page could only sit in `unbound`, which is meant to shrink to nothing.

  The list cannot hide a page of the app. A page is outside only when no `shell` entry frames its routes; every element its routes render around it (a layout route's, or a `routeWrappers` component's, at any level) holds nothing someone can use and no person-only component, which is how the assistant's own UI is declared; it does not render the app's frame itself; and it has no binding, display or room of its own, on no page the assistant is on. A page is never in both `outside` and `unbound`. An app without `outside` builds as before.

  **A design system's person-only components are the person's own.** `oui.personOnly` in a package listed in `designSystem` is now read, as it already was for any other package: a sign-in screen or the assistant's panel needs no control table entry, its callbacks need no `data-non-agent`, and an `agent` binding or a spread on one fails the build. An export in both the control table and `oui.personOnly` is an error. A page whose only unbound controls were such components is now fully bound, so the build asks to take it out of `unbound`: this is why the release is a minor.

  A route's page is read through the components it renders, as before; the tests now hold a route element that picks between two lazy pages, each rendering through a wrapper of its own children.

  The agent SDK is released again only to depend on this contract.

### Patch Changes

- Updated dependencies
  - @ouispec/contract@0.7.0
  - @ouispec/bindings@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies
  - @ouispec/contract@0.6.0
  - @ouispec/bindings@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies
  - @ouispec/contract@0.5.0
  - @ouispec/bindings@0.5.0

## 0.4.6

### Patch Changes

- README and docs cleanup.
- Updated dependencies
  - @ouispec/bindings@0.4.6
  - @ouispec/contract@0.4.6

## 0.4.5

### Patch Changes

- **A question is answered in words.** The tool strategy's new "Answering Questions" rule and `present_options`' description say that a question (what something is, how it works, why) is answered in the reply. A card is never the answer: it only follows when a choice does, and a question asked again is answered, not met with another offer. On Closure's dev, a person asked "What is the push channel?" twice and got only a card offering to set one up (`textLength: 0` both times). The new live eval `ui-questions` asks that question fresh, after a card, and again after a card that didn't answer it, under the neutral persona (12/12). With Closure's persona it fails before the rule and passes after (16/16). Its control, "set one up", still sets one up.

  **`ui_guide` finds the entry a name means.** It tries, in order: the exact title; the title in any case; the one page entry whose title, less its route, is the name ("Experience Studio" for "Experience Studio (/distribution/experiences/:partId)"); and the one entry the name begins (`findNamed`). A name that two entries could mean finds neither, and the error still lists them all.

  **An option says what it means.** `ControlOption.description` is new: what choosing the option means, as the control shows it beside its title. `deriveInputSchema` names it with the option (`token = Recipient token (A field of the recipient, such as {{firstName}})`) for choices, tabs and multi-choices, live and generated alike (`describeOption`). The generator reads it from source through a control table's new `OptionsSource.description` key, and a tier 2 mapping's options through `mappedOptions`.

  `liveTurn` (evals) takes the conversation before the message, the client's knowledge and a product's persona.

- Updated dependencies
  - @ouispec/contract@0.4.5
  - @ouispec/bindings@0.4.5

## 0.4.3

### Patch Changes

- A control imported from a subpath export of a design-system package is read against that package's control table.

  A design system that declares its control table once in its package.json (`"oui": { "agentControls": … }`) but exports its React controls from a subpath (`@acme/kit/react`) was never recognised: `oui generate` compared each import's specifier with the `designSystem` names exactly, so every bound control imported from the subpath failed as "neither a design-system control nor a room host", and a binding on it never reached the manifest.

  - An import whose specifier is a listed package, or a subpath of one (`<package>/<anything>`), is that package's: its controls are bound against the package's table, and an unbound one on an enforced page is reported as before. When `designSystem` lists a package and a subpath of it, the longest name the import is under wins. A package whose name only starts the same (`@acme/kit-extras` for `@acme/kit`) is not a match.
  - The same holds for a room package's hosts and catalog, for a person-only component (`oui.personOnly` is read from the package a subpath belongs to), and for a mapped package: a mapped control imported from a subpath of its package is reported as imported straight from the package, naming the bound import.
  - A mapping of a package that overlaps a `designSystem` entry through a subpath (`acme` and `acme/kit`, either way round) is refused, as a mapping of a listed package already was.

## 0.4.0

### Patch Changes

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

- Updated dependencies
  - @ouispec/contract@0.4.0
  - @ouispec/bindings@0.4.0

## 0.3.4

### Patch Changes

- Published again with their dependencies on the current releases. `@ouispec/cli` 0.3.0 still required `@ouispec/bindings ^0.2.3` and `@ouispec/contract ^0.2.0`, and `@ouispec/testing` 0.2.0 required `@ouispec/contract ^0.2.0`. An app on `@ouispec/bindings` 0.3 and `oui-spec` 0.10 therefore got a second, older copy of each through the generator, and `oui generate` built its manifest with bindings 0.2. There is no change of code.

## 0.3.0

### Minor Changes

- A reason a control gives for not being the assistant's is checked when it names another action.

  A control opts out with `data-non-agent="<reason>"` or `agent={{ nonAgent: '<reason>' }}`, and the reason commonly names what the assistant uses instead: "opens Add Asset, as the Add button (editor.add-asset.open) does", or "the same as the insert.media command". Nothing checked that name, so a renamed or removed action left the assistant with no way to do the thing and nothing saying so.

  `oui generate` now fails a reason that names, in parentheses, an id with a dot in it that is no binding, room action or command of the app, and one that names "`<id>` command" for a command no room's catalog has. Each failure gives the file and line of the reason. Nothing else in a reason is read.

  **What to do when you take this version.** A build that passed may now fail on a stale reason: point it at the action the assistant uses, or bind the control.

## 0.2.3

### Patch Changes

- A control's label is read from its own text, never from a nested element's attributes.

  The generator names an action by the control's label. Reading a label from children that hold an expression (`{busy ? <Loader className="animate-spin" /> : null} Render WAV`), it took every string literal inside the expression, the nested element's `className` and `data-testid` included, so actions were titled "animate-spin Render WAV", "text-[10px] shrink-0" or "character-create-persona-path". Thirty actions of one app were named that way, and an assistant does not choose an action it cannot name.

  - JSX inside an expression is not entered: the label is the text the control itself shows.
  - An entity is read as the character it shows (`Use the character&apos;s own` is "Use the character's own").
  - Text that is only a symbol (`&times;`, `★`) gives no label, so the control's `aria-label` or its binding's `title` names it.

  **What to do when you take this version.** Your first build on it changes the generated titles that were wrong, so `oui generate --check` fails until you regenerate: run `oui generate`, review the diff (titles only; no id, input or schema changes), and commit the generated files in the same change that takes the version.

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
  - @ouispec/contract@0.2.0
  - @ouispec/bindings@0.2.0

## 0.1.0

### Minor Changes

- d6144bb: First public release, under the MIT licence, published from the open `oui` repository with provenance. The code continues Closure Studio's internal packages of the same purpose (`oui-contract`, `oui-bindings`, `oui-generator` as `@ouispec/cli`, `oui-testing`, and the `agent-sdk-*` family as `@ouispec/agent-*`), with the package names as the only change. The generator's command is `oui`; `closure-oui` remains as an alias for a transition.

### Patch Changes

- Updated dependencies [d6144bb]
  - @ouispec/contract@0.1.0
  - @ouispec/bindings@0.1.0

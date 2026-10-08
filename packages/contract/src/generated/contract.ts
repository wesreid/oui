// GENERATED FILE — DO NOT EDIT.
//
// Generated from schemas/*.json, the OUI integrator contract, by @ouispec/contract.
// Edit the schemas, then: pnpm generate (in packages/contract).

/**
 * The contract major. A breaking change to any schema of the contract bumps it, and it is in
 * every `$id`.
 */
export const MANIFEST_VERSION = 1;

/**
 * Where the contract’s schemas are identified: each `$id` is this followed by the file name.
 */
export const CONTRACT_SCHEMA_BASE = 'https://schemas.closurestudio.ai/oui/v1/';

// ─── JSON Schema, as capabilities declare their inputs and values ──────────────
// https://schemas.closurestudio.ai/oui/v1/json-schema.json

/**
 * The subset of JSON Schema (draft 2020-12) every capability declares its input and values in.
 * It is what assistant tool inputs are written in, so a declared or derived schema is used as
 * is. `x-unit` names the unit a number is in: `px`, `%`, `°`; `x-space` names the frame it is
 * measured in; `x-rows` and `x-ref` say which lists hold addressable rows and which inputs
 * address them.
 */
export interface JsonSchema {
  type?: JsonSchemaType | readonly JsonSchemaType[];
  description?: string;
  enum?: readonly (string | number | boolean | null)[];
  const?: string | number | boolean | null;
  properties?: Readonly<Record<string, JsonSchema>>;
  required?: readonly string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  /** No two items are the same. */
  uniqueItems?: boolean;
  minimum?: number;
  maximum?: number;
  multipleOf?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  /**
   * A string's format: `date`, `time`, `email`, `uri`, or `oui-attachment`, an input that takes
   * a file the user attached (OUI spec §7.3.11): the agent passes the attachment's id, and the
   * client hands the action the file or its text, as `x-oui-attachment` declares.
   */
  format?: string;
  oneOf?: readonly JsonSchema[];
  anyOf?: readonly JsonSchema[];
  default?: unknown;
  /** The unit a number is in: `px`, `%`, `°`. */
  'x-unit'?: string;
  /**
   * The frame a length, a point or a fraction is measured in, in the room's own words:
   * `artboard` (from its top left), `canvas`, `layer` (the layer's own content),
   * `artboard-fraction` (0–1 of the artboard's width and height). A room names its spaces in
   * its description or a recipe (ADR-0244 §2.3).
   */
  'x-space'?: string;
  /**
   * On an array of objects in an observation: the list is a collection the assistant addresses
   * rows of (a document's layers, its artboards). It names the property each row is addressed
   * by and the one a person calls it by, so a list too long for the page state keeps an index
   * of every row instead of a count, and a title given where an id is expected resolves to its
   * row (ADR-0244 §2.1, §2.2).
   */
  'x-rows'?: RowList;
  /**
   * On a string (or the items of an array of strings) in an action's input: the value addresses
   * a row of one of the surface's `x-rows` lists, each named `<observation id>/<list
   * property>`, or `<observation id>` when the observation itself is the list. The row's id, or
   * its exact title when one row has it (ADR-0244 §2.2).
   */
  'x-ref'?: readonly string[];
  /**
   * How many allowed values a shortened `enum` leaves out. Only in the page state, where a
   * row's options are summarised; a tool's input schema always lists every value.
   */
  'x-enum-omitted'?: number;
  /**
   * On a string with `format: oui-attachment`: what the action takes once the client resolves
   * the attachment's id (ADR-0252 §2.13). `as`: `file` (a `File`, as the user's own file choice
   * produces) or `text` (the file's text, for an input that takes markup or JSON).
   * `mediaTypes`: the types it accepts, `type/*` for a family; any when absent.
   */
  'x-oui-attachment'?: {
    as: 'file' | 'text';
    mediaTypes?: readonly string[];
  };
}

/** How the rows of a list are addressed and indexed. */
export interface RowList {
  /** The property of a row that actions address it by (`id`). */
  ref: string;
  /** The property of a row a person calls it by (`name`). */
  title: string;
  /**
   * The other properties an index row keeps: the few that tell rows apart (a layer's kind, the
   * artboard it is on).
   */
  index?: readonly string[];
  /**
   * The property beside the list, in the same object, that holds the refs of the rows the
   * person has selected. Selected rows are kept whole however short the list gets.
   */
  selection?: string;
}

/** A JSON Schema type name. */
export type JsonSchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';

// ─── What an action does (ADR-0226 §2.6), and how a job settles ────────────────
// https://schemas.closurestudio.ai/oui/v1/action-effect.json

/**
 * What using an action does (ADR-0226 §2.6): one vocabulary for a design-system control's
 * binding, a room catalog's entry and a generated API tool, so a page control, a room action
 * and an API call are told apart by what they change, never by where they are declared.
 *
 * | Effect | What it changes | ADR-0210 access |
 * |---|---|---|
 * | `view`, `selection`, `navigate`, `open` | What is shown | read |
 * | `edit` | The document, one undo step | write |
 * | `file` | Imports or exports a file | write |
 * | `mutate` | Backend data, through an API operation | write |
 * | `job` | Starts work that outlives the call, settled on its outcome | write |
 * | `transaction` | An irreversible external act: an order, a payment, a send, a publish | write, approved |
 *
 * A `transaction`, and any `write` declared `destructive`, runs only on an approval the person
 * gave, bound to the call (ADR-0228).
 */
export type ActionEffect = SimpleEffect | {
  kind: 'navigate';
  to: string;
} | {
  kind: 'open';
  container: string;
} | {
  kind: 'mutate';
  operation: string;
} | {
  kind: 'job';
  estimatedDuration?: string;
  timeoutMs?: number;
} | {
  kind: 'transaction';
  operation?: string;
  estimatedDuration?: string;
  timeoutMs?: number;
  approvalMinutes?: number;
};

/** An effect that needs nothing but its name. */
export type SimpleEffect = 'view' | 'selection' | 'edit' | 'file';

/**
 * The effect kinds, in the order of the table above. The vocabulary, what each one may change,
 * and what needs the person's approval are OUI's (`oui-spec`).
 */
export type ActionEffectKind = 'view' | 'selection' | 'navigate' | 'open' | 'edit' | 'file' | 'mutate' | 'job' | 'transaction';

/**
 * Whether an effect only changes what is shown (`read`), or changes something (`write`), as
 * ADR-0210 names it. An action that declares no effect is a `write`.
 */
export type EffectAccess = 'read' | 'write';

/**
 * Where an action whose effect is `job` or `transaction` is (plan §2.3, #205/#209):
 *
 * - `started`: the handler returned; the job is tracked from this moment, so an outcome that
 * arrives before the first poll is kept.
 * - `running`: still going; the runtime polls the app's `JobTracker`.
 * - `complete`: the job's declared completion arrived; the result exists.
 * - `failed`: its declared failure arrived; the result never will.
 * - `timeout`: it did not finish within `timeoutMs`. A failure, never a late success.
 * - `unverified`: no `JobTracker`, or no job id to follow: the work was started but cannot be
 * confirmed from the page.
 */
export type JobStatus = 'started' | 'running' | 'complete' | 'failed' | 'timeout' | 'unverified';

/**
 * A job's end, as the assistant is told it. `complete` means the result exists; `failed` that
 * it never will. A `complete` outcome carries the declared result fields beside its job id.
 */
export type JobOutcome = {
  status: 'complete';
  jobId: string;
  [key: string]: unknown;
} | {
  status: 'failed';
  jobId: string;
  error: string;
};

/**
 * What an action that settles on a job reports, from its first answer to its last: `started`
 * (with the job id when the handler gave one), `running` while it polls, then the `JobOutcome`,
 * or `unverified`. A `timeout` is reported as the error `TIMEOUT`, never as data.
 */
export type JobSettlement = {
  status: 'started';
  jobId?: string;
  [key: string]: unknown;
} | {
  status: 'running';
  jobId: string;
} | JobOutcome | {
  status: 'unverified';
  message: string;
};

// ─── The binding a control carries (ADR-0220 §2.2) ─────────────────────────────
// https://schemas.closurestudio.ai/oui/v1/agent-binding.json

/**
 * The semantic binding a design-system control carries (ADR-0220 §2.2): what the control means,
 * in the user's terms, declared where the page uses it, as its `agent` prop.
 *
 * It uses a room catalog entry's vocabulary (id, title and description; `ActionEffect`;
 * `destructive`), so to the generator a page control and a room entry look the same. What is
 * never written: the input schema, which is derived from the control's own props, and where the
 * control is, which the generator derives from the page's component tree.
 *
 * **Every value is a build-time constant** (#203). The generator reads bindings from source
 * without running it, so each value is a literal, a `const` it can follow, a property of a
 * constant object, a template literal or `+` over those, or a single-literal type read through
 * the type checker. A value built by a call (`t('save')`, `format(...)`) is refused, naming the
 * binding. A field's build-time `hint` and `placeholder` are added to its tool description the
 * same way.
 */
export interface AgentBinding {
  /**
   * Stable, globally unique, dotted and lower-kebab: `voices.library`, `voices.detail.engine`.
   * The first segment is the area. The tool name is the id with `.` and `-` as `_`, at most 64
   * characters.
   */
  id: string;
  /** Defaults to the control's visible label or aria-label. */
  title?: string;
  /** What using it does, for someone who cannot see the screen. */
  description: string;
  /**
   * What using it does: what reach paths, data and verification are derived from (ADR-0226
   * §2.6).
   */
  effect?: ActionEffect;
  /**
   * It removes or replaces something the person made; running it needs the person's approval
   * (ADR-0228).
   */
  destructive?: boolean;
  /**
   * It changes what the person is working in (their account, project or role) rather than their
   * work; the assistant asks before using it.
   */
  confirm?: boolean;
  /** Set when the control is one of a list's rows: which row. */
  item?: AgentItem;
}

/** One of several of the same control rendered from a list: which one it is. */
export interface AgentItem {
  /** The id of what the row shows (a voice id, a project id). */
  key: string;
  /** What the row is called on screen (the voice's name). */
  title: string;
  /**
   * What this row is, when the rows' meanings are only known at run time (a model's parameters,
   * from its manifest). Shown with the row in the page state.
   */
  description?: string;
}

/**
 * On a control the assistant must never operate — purely decorative, or chrome that duplicates
 * a bound control. The reason is required and is reviewed like any other declaration.
 */
export interface NonAgentBinding {
  nonAgent: string;
}

/** The `agent` prop of a single-purpose control. */
export type AgentProp = AgentBinding | NonAgentBinding;

// ─── Control kinds, and the props their schemas come from ──────────────────────
// https://schemas.closurestudio.ai/oui/v1/control-kind-registration.json

/**
 * A control kind a design system adds (ADR-0226 §2.6). `ControlKind` is closed: a design system
 * adds a kind only by registering it, under an `x-` name. The registration ships in the design
 * system's control table (`$kinds`), where the generator reads it, and the design system
 * registers it at run time with `registerControlKind`, so the browser and the generator derive
 * the same schema.
 */
export interface ControlKindRegistration {
  kind: RegisteredControlKind;
  /** What using it does, as a tool description starts: "Set the price range of". */
  verb: string;
  deriveSchema: KindSchemaDerivation;
}

/**
 * The built-in control kinds, closed:
 *
 * - `button`: press it (buttons, toolbar buttons, menu items, a row's action).
 * - `toggle`: set it on or off (switches, checkboxes).
 * - `text`: type into it (inputs, text areas).
 * - `number`: set a number (sliders, scrub fields).
 * - `choice`: choose one of its options (selects, radio groups, preset tiles).
 * - `multi-choice`: choose any of its options (multi-selects, checkbox groups, filter chips).
 * - `color`: set a colour or paint (colour pickers, swatches).
 * - `font`: choose a family and style (font pickers).
 * - `tabs`: select a tab.
 * - `date`: set a date.
 * - `date-range`: set a start and an end date.
 * - `file`: give it a file (upload zones, file buttons): the user's attached file, by its id,
 * which the client resolves to a `File` (ADR-0252 §2.13).
 * - `dialog`: close it. Opening is its trigger's.
 */
export type ControlKind = 'button' | 'toggle' | 'text' | 'number' | 'choice' | 'multi-choice' | 'color' | 'font' | 'tabs' | 'date' | 'date-range' | 'file' | 'dialog';

/**
 * A kind a design system registers: `x-` and lower-kebab, so it never collides with a built-in
 * one.
 */
export type RegisteredControlKind = `x-${string}`;

/** A built-in kind, or one a design system registers. */
export type AnyControlKind = ControlKind | RegisteredControlKind;

/** A key of `SchemaProps`: a prop a control's value schema is derived from. */
export type SchemaPropName = 'min' | 'max' | 'step' | 'unit' | 'wrap' | 'options' | 'minLength' | 'maxLength' | 'pattern' | 'inputType' | 'paintKinds' | 'allowNone' | 'clearable' | 'accept';

/** One option of a choice, tab set or menu, as the control shows it. */
export interface ControlOption {
  value: string | number;
  title: string;
  disabled?: boolean;
}

/**
 * The props a control's input schema is derived from, by the one derivation
 * (`deriveInputSchema`) the browser runs on live props and the generator on the props it reads
 * statically. A live schema may narrow the generated one but never widen it.
 */
export interface SchemaProps {
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** Wraps past either end: an angle, where 181° is −179°. */
  wrap?: boolean;
  options?: readonly ControlOption[];
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  /** An input's `type`: `email`, `url`, `number`, `password`… */
  inputType?: string;
  /** The paint kinds a colour control offers: `solid`, `linear`, `radial`. */
  paintKinds?: readonly string[];
  /** A colour control can be set to no paint. */
  allowNone?: boolean;
  /** A choice that can be cleared (a toggleable tile grid). */
  clearable?: boolean;
  /**
   * The media types a file control takes, `type/*` for a family: an `<input accept>`'s types,
   * without file extensions.
   */
  accept?: readonly string[];
}

/**
 * How a registered kind's value schema follows from a control's props, as data, so the browser
 * and the generator derive it with the same function: the schema, and which of its keywords
 * each prop sets, by JSON Pointer. `options` sets a keyword to the values of the options that
 * are not disabled.
 *
 * ```json
 * { "schema": { "type": "object", "properties": { "low": { "type": "number" }, "high": { "type": "number" } } },
 *   "props": { "/properties/low/minimum": "min", "/properties/high/maximum": "max" } }
 * ```
 */
export interface KindSchemaDerivation {
  schema: JsonSchema;
  props?: Readonly<Record<string, SchemaPropName>>;
}

// ─── A design system’s control table (ADR-0226 §2.2) ───────────────────────────
// https://schemas.closurestudio.ai/oui/v1/control-table.json

/**
 * A design-system package's control table as it ships (`agent-controls.json`, ADR-0226 §2.2
 * rule 4): each interactive export's `ControlDescriptor` by export name, and under `$kinds` the
 * control kinds the design system registers, if any. The package declares the table next to its
 * controls, writes it at build time, and names it in its `package.json` under
 * `oui.agentControls` (`closure.agentControls` is read during the transition; declaring both is
 * an error). The conformance kit holds every listed component to registering with the kind
 * declared here.
 */
export interface ControlTableFile {
  /** The control kinds this design system registers. */
  $kinds?: readonly ControlKindRegistration[];
  [key: string]: ControlDescriptor | readonly ControlKindRegistration[] | undefined;
}

/** A design-system package's controls, by export name: the table without its `$kinds`. */
export type ControlTable = Readonly<Record<string, ControlDescriptor>>;

/**
 * One slot of a composite: its kind and the callback it binds. `callback` absent: the slot is
 * always interactive (a toast host's toasts, whatever the page passes). `rows`: the slot
 * registers once per row the control renders (a table's rows, a filter bar's pills), so its
 * action takes an `item`. `defaults`: what the slot always registers, over the component's (a
 * table's sort can be cleared), so the declared schema is as wide as the live one.
 */
export interface SlotDescriptor {
  kind: AnyControlKind;
  callback?: string;
  rows?: boolean;
  defaults?: SchemaProps;
}

/**
 * An array prop whose entries carry their own `agent` (toolbar items, menu items, selection
 * actions).
 */
export interface EntriesDescriptor {
  prop: string;
  kind: AnyControlKind;
  callback: string;
  titleKey: string;
}

/**
 * How the generator reads one design-system component where a page uses it: what kind of
 * control it is, which of its props make it interactive, and where its schema, options, slots
 * and nested bindings come from. The component itself registers through `useAgentBinding` with
 * the same kind.
 */
export interface ControlDescriptor {
  /**
   * What a binding on the component itself makes. Absent when it binds only per slot or per
   * entry.
   */
  kind?: AnyControlKind;
  /**
   * Props whose presence makes a use interactive — a use with one of them must be bound. Empty:
   * always.
   */
  callbacks: readonly string[];
  /**
   * Props the schema is derived from, by `SchemaProps` key: the prop of the component each
   * comes from.
   */
  schemaProps?: SchemaPropSources;
  /** Where the options come from: the prop, and the keys of each option's value and title. */
  options?: OptionsSource;
  /** A composite with several callbacks: slot name → its kind and the callback it binds. */
  slots?: Readonly<Record<string, SlotDescriptor>>;
  entries?: EntriesDescriptor;
  /**
   * The control registers one binding per row it renders (a selectable grid), so its action
   * takes an `item`.
   */
  rows?: boolean;
  /**
   * A container: a dialog whose prop says whether it shows, or a tab set whose prop selects a
   * panel.
   */
  container?: {
    kind: 'dialog' | 'tabs';
    stateProp: string;
  };
  /**
   * What the schema props are when the page leaves them out, as the component defaults them.
   * The declared schema is the widest the control can take; the live one may only narrow it.
   */
  defaults?: SchemaProps;
  /**
   * It shows facts rather than taking input (a clip's parameters): a binding on it names what
   * it shows, and the page reports its facts by label. Its facts are the array prop
   * `itemsProp`, each labelled by `labelKey`. Not a control, so a use without a binding is not
   * unbound.
   */
  display?: {
    itemsProp: string;
    labelKey: string;
  };
  /** Props that give a default title, in order. `children` means the element's text. */
  titleProps: readonly string[];
}

/**
 * Where a control's options come from: the prop that holds them, and the keys of each option's
 * value and title.
 */
export interface OptionsSource {
  prop: string;
  value: string;
  title: string;
}

/**
 * What a package declares to the generator under the `oui` key of its `package.json` (ADR-0226
 * §2.2): its control table, its room catalog, and the components only the person may use.
 * During the transition the generator and the kit also read `closure.agentControls` and
 * `closure.agentCatalog`; a package declaring a key under both `oui` and `closure` is an error.
 */
export interface OuiPackageDeclaration {
  /** The path of the package's control table, relative to the package. */
  agentControls?: string;
  agentCatalog?: AgentCatalogManifestEntry;
  /**
   * Export name → why only the person may use it, such as the approval card (ADR-0228). The
   * generator refuses an `agent` binding on one.
   */
  personOnly?: Readonly<Record<string, string>>;
}

/**
 * Props a control's schema is derived from, by `SchemaProps` key (every key but `options`,
 * which `OptionsSource` gives): the prop of the component each comes from.
 */
export interface SchemaPropSources {
  min?: string;
  max?: string;
  step?: string;
  unit?: string;
  wrap?: string;
  minLength?: string;
  maxLength?: string;
  pattern?: string;
  inputType?: string;
  paintKinds?: string;
  allowNone?: string;
  clearable?: string;
  accept?: string;
}

// ─── A tier 2 mapping (ADR-0226 §2.3) ──────────────────────────────────────────
// https://schemas.closurestudio.ai/oui/v1/tier2-mapping.json

/**
 * A tier 2 mapping (ADR-0226 §2.3): how an app binds the controls of a third-party design
 * system it does not own (MUI, Mantine, shadcn/Radix). It is a declaration, not handler code:
 * `oui generate` emits one module per mapping into `<out>/bound/`. Each wrapper accepts
 * `agent`, calls `useAgentBinding` with the app's own callback, returns that callback's result
 * (§2.2 rule 3), and renders the third-party component unchanged. The emitted module ships its
 * own control table and is treated exactly like a tier 1 package. On an enforced page,
 * importing a mapped component straight from the third-party package fails the build.
 */
export interface Tier2Mapping {
  $schema?: string;
  /** The third-party package the controls are imported from (`@mantine/core`). */
  package: string;
  /** Each mapped export, by its export name in that package. */
  controls: Readonly<Record<string, Tier2Control>>;
}

/**
 * Where the new value is in the callback's arguments: `{ "arg": 0 }` for Mantine's
 * `onChange(value)`, `{ "arg": 1 }` for MUI's `onChange(event, value)`, and `{ "arg": 0,
 * "path": "target.value" }` for a native-style event. The wrapper builds those arguments when
 * the assistant sets the value, and reads them back when the person does.
 */
export interface ValueFrom {
  /** The argument's position. */
  arg: number;
  /** A dotted path into that argument. */
  path?: string;
}

/**
 * One part of a control exported under a namespace: the export path of that part
 * (`Select.Root`, `Select.Item`, `Tabs.Tab`). A path is an export of the package, or one member
 * of one (one dot at most).
 */
export interface Tier2Part {
  /**
   * The part's export path: an export of the package, or one member of it, dotted
   * (`Select.Item`).
   */
  export: string;
  /** On an item part: the prop that is the option's value. */
  valueProp?: string;
  /**
   * On an item part: the props, in order, that give the option's title. `children` means its
   * text.
   */
  titleProps?: readonly string[];
}

/**
 * One mapped control. The bound wrapper reports the component's `disabled` prop, so a control
 * the page disables is not offered (a disabled job control is still followed until its job
 * settles).
 */
export interface Tier2Control {
  kind: AnyControlKind;
  /**
   * Props whose presence makes a use interactive. The first is the one a binding runs: for a
   * value, with the arguments `valueFrom` describes; for a button or a dialog, with an
   * event-shaped argument whose `isTrusted` is false.
   */
  callbacks: readonly string[];
  /** Required for every kind that takes a value (all but `button` and `dialog`). */
  valueFrom?: ValueFrom;
  /**
   * The prop that shows the value. The generator reports every use of the control that does not
   * pass it: there the handler would run, but the control would not show the new value.
   */
  controlled?: string;
  /** Where the options come from: the prop, and the keys of each option's value and title. */
  options?: OptionsSource;
  /** Props that give a default title, in order. `children` means the element's text. */
  titleProps?: readonly string[];
  /** Props the value schema is derived from, by `SchemaProps` key. */
  schemaProps?: SchemaPropSources;
  /** What the schema props are when the app leaves them out, as the component defaults them. */
  defaults?: SchemaProps;
  /**
   * A control exported under a namespace (Radix `Switch.Root`) or made of parts (Radix
   * `Select.Root` / `Select.Item`, Mantine `Tabs` / `Tabs.Tab`): its `root`, which takes the
   * callbacks, and, when the options are the items it renders, its `item`. The bound module
   * keeps every other member of each namespace (`Select.Trigger`, `Tabs.List`).
   */
  parts?: {
    root: Tier2Part;
    item?: Tier2Part;
  };
}

// ─── A room catalog, as data (ADR-0220 §2.3) ───────────────────────────────────
// https://schemas.closurestudio.ai/oui/v1/room-catalog-data.json

/**
 * A room catalog as plain data (ADR-0220 §2.3, tier 3 of ADR-0226): what a room with its own
 * editing model — a canvas, a chart, a timeline, a player — declares about everything a person
 * can do in it, so the assistant's actions and knowledge are generated from the room's code.
 * Every declaration, none of the functions: a room's package writes it as `agent-catalog.json`
 * (named in `package.json` under `oui.agentCatalog`) so a build-time generator reads the
 * catalog without loading React or the room's code; an app's own catalog is read through the
 * app's Vite config.
 *
 * - **actions**: its operations, each carried out through the room's own reducer and commands,
 * with a JSON schema for the input;
 * - **fields**: its inspector's fields, each with its value's schema, unit, range, its
 * animation where the room has a timeline, and which kinds of thing it applies to;
 * - **commands**: its keymap, each command with its keys and what it does;
 * - **observations**: what the host reports about the room's state, including the problems it
 * has drawing it.
 *
 * A room derives each action's input from the schema its reducer already validates with
 * (`z.toJSONSchema`) and re-checks input with the same schema before applying it.
 */
export interface RoomCatalogData {
  /** The room's id: the surface id its assistant surface is published under (`room:<id>`). */
  room: string;
  title: string;
  /** What the room is for, in one or two sentences. */
  description: string;
  actions: readonly RoomActionData[];
  fields: readonly RoomFieldData[];
  commands: readonly RoomCommand[];
  observations: readonly RoomObservation[];
  /**
   * The kinds of problem it reports, in its own vocabulary. Default: the generic `problems`
   * schema.
   */
  problems?: readonly RoomProblemKind[];
  /** Tasks its tools carry out together, which only the room knows. */
  recipes?: readonly RoomRecipe[];
}

/**
 * What every catalog entry says about itself. Knowledge is generated from these words alone.
 */
export interface RoomEntryInfo {
  /** Stable, kebab-case, unique among the room's entries of its kind. */
  id: string;
  /** What the UI calls it: a button's label, a field's label, a command's name. */
  title: string;
  /** What it does, in a sentence or two, in the room's own terms. */
  description: string;
  /** Where a person does it: the tool, panel, button, key or gesture. */
  control: string;
}

/** One operation of the room, without its `run`. */
export interface RoomActionData extends RoomEntryInfo {
  kind: 'action';
  /**
   * An object schema: a tool's input is one, never a union at its top level. Its property
   * descriptions are the parameters' documentation.
   */
  input: JsonSchema;
  /**
   * What it changes: the document (`edit`), the selection, the view, files, backend data, a
   * job, a transaction.
   */
  effect: ActionEffect;
  /**
   * It removes or replaces something the person made; running it needs the person's approval
   * (ADR-0228).
   */
  destructive?: boolean;
}

/** Which inspector section a field is in, as the inspector titles it. */
export interface RoomSection {
  id: string;
  title: string;
}

/**
 * A field's animation, in a room with a timeline. Animation is a capability, not a requirement
 * (ADR-0226 §2.6).
 */
export interface RoomFieldAnimation {
  /** Set at the playhead, it is a keyframe there when the property is animated. */
  keyframeable: boolean;
}

/**
 * One inspector field, without its `read` and `write`: what it shows for the selection, and
 * what setting it does.
 */
export interface RoomFieldData extends RoomEntryInfo {
  kind: 'field';
  section: RoomSection;
  /**
   * The kinds of thing it applies to, in the room's vocabulary (`text`, `shape`, `artboard`…).
   */
  appliesTo: readonly string[];
  /**
   * The value's schema: its type, range (`minimum`/`maximum`), options (`enum`) and unit
   * (`x-unit`).
   */
  value: JsonSchema;
  /** How it animates, in a room with a timeline. A room without one leaves it out. */
  animation?: RoomFieldAnimation;
  /** Deprecated since oui-bindings 0.8: `animation: { keyframeable }`. Read for one minor. */
  keyframeable?: boolean;
}

/** One keymap command: what its key does. */
export interface RoomCommand extends RoomEntryInfo {
  kind: 'command';
  /** The group the room lists it under: tools, objects, edit, view. */
  group: string;
  /** Its keys as a person reads them (`⇧⌘G`). Empty when it has none. */
  keys: readonly string[];
  /**
   * `reserved`: its key is kept for a feature that is not built; it does nothing. Never
   * offered.
   */
  status: 'available' | 'reserved';
  /** Options the command takes beyond the selection (a nudge's direction). */
  options?: JsonSchema;
}

/**
 * Something the room reports about its state: the document, what is selected, or the problems
 * it has drawing it. The host pushes the value; the catalog declares what it means.
 */
export interface RoomObservation {
  id: string;
  description: string;
  schema: JsonSchema;
}

/**
 * One kind of problem a room or page reports, in its own vocabulary (`missing-font`,
 * `order-rejected`): the kind, and what it means.
 */
export interface RoomProblemKind {
  kind: string;
  description: string;
}

/**
 * A task the room's own tools carry out together, declared by the room because only it knows
 * the task (animating a property, placing an order). The generator turns it into a knowledge
 * recipe and ends it with reading what the room reports.
 *
 * In `name`, `trigger` and each step, `{room}` is the room's title, and these name the tool
 * that does a step, checked against the catalog when the knowledge is generated:
 * - `{action:<id>}`: the action's tool;
 * - `{command:<id>}`: the command, run with the `run-command` action;
 * - `{field:<id>}`: the field, set with the `set-properties` action;
 * - `{keyframeable}`: the ids of the fields that animate.
 */
export interface RoomRecipe {
  name: string;
  trigger: string;
  steps: readonly string[];
}

/**
 * A problem a room or page has drawing or reading what the person is working on: a face it
 * cannot load, text it therefore does not draw, an asset that failed, something an import could
 * not reproduce. Reported in a `problems` observation, so an assistant sees what the person
 * sees in the banners.
 */
export interface RoomProblem {
  /** `missing-font`, `font-error`, `unsupported-import`, `asset-failed`, `access-required`… */
  kind: string;
  /** The room's own words for it, as its banner says it. */
  message: string;
  /** Ids of the things not drawn because of it. */
  hides?: readonly string[];
  /**
   * How the person resolves it in the room: an action of this catalog, and the choices it
   * offers.
   */
  resolve?: {
    action: string;
    choices?: readonly Readonly<Record<string, unknown>>[];
  };
  /** Anything else that names the problem precisely (the face, the element). */
  detail?: Readonly<Record<string, unknown>>;
}

/**
 * One row an action changed: which list it is in, what addresses it, and everything about it
 * now.
 */
export interface RoomChangedRow {
  /**
   * The list it is a row of: `<observation id>/<list property>`, or `<observation id>` when the
   * observation itself is the list.
   */
  list: string;
  ref: string;
  /**
   * Everything about the row now, as `inspect` returns it. Left out when the row was removed,
   * and when an edit changed more rows than a result reports in full: `inspect` reads those.
   */
  detail?: Readonly<Record<string, unknown>>;
  /** The edit removed the row: nothing addresses it any more. */
  removed?: boolean;
}

/**
 * What running a catalog entry or a bound control did: its data, or why it could not be done,
 * in words a person would read. `pending` says the work outlives the call: a job was started
 * and is done only when its completion arrives (an action whose effect is `job` or
 * `transaction`). Every binding's `run` returns what the consumer's callback returned (ADR-0226
 * §2.2 rule 3, #209), so a handler's `{ ok, pending: { jobId } }` reaches the runtime.
 */
export type RoomResult = {
  ok: true;
  data?: Readonly<Record<string, unknown>>;
  pending?: {
    jobId: string;
  };
  /**
   * The rows it changed, added or removed, each as its list's reader reports it now (ADR-0244
   * §2.5): what the assistant checks its edit against, and the rows the page state keeps whole.
   */
  changed?: readonly RoomChangedRow[];
} | {
  ok: false;
  code: string;
  message: string;
};

/**
 * Where a room package names its catalog, under `oui.agentCatalog` in its `package.json`
 * (`closure.agentCatalog` is read during the transition). `hosts` are the exported components
 * that mount the room (and register it); a page that renders one has the room's surface.
 *
 * ```json
 * "oui": { "agentCatalog": { "path": "./dist/agent-catalog.json", "hosts": ["VectorStudioRoom"] } }
 * ```
 */
export interface AgentCatalogManifestEntry {
  path: string;
  hosts: string[];
}

// ─── The generated manifest ────────────────────────────────────────────────────
// https://schemas.closurestudio.ai/oui/v1/oui-manifest.json

/**
 * What the generator emits for each build (`oui-manifest.json`, ADR-0220 §2.4–2.5): every
 * surface, action and observation the build's UI offers. The runtime (`connectBindings`) offers
 * the intersection of the manifest and the handlers mounted right now, so an action the build
 * declares is a tool only while its control, or its room, is on screen. CI regenerates it and
 * diffs it (`oui generate --check`).
 */
export interface OuiManifest {
  /**
   * The contract major (`MANIFEST_VERSION`). A breaking change to any of these schemas bumps
   * it.
   */
  version: 1;
  /**
   * A hash of everything else in the manifest and the knowledge: the build's identity to the
   * assistant.
   */
  buildId: string;
  surfaces: readonly ManifestSurface[];
}

/** One step of the way a person reaches a capability. */
export type ReachStep = {
  kind: 'route';
  path: string;
  title: string;
  nav?: string;
} | {
  kind: 'tab';
  binding: string;
  value: string | number;
  title: string;
} | {
  kind: 'dialog';
  binding?: string;
  title: string;
  openedBy: readonly string[];
} | {
  kind: 'panel';
  title: string;
  openedBy: readonly string[];
} | {
  kind: 'menu';
  title: string;
} | {
  kind: 'room';
  room: string;
  where: string;
  selection?: readonly string[];
};

/**
 * Where an action comes from: a bound control, a room's catalog entry, or the generated
 * navigation.
 */
export type ManifestActionSource = 'control' | 'room-action' | 'navigation';

/** One action a surface offers: one tool. */
export interface ManifestAction {
  /** The tool name: unique across the build. */
  name: string;
  /** The binding id, or `<room>/<kind>/<entry>` for a room's. */
  id: string;
  source: ManifestActionSource;
  /** The control kind, for a control: a built-in one, or one its design system registers. */
  control?: AnyControlKind;
  title: string;
  description: string;
  /** The tool's input: one object schema, never a union at its top level. */
  input: JsonSchema;
  /**
   * What running it does. A `job` or `transaction` settles on its outcome (`JobSettlement`); a
   * `transaction`, or a destructive `write`, runs only on the person's approval of the exact
   * call.
   */
  effect?: ActionEffect;
  destructive?: boolean;
  /**
   * It changes what the person is working in (account, project, role): the assistant asks
   * first.
   */
  confirm?: boolean;
  /** One of a list's rows: the action takes the row as `item`. */
  itemized?: boolean;
  /** How a person gets to it, from the page. */
  reach: readonly ReachStep[];
  /** The source file that declares it, relative to the app. */
  declaredIn?: string;
}

/** One observation a surface reports: its id, what it means, and its value's schema. */
export interface ManifestObservation {
  id: string;
  description: string;
  schema: JsonSchema;
}

/**
 * A page, a room on a page, a component shared by pages, the app's frame around the pages
 * (`shell`, from `oui.config.json`'s `shell` entries), or the app's pages themselves: going to
 * one by address (`navigation`).
 */
export type ManifestSurfaceKind = 'page' | 'room' | 'shared' | 'shell' | 'navigation';

/** One surface: what it offers, where it can be mounted, and what it reports. */
export interface ManifestSurface {
  /**
   * `page:VoicesPage`, `room:vector-studio`, `shared:MoveToProjectModal`, `shell:StudioShell`,
   * `app:navigation`.
   */
  id: string;
  kind: ManifestSurfaceKind;
  title: string;
  description: string;
  /** The route patterns where it can be mounted. */
  routes: readonly string[];
  actions: readonly ManifestAction[];
  observations: readonly ManifestObservation[];
}

// ─── The generated knowledge ───────────────────────────────────────────────────
// https://schemas.closurestudio.ai/oui/v1/generated-knowledge.json

/**
 * The knowledge the generator emits with the manifest (`oui-knowledge.json`, ADR-0220 §2.5),
 * from the same declarations: the map of the app, every page in full with its relationships and
 * recipes, and the app's frame. No word of it is written by hand. Each turn carries the part
 * for the page the person is on (`resolveKnowledge`): the map, the frame parts around that
 * page, the page in full, and one paragraph for each adjacent page.
 */
export interface GeneratedKnowledge {
  /** The contract major (`MANIFEST_VERSION`). */
  version: 1;
  /** The manifest's build id: the two are one build. */
  buildId: string;
  /** Every page, one line each: the map of the app. */
  overview: KnowledgeEntry;
  pages: readonly PageKnowledge[];
  /**
   * The app's frame around the pages (`shell` surfaces), each part with the route patterns it
   * frames.
   */
  frames?: readonly PageKnowledge[];
}

/** One block of knowledge, as the assistant's prompt shows it. */
export interface KnowledgeEntry {
  title: string;
  content: string;
}

/** A task recipe the UI implies, as the assistant's prompt shows a workflow. */
export interface KnowledgeRecipe {
  name: string;
  trigger: string;
  steps: readonly string[];
}

/** What the assistant knows of one page, or one part of the app's frame. */
export interface PageKnowledge {
  /** The page surface this describes. */
  surface: string;
  routes: readonly string[];
  /** One paragraph: what the page is for, for when the user is elsewhere. */
  summary: KnowledgeEntry;
  /** Everything the page and its rooms offer, where each thing is, and its parameters. */
  detail: KnowledgeEntry;
  /**
   * Relationships derived from types: which fields apply to what, which animate, what leads
   * where.
   */
  relationships: KnowledgeEntry | null;
  recipes: readonly KnowledgeRecipe[];
  /** Page surfaces this page leads to or is reached from. */
  adjacent: readonly string[];
}

// ─── `oui.config.json` (ADR-0226 §2.4) ─────────────────────────────────────────
// https://schemas.closurestudio.ai/oui/v1/oui-config.json

/**
 * `oui.config.json` at the app's root (ADR-0226 §2.4): where the app keeps its routes,
 * navigation and output, which design systems and mappings its controls come from, where its
 * API is described, and which of its pages are not yet bound. Paths are relative to the file.
 * It is required and explicit: nothing an app depends on has a default, so a misconfigured app
 * fails here, naming the setting, instead of generating an assistant that can do nothing. A
 * setting the generator does not know is an error.
 */
export interface OuiConfigFile {
  /** This schema's URL, for editors. */
  $schema?: string;
  $comment?: string;
  /** The tsconfig the app's source compiles with. */
  tsconfig: string;
  /**
   * The file whose routes decide where the app can go: `<Route>` elements (nested paths are
   * joined to their parent, `index` routes kept, `React.lazy` followed) or a data router
   * (`createBrowserRouter([...])`).
   */
  routes: string;
  /**
   * Components a route's element is wrapped in that are never the page (`Suspense`,
   * `ErrorBoundary`). Default none.
   */
  routeWrappers?: readonly string[];
  /**
   * Files holding the navigation entries (`{ label, route, group }` object literals). Default
   * none.
   */
  nav?: readonly string[];
  /** Where generated output goes. */
  out: string;
  /**
   * Design-system packages whose controls carry bindings (tier 1). Each must resolve from the
   * app and name its control table in its `package.json` (`oui.agentControls`). `[]`: every
   * control is tier 2 or in a room.
   */
  designSystem: readonly string[];
  /**
   * Tier 2 mappings (`tier2-mapping.json`), one per third-party design system the app does not
   * own, by path. `oui generate` emits a bound module per mapping into `<out>/bound/` (named
   * after the package: `@mantine/core` → `mantine-core.ts`, with its control table beside it),
   * and reads every use of a bound control as it reads a tier 1 control. On an enforced page,
   * importing a mapped control straight from its package is an error naming the bound import. A
   * package is in `designSystem` or mapped, never both. Default none.
   */
  mappings?: readonly string[];
  /**
   * The API's OpenAPI 3 document, by module path, as the installed API client ships it
   * (`@traidr/api-client/openapi.json`) — never a sibling checkout path, so the generator reads
   * exactly the spec of the client version the app installs; or a path inside the app. Every
   * `mutate` effect names one of its `operationId`s. `null`: the app declares no API, and a
   * `mutate` effect is an error.
   */
  apiSpec: string | null;
  /**
   * Page components whose interactive controls are not all bound yet. It may only get shorter:
   * the generator fails for a listed page that is fully bound, so the list cannot rot. Every
   * other page is enforced. Default none.
   */
  unbound?: readonly string[];
  /**
   * Room catalogs the app itself declares (tier 3, a page's own editor), each loaded through
   * the app's own Vite config so its modules resolve as the app build resolves them: the app
   * needs `vite` among its own dependencies. Only their declarations are read. Default none.
   */
  appCatalogs?: readonly AppCatalogEntry[];
  /**
   * The app's frame: components mounted around the pages rather than by a route (a sidebar, a
   * top bar, a phone tab bar, a toast host). Each becomes a `shell:` surface offered on the
   * routes it frames, and its controls are enforced as a page's are, unless listed in
   * `unbound`. Default none.
   */
  shell?: readonly ShellEntry[];
}

/** One part of the app's frame. */
export interface ShellEntry {
  /** The module, relative to the app root. */
  module: string;
  /** The export that is the frame's component. */
  export: string;
  /** The route patterns it frames. Default every route (`*`). */
  routes?: readonly string[];
}

/** A room catalog the app declares. */
export interface AppCatalogEntry {
  /** The module, relative to the app root. */
  module: string;
  /** The export that is the catalog. */
  export: string;
  /** App components whose use puts the room on a page. */
  hosts: readonly string[];
}

// ─── Approvals (ADR-0228) ──────────────────────────────────────────────────────
// https://schemas.closurestudio.ai/oui/v1/approvals.json

/** SHA-256 of the RFC 8785 canonical JSON of a call's arguments, lowercase hex. */
export type ArgsHash = string;

/**
 * Where the person confirmed. In a UI only a click on the card counts (`ui`); in a conversation
 * channel, the verbatim readback and an affirmative next turn (ADR-0210 §2.6).
 */
export type ApprovalChannel = 'ui' | 'voice' | 'phone' | 'sms' | 'chat';

export type ApprovalDecision = 'approve' | 'decline';

/**
 * One argument of the call, as the person reads it: its declared label and its value in words.
 */
export interface ApprovalPreviewArgument {
  /** The argument's name in the call. */
  name: string;
  /** Its label, from the action's input schema. */
  label: string;
  /** Its value, as text. */
  value: string;
}

/**
 * What the person is asked to approve. Every word comes from the action's declaration (its
 * title, description and input schema labels), never from the model (ADR-0228 §2.2).
 */
export interface ApprovalPreview {
  title: string;
  /** What running it does, from the declaration. */
  consequence?: string;
  arguments: Array<ApprovalPreviewArgument>;
  /**
   * One sentence composed from the fields above, read or sent verbatim on a conversation
   * channel.
   */
  readback: string;
}

/**
 * The effect the approval is for: the action's declared effect kind (ADR-0226 §2.6,
 * `transaction` for an irreversible external act), or `write` when it declares none.
 */
export type ApprovalEffect = string;

/**
 * A call waiting for the person's approval, as the worker stores it (`POST
 * /internal/approvals`).
 */
export interface PendingApprovalInput {
  /** Equals the tool call id. */
  approvalId: string;
  toolCallId: string;
  conversationId: string;
  turnId: string;
  /** The user whose turn made the call: the only one who may decide it. */
  userId: string;
  tool: string;
  args: {
    [key: string]: unknown;
  };
  /** `argsHash(args)`; the store checks it. */
  argsHash: ArgsHash;
  effect: ApprovalEffect;
  destructive: boolean;
  /**
   * Whether the arguments may be written to logs. They are only when the declaration says they
   * are not sensitive.
   */
  argsSensitive: boolean;
  /** Epoch ms, at most 30 minutes away (`MAX_APPROVAL_TTL_MS`). */
  expiresAt: number;
  preview: ApprovalPreview;
}

/**
 * `agent:approval_required`: the worker stopped the turn at a call that needs the person's
 * approval. The approval card renders it.
 */
export interface ApprovalRequiredEvent {
  turnId: string;
  conversationId: string;
  approvalId: string;
  tool: string;
  effect: ApprovalEffect;
  destructive: boolean;
  preview: ApprovalPreview;
  expiresAt: number;
  timestamp: number;
}

/** `approval:decide`, from the person's own socket: the card's click. */
export interface ApprovalDecidePayload {
  approvalId: string;
  decision: ApprovalDecision;
}

/**
 * Why an approval was refused:
 *
 * - `unknown`: no such pending approval: never stored, already declined or redeemed, or expired
 * and gone.
 * - `forbidden`: another user's approval, or another conversation's.
 * - `expired`.
 * - `decided`: already decided.
 * - `used`: already redeemed.
 * - `invalid`: not a token this environment signed, or malformed.
 * - `mismatch`: signed, but not for the stored call.
 * - `channel`: a decision from a channel that may not make it.
 */
export type ApprovalRefusalReason = 'unknown' | 'forbidden' | 'expired' | 'decided' | 'used' | 'invalid' | 'mismatch' | 'channel';

export interface ApprovalRefusal {
  ok: false;
  reason: ApprovalRefusalReason;
  error: string;
}

/**
 * The answer to a decision. An approval's token goes only to the decider: the socket that
 * clicked, or the engine that asked.
 */
export type ApprovalDecideResult = {
  ok: true;
  decision: 'approve';
  approvalId: string;
  /** The single-use token the continuation turn redeems. */
  token: string;
  /** What the browser checks a UI action's params against before it runs it. */
  argsHash: ArgsHash;
  expiresAt: number;
  channel: ApprovalChannel;
} | {
  ok: true;
  decision: 'decline';
  approvalId: string;
} | ApprovalRefusal;

/** The token's claims: a compact JWS (HS256), signed with the environment's approval key. */
export interface ApprovalTokenClaims {
  /** The approval id, which is the tool call id. */
  aid: string;
  /** The user. */
  sub: string;
  /** The conversation. */
  cid: string;
  tool: string;
  /** The args hash. */
  ah: ArgsHash;
  /** The effect. */
  eff: ApprovalEffect;
  /** Where the user confirmed. */
  ch: ApprovalChannel;
  /** Issued at, epoch seconds. */
  iat: number;
  /** Expires at, epoch seconds. */
  exp: number;
  /** A nonce. */
  jti: string;
}

/** What redeeming a token returns: the stored call, exactly, for the worker to run. */
export interface ApprovedCall {
  approvalId: string;
  toolCallId: string;
  conversationId: string;
  turnId: string;
  userId: string;
  tool: string;
  args: {
    [key: string]: unknown;
  };
  argsHash: ArgsHash;
  effect: ApprovalEffect;
  destructive: boolean;
  channel: ApprovalChannel;
}

export type ApprovalRedeemResult = {
  ok: true;
  call: ApprovedCall;
} | ApprovalRefusal;

/** An approval's state, for the turn that follows a decision. */
export interface ApprovalStatus {
  approvalId: string;
  status: 'pending' | 'approved' | 'declined';
  tool: string;
  title: string;
}

/**
 * What a turn that follows a decision carries, outside the message text: the token to redeem,
 * or that the person declined.
 */
export type ApprovalContinuation = {
  approvalId: string;
  decision: 'approve';
  token: string;
} | {
  approvalId: string;
  decision: 'decline';
};

/**
 * What a UI action request carries when it runs an approved call (`OUIActionApproval`): the
 * browser runs a `transaction` or destructive action only when this matches a grant this tab
 * received from its own card click (ADR-0228 §2.2.6).
 */
export interface ActionRequestApproval {
  approvalId: string;
  /** `argsHash(params)` of the request the user approved. */
  argsHash: ArgsHash;
}

/**
 * What the person's approval click gives this tab's OUI runtime (`runtime.grantApproval`,
 * `OUIApprovalGrant`): the request it approved, until it expires.
 */
export interface ApprovalGrant {
  approvalId: string;
  argsHash: ArgsHash;
  /** Epoch ms after which the grant no longer admits anything. */
  expiresAt: number;
}

// ─── Event declarations (ADR-0227 §2.4) ────────────────────────────────────────
// https://schemas.closurestudio.ai/agent-sdk/event-declarations/v1.json

/**
 * Every event a product emits over realtime: its payload schema, the rooms it is published to,
 * its correlation fields and its role in a job (ADR-0227 §2.4).
 */
export interface EventDeclarationDocument {
  $schema?: string;
  /** The version of this document's format. */
  version: 1;
  /** Who declares these events. */
  product: string;
  description?: string;
  /** Payload shapes the events share, referenced as `#/$defs/<Name>`. */
  $defs?: Readonly<Record<string, EventPayloadSchema>>;
  /** Every room these events go to, by name. */
  rooms: Readonly<Record<string, RoomDeclaration>>;
  /** Every event, by its name on the wire. */
  events: Readonly<Record<string, EventDeclaration>>;
}

/** The JSON Schema types a payload may use. */
export type JsonType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';

/**
 * A JSON Schema (draft 2020-12). A payload may use any keyword; the platform reads `$ref` (to
 * the document's `$defs`), `allOf`, `type`, `properties` and `required` to find the fields it
 * correlates and reports on, and validates the rest with a full validator.
 */
export interface EventPayloadSchema {
  $ref?: string;
  /** A JSON Schema type name, or a list of them. */
  type?: JsonType | readonly JsonType[];
  description?: string;
  properties?: Readonly<Record<string, EventPayloadSchema>>;
  required?: readonly string[];
  /** `false`, or the schema every other property follows. */
  additionalProperties?: boolean | EventPayloadSchema;
  items?: EventPayloadSchema;
  enum?: readonly unknown[];
  const?: unknown;
  allOf?: readonly EventPayloadSchema[];
  anyOf?: readonly EventPayloadSchema[];
  oneOf?: readonly EventPayloadSchema[];
  [key: string]: unknown;
}

export interface RoomDeclaration {
  /**
   * The room's name with `{placeholder}`s for its ids, e.g. `generation:{jobId}`. An id is
   * letters, digits, `_` and `-`.
   */
  pattern: string;
  description?: string;
}

/**
 * What an event is for, as the platform acts on it:
 * - `completion`: a job of kind `completes` produced its result. A wait on the job ends well.
 * - `failure`: a job of kind `completes` ended without a result. A wait on the job ends with
 * its reason.
 * - `progress`: a job is still running. Nothing waits on it: resolving a wait on progress
 * reports a running job as done.
 * - `notice`: anything else a client is told.
 */
export type EventRole = 'completion' | 'failure' | 'progress' | 'notice';

/** Where a settling event says why a job failed. */
export interface FailureReason {
  /** The payload field carrying the reason. */
  field: string;
  /** What the reason is when the field is absent. */
  fallback: string;
}

export interface EventDeclaration {
  description: string;
  /**
   * The payload's JSON Schema: an object. `$ref`s point into the document's `$defs`. Every
   * correlation, result and reason field is one of its properties.
   */
  payload: EventPayloadSchema;
  /**
   * The name generated code gives the payload type. Default: the event name in PascalCase
   * (`generation:completed` → `GenerationCompleted`).
   */
  typeName?: string;
  /**
   * The rooms the event is published to: names from the document's `rooms`; `turn` for the room
   * of the agent turn it belongs to (the host names that room in each turn); or `conversation`
   * for the room of the conversation it belongs to (the host names that room too).
   */
  rooms: readonly string[];
  /**
   * The payload fields that say which job, or which resource, the event is about (e.g.
   * `jobId`). A completion or failure has exactly one.
   */
  correlation: readonly string[];
  role: EventRole;
  /** For a completion or failure: the kind of job it settles. */
  completes?: string;
  /**
   * For a completion: the payload fields that are the job's result, as a follower reports them.
   */
  result?: readonly string[];
  /** For a failure: where its reason is. */
  reason?: FailureReason;
}

// ─── Conversation takeover (ADR-0260 §2) ───────────────────────────────────────
// https://schemas.closurestudio.ai/oui/v1/conversation-takeover.json

/**
 * A person on the product's staff, as the conversation names them. `displayName` and `role` are
 * shown to the customer; `userId` is what a hand-back and a staff message are checked against.
 * It reaches the customer's tab, so name an id you are content to show (an opaque staff id).
 */
export interface StaffSpeaker {
  /** The staff member's id, as the product's realtime identity names them. */
  userId: string;
  /** The name the customer sees ("Jordan"). */
  displayName: string;
  /** What the customer sees beside the name ("Toyota of Quillhaven sales"). */
  role?: string;
}

/**
 * A conversation a person holds: the agent does not answer it until it is handed back. One
 * holder at a time.
 */
export interface ConversationHold {
  conversationId: string;
  holder: StaffSpeaker;
  /** When it was taken, epoch ms by the realtime server's clock. */
  since: number;
}

/**
 * A conversation changing hands, as its stored entry and its event say: `taken_over` by a
 * person, `handed_back` to the agent.
 */
export type TakeoverChange = 'taken_over' | 'handed_back';

/**
 * Who ended a hold: the person who held it (`holder`), or the product on its own authority
 * (`product`: an idle policy, a manager, the end of a shift).
 */
export type HandBackCause = 'holder' | 'product';

/**
 * Who wrote a message of the conversation: the customer (`user`), the agent (`assistant`), or a
 * person on the staff (`staff`).
 */
export type ConversationMessageRole = 'user' | 'assistant' | 'staff';

/** A stored message of the conversation, as it is announced to the people watching it. */
export interface ConversationMessage {
  /** The product's id for the stored message. */
  id: string;
  role: ConversationMessageRole;
  content: string;
  /** When it was stored, ISO 8601. */
  createdAt: string;
  /** Set on a `staff` message: who wrote it. */
  speaker?: StaffSpeaker;
}

/**
 * Where a conversation's event goes: the conversation's room, which the product names and
 * guards with a room token, and any of the product's own (a team's board).
 */
export type ConversationRooms = Array<string>;

/**
 * `POST /internal/conversations/{conversationId}/hold`, from the product's API after its own
 * check that this person may take this conversation.
 */
export interface TakeOverRequest {
  holder: StaffSpeaker;
  rooms: ConversationRooms;
}

/**
 * The answer to a take-over: `taken_over` the first time, `already` when this holder had it;
 * 409 `held` when someone else holds it.
 */
export type TakeOverResult = {
  ok: true;
  change: 'taken_over' | 'already';
  hold: ConversationHold;
} | {
  ok: false;
  reason: 'held';
  hold: ConversationHold;
};

/**
 * `POST /internal/conversations/{conversationId}/hold/release`. With `userId`, only the holder
 * may hand it back; without it, the product releases it on its own authority.
 */
export interface HandBackRequest {
  /** The staff member handing it back; must be the holder. */
  userId?: string;
  rooms: ConversationRooms;
}

/**
 * The answer to a hand-back: `handed_back` with the hold that ended, `not_held` when nobody
 * held it; 409 `not_holder` when someone else holds it.
 */
export type HandBackResult = {
  ok: true;
  change: 'handed_back';
  hold: ConversationHold;
  by: HandBackCause;
} | {
  ok: true;
  change: 'not_held';
} | {
  ok: false;
  reason: 'not_holder';
  hold: ConversationHold;
};

/**
 * `POST /internal/conversations/{conversationId}/messages`: a message the product has stored,
 * for the people watching the conversation. A `staff` message is announced only while its
 * speaker holds the conversation.
 */
export interface AnnounceMessageRequest {
  message: ConversationMessage;
  rooms: ConversationRooms;
}

/**
 * The answer to an announcement: sent, or 409 because its staff speaker does not hold the
 * conversation (`not_held`: nobody does; `not_holder`: someone else does).
 */
export type AnnounceMessageResult = {
  ok: true;
} | {
  ok: false;
  reason: 'not_held' | 'not_holder';
};

/**
 * `agent:conversation_taken_over`, to the conversation's room: a person took it, and the agent
 * stopped answering.
 */
export interface ConversationTakenOverEvent {
  conversationId: string;
  hold: ConversationHold;
  /** Epoch ms. */
  at: number;
}

/**
 * `agent:conversation_handed_back`, to the conversation's room: the hold ended, and the agent
 * answers again.
 */
export interface ConversationHandedBackEvent {
  conversationId: string;
  /** The hold that ended. */
  hold: ConversationHold;
  by: HandBackCause;
  /** Epoch ms. */
  at: number;
}

/**
 * `agent:conversation_message`, to the conversation's room: a message the product stored, for
 * the people watching.
 */
export interface ConversationMessageEvent {
  conversationId: string;
  message: ConversationMessage;
  /** Epoch ms. */
  at: number;
}

// ─── Agent eval scenarios (ADR-0260 §3) ────────────────────────────────────────
// https://schemas.closurestudio.ai/oui/v1/agent-evals.json

/**
 * A suite of agent eval scenarios, written as data (ADR-0260 §3): what a customer says, turn by
 * turn, and what must hold after each turn. `@ouispec/agent-evals` runs every scenario on every
 * channel the suite names, against the product's real agent configuration (persona, tools, tool
 * policy, turn policy), from recorded model responses in CI or against the live model, and
 * fails on any assertion that does not hold.
 */
export interface AgentEvalSuite {
  /** The suite format's version. */
  version: 1;
  /** The suite's name, as reports show it. */
  name: string;
  description?: string;
  /**
   * The channels every scenario runs on, as the eval configuration names them (`web_chat`,
   * `sms`, `voice`). Default: every channel the configuration names.
   */
  channels?: AgentEvalChannelList;
  /**
   * What every turn of every scenario carries as its context, before the channel's and the
   * scenario's own.
   */
  context?: Readonly<Record<string, unknown>>;
  /** What each tool returns, for every scenario; a scenario's own stubs come first. */
  stubs?: AgentEvalStubs;
  scenarios: readonly AgentEvalScenario[];
}

/** Channel names, as the eval configuration names them. */
export type AgentEvalChannelList = readonly string[];

/** One conversation: its turns in order, and what must hold after each. */
export interface AgentEvalScenario {
  /** Unique in the suite; names its recordings. */
  id: string;
  /** What it shows, as reports name it. */
  title: string;
  description?: string;
  /** The suite's channels this scenario runs on, when not all of them. */
  channels?: AgentEvalChannelList;
  /** What each of its turns carries as its context, after the suite's and the channel's. */
  context?: Readonly<Record<string, unknown>>;
  /** What each tool returns in this scenario, before the suite's stubs. */
  stubs?: AgentEvalStubs;
  turns: readonly AgentEvalTurn[];
}

/**
 * One step of a scenario: the customer says something, answers the waiting approval, or a
 * person on the staff acts.
 */
export type AgentEvalTurn = AgentEvalUserTurn | AgentEvalApprovalTurn | AgentEvalStaffTurn;

/** The customer's message: the agent's turn runs, and its expectations are checked. */
export interface AgentEvalUserTurn {
  user: string;
  expect?: AgentEvalExpectation;
  expectOn?: AgentEvalExpectationsByChannel;
}

/**
 * The customer's answer to the approval the last turn stopped at, decided on the channel's
 * approval channel (the card on `ui`; the readback and an affirmative message on a conversation
 * channel). The continuation turn runs, and its expectations are checked.
 */
export interface AgentEvalApprovalTurn {
  approval: 'approve' | 'decline';
  expect?: AgentEvalExpectation;
  expectOn?: AgentEvalExpectationsByChannel;
}

/**
 * A person on the staff takes the conversation over, writes to the customer, or hands it back
 * (ADR-0260 §2). No agent turn runs.
 */
export interface AgentEvalStaffTurn {
  staff: {
    takeOver: {
      displayName: string;
      role?: string;
      /** Default: `staff-` and the display name. */
      userId?: string;
    };
  } | {
    say: string;
  } | {
    handBack: true;
  };
}

/**
 * What a reply's text is matched against: a string, found anywhere in it, ignoring case; a
 * regular expression (`pattern`, with `flags`); or a `rubric`, which a judge model decides.
 */
export type AgentEvalTextMatcher = string | {
  pattern: string;
  /** Regular-expression flags among `i`, `m`, `s` and `u`. */
  flags?: string;
} | {
  /** What the reply must do, in a sentence a judge reads. */
  rubric: string;
};

/**
 * A tool the agent called: its name, and arguments its call holds (a subset: every key given,
 * with an equal value; nested objects as subsets too).
 */
export interface AgentEvalToolCall {
  name: string;
  args?: Readonly<Record<string, unknown>>;
}

/**
 * The turn stopped at a call that needs the customer's approval (ADR-0228), with a readback
 * present.
 */
export interface AgentEvalApprovalExpectation {
  tool?: string;
  /** A subset of the call's arguments. */
  args?: Readonly<Record<string, unknown>>;
  /** What the readback must say. */
  readback?: AgentEvalTextMatcher;
}

/** What must hold after a turn. Every field given must hold. */
export interface AgentEvalExpectation {
  /** Each must match the reply. */
  says?: readonly AgentEvalTextMatcher[];
  /** None may match the reply. */
  mustNotSay?: readonly AgentEvalTextMatcher[];
  /** Each was called, with these arguments. */
  toolCalled?: readonly AgentEvalToolCall[];
  /** None of these was called; `*` means no tool at all. */
  toolNotCalled?: readonly string[];
  /**
   * The turn stopped for the customer's approval of this call; `false`: it did not stop for
   * any.
   */
  approvalRequested?: false | AgentEvalApprovalExpectation;
  /**
   * The reply declines: `true` for the usual phrasing of a refusal (can't, cannot, unable, not
   * able, won't, not allowed), or a matcher for the agent's own words.
   */
  refusal?: true | AgentEvalTextMatcher;
  /**
   * None of these appears in anything the turn stored: its text, its tool calls' arguments, its
   * tool results.
   */
  doesNotStore?: readonly AgentEvalTextMatcher[];
  /**
   * `true`: the turn ran no model call, because a person held the conversation (ADR-0260 §2.3).
   */
  held?: boolean;
}

/** What must also hold on one channel, by its name. */
export type AgentEvalExpectationsByChannel = Readonly<Record<string, AgentEvalExpectation>>;

/**
 * What a tool returns when it is called with arguments that hold `when` (a subset; absent: any
 * call).
 */
export interface AgentEvalStubCase {
  when?: Readonly<Record<string, unknown>>;
  result: {
    success: boolean;
    data?: unknown;
    error?: string;
  };
}

/**
 * What each tool returns, by tool name: its cases in order, the first that matches the call
 * wins. A call to a tool with no matching case fails the scenario: an eval never reaches a real
 * backend.
 */
export type AgentEvalStubs = Readonly<Record<string, readonly AgentEvalStubCase[]>>;

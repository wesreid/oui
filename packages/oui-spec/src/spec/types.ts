import type { OUIActionApproval, OUIEffectKind } from "./approval.js";

/**
 * OUI — Open UI Specification
 *
 * The machine-readable contract for agent-controllable user interfaces.
 * Any UI application that implements this interface can be controlled by
 * any OUI-compatible agent runtime.
 */

/** JSON Schema type (subset used by OUI) */
export type JSONSchema = {
  type?: string | string[];
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  required?: string[];
  enum?: (string | number | boolean)[];
  description?: string;
  default?: unknown;
  oneOf?: JSONSchema[];
  anyOf?: JSONSchema[];
  allOf?: JSONSchema[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  additionalProperties?: boolean | JSONSchema;
  title?: string;
  /** Annotations (`x-unit`, `x-rows`, …) a product's contract adds; OUI carries them unread. */
  [annotation: `x-${string}`]: unknown;
};

/**
 * A Surface is a controllable boundary within an application.
 * It declares what an agent can do (actions), what it can observe (state),
 * and when it's available (activation conditions).
 *
 * Think of it as "one page" or "one feature" of an application, described
 * in a way that an agent can understand and operate.
 */
export interface OUISurface {
  /** Unique identifier for this surface (e.g., 'dataviz-wizard', 'document-editor') */
  id: string;

  /** Human-readable name */
  name: string;

  /** Description of what this surface does — included in agent context */
  description: string;

  /** Version of this surface's contract (semver) */
  version?: string;

  /** Actions the agent can invoke on this surface */
  actions: OUIAction[];

  /** Observable state the agent can read */
  observations?: OUIObservation[];

  /** When this surface is active/available */
  activation?: OUIActivation;

  /** Additional metadata for agent context */
  metadata?: Record<string, unknown>;
}

/**
 * Declarative polling configuration for async actions.
 * The OUI runtime in the browser manages the polling lifecycle automatically
 * after the action handler returns its dispatch result.
 */
export interface OUIActionPolling {
  /** How often to check (milliseconds) */
  intervalMs: number;

  /** Max poll attempts before giving up (optional) */
  maxAttempts?: number;

  /** Max total duration before giving up in ms (alternative to maxAttempts) */
  maxDurationMs?: number;

  /**
   * Subscribe to a realtime event instead of polling.
   * If provided, the runtime listens for this event instead of using setInterval.
   * More efficient when realtime infrastructure exists.
   */
  subscribe?: {
    /** Event name to listen for */
    event: string;
    /**
     * Filter to match the event. Values prefixed with '$dispatchResult.'
     * are resolved from the handler's return value.
     * Example: { jobId: '$dispatchResult.jobId' }
     */
    filter?: Record<string, unknown>;
  };
}

/**
 * An Action is a single operation an agent can perform on a surface.
 * Each action becomes a "tool" that the LLM can call.
 *
 * The action's handler executes in the UI (or API) and returns a result
 * that the agent sees as the tool's output.
 */
export interface OUIAction {
  /** Unique action identifier (becomes the tool name) */
  id: string;

  /** Human-readable description — this is what the LLM reads to decide when to use it */
  description: string;

  /** The action's name as a person reads it, for a confirmation the user approves. */
  title?: string;

  /**
   * What using the action does. A `transaction` runs only on the user's
   * approval of the exact request (see `requiresApproval`). Undeclared counts
   * as a write.
   */
  effect?: OUIEffectKind;

  /** JSON Schema for the action's input parameters */
  input: JSONSchema;

  /** JSON Schema for the action's return value (optional — agent still gets the result) */
  output?: JSONSchema;

  /**
   * Destructive: the action removes or replaces something the person made.
   * Unless its effect only reads, it runs only on the user's approval of the
   * exact request, which the surface runtime checks before it runs.
   */
  confirm?: boolean;

  /** If true, the action is async — returns immediately with a job/tracking ID */
  async?: boolean;

  /** Declarative polling configuration — runtime manages the polling lifecycle after dispatch */
  polling?: OUIActionPolling;

  /** Human-readable hint about when this action is appropriate to use */
  usage?: string;

  /**
   * Preconditions that should be met before this action is called.
   * Expressed as a description (for the LLM) not as executable logic.
   */
  preconditions?: string;

  /** Estimated duration hint (e.g., "instant", "2-5s", "30-120s") */
  estimatedDuration?: string;

  /** Tags for categorization */
  tags?: string[];
}

/**
 * An Observation is a piece of application state that the agent can read.
 * Observations are pushed to the agent in real-time as the app state changes,
 * giving it situational awareness without needing screenshots.
 */
export interface OUIObservation {
  /** Unique identifier for this observation */
  id: string;

  /** Description of what this observation represents */
  description: string;

  /** JSON Schema for the observation's value */
  schema: JSONSchema;

  /** How frequently this observation updates */
  updateFrequency?: "realtime" | "on-change" | "polling";
}

/**
 * Activation conditions — when a surface is available to the agent.
 * A surface might only be active on a specific page, when certain
 * entities are loaded, or under specific application states.
 */
export interface OUIActivation {
  /** URL path(s) where this surface is active */
  routes?: string | string[];

  /** Entity type/ID that must be present for this surface to activate */
  entity?: {
    type: string;
    id?: string;
  };

  /** Custom predicate description (for documentation, not execution) */
  condition?: string;
}

// ─── Index form (§7.3.8) ───────────────────────────────────────────────────────

/**
 * One action as a snapshot and an answer carry it: enough to choose it and to
 * know what it takes in outline, without its definition. A page's actions
 * weigh what its whole catalogue weighs (on a studio page, several hundred
 * KB), and an agent runtime that received every definition could neither be
 * sent them in one frame nor give them all to its model. The definition of an
 * action is fetched when it is needed (`oui.describe`, §7.3.10).
 */
export interface OUIActionIndexEntry {
  /** The action's id. */
  id: string;
  /** Its name as a person reads it. */
  title?: string;
  /** The first sentence of its description, at most `INDEX_DESCRIPTION_CHARS` characters. */
  description: string;
  effect?: OUIEffectKind;
  confirm?: boolean;
  async?: boolean;
  estimatedDuration?: string;
  /** For an async action: how long its work is followed before it is reported as not finished. */
  maxDurationMs?: number;
  /** What it takes, in one line (`summarizeInput`): "none", "value: number 0–100", "clipId, start?, +4 more". */
  input: string;
  /** A hash of the full definition: a fetched definition is good until this changes. */
  definitionHash: string;
  /** The full definition's size in bytes of JSON, so a reader knows to ask for it in outline. */
  definitionBytes: number;
}

/** A surface as a snapshot and an answer carry it in index form: its actions as index entries. */
export interface OUISurfaceIndex {
  id: string;
  name: string;
  description: string;
  version?: string;
  /** Observation definitions travel whole: they are small, and say how to read the values that follow. */
  observations?: OUIObservation[];
  index: OUIActionIndexEntry[];
}

/**
 * One place where a snapshot's or an answer's observations were shortened to
 * fit its byte budget (§7.3.9): a list cut to its first rows, a long text cut,
 * or a value left out. The rest is read with `oui.read` (§7.3.10), by this
 * surface, observation and path.
 */
export interface OUIFitCut {
  surface: string;
  observation: string;
  /** JSON Pointer (RFC 6901) into the observation's value; "" is the value itself. */
  path: string;
  kind: "list" | "text" | "value";
  /** Rows of a list, characters of a text, bytes of a value. */
  total: number;
  /** How many of them this frame keeps. */
  kept: number;
}

/** What was shortened or left out to fit a frame's byte budget (§7.3.9). */
export interface OUIFit {
  observations?: OUIFitCut[];
  /** The action's `data` was left out: its size, and the most a frame could carry. */
  data?: { bytes: number; limit: number };
}

// ─── Protocol Types ──────────────────────────────────────────────────────────

/**
 * A request from the agent runtime to execute an action on a surface.
 */
export interface OUIActionRequest {
  /** Unique request ID for correlation */
  requestId: string;

  /** Which surface this request targets */
  surfaceId: string;

  /** Which action to invoke */
  actionId: string;

  /** The action's input parameters (validated against the action's input schema) */
  params: Record<string, unknown>;

  /** Timestamp of the request */
  timestamp: number;

  /**
   * The user's approval this request runs on, for an action that needs one.
   * The surface runtime runs such an action only when this matches a grant
   * the tab received from the user's own confirmation, for exactly `params`.
   */
  approval?: OUIActionApproval;

  /**
   * The `surfacesHash` of the surfaces the agent runtime already holds for
   * this client: from its snapshot, or from an earlier result. A client whose
   * surfaces still hash to this answers without `surfaces`, so a result
   * carries the client's surfaces only when they changed (§7.3.4).
   */
  knownSurfaces?: string;
}

/**
 * Why a client's answer is shorter than the result it produced: the receiving
 * side refused the full answer (too large, or otherwise not accepted), so the
 * client sent it again without the parts named in `omitted`. The action's own
 * outcome — `success`, `error`, and `data` unless omitted — is still the one
 * that happened (§7.3.6).
 */
export interface OUIResultDelivery {
  trimmed: true;
  /** What the receiving side said when it refused the full answer. */
  reason: string;
  /** The fields left out of this answer. */
  omitted: Array<"surfaces" | "index" | "observations" | "data">;
}

/**
 * The result of an action execution, returned from the surface to the agent.
 */
export interface OUIActionResult {
  /** Correlates to the request */
  requestId: string;

  /** Whether the action succeeded */
  success: boolean;

  /** The action's return data (if successful) */
  data?: unknown;

  /** Error information (if failed) */
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };

  /** Progress indicator for interim polling results (0-100) */
  progress?: number;

  /** Whether this is an interim update (polling still in progress) or final */
  interim?: boolean;

  /** Duration of execution in milliseconds */
  durationMs?: number;

  /** Timestamp of the result */
  timestamp: number;

  /**
   * The surfaces active on the client once the action's effects settled.
   *
   * An action can change what the agent is able to do next: navigating
   * unmounts one page's surfaces and mounts another's. Without this, the agent
   * would act on the capability set it had before the action, which is the
   * set the action just replaced.
   */
  surfaces?: OUISurface[];

  /**
   * The same, in index form (§7.3.8): what a client sends in place of
   * `surfaces` unless it was made to send definitions.
   */
  index?: OUISurfaceIndex[];

  /** Latest observation values per surface once the action's effects settled. */
  observations?: OUIObservationSnapshot;

  /** What was shortened or left out so this answer fits its byte budget (§7.3.9). */
  fit?: OUIFit;

  /**
   * The hash of the client's surfaces once the action's effects settled
   * (`surfacesHash`). Always present from a client that sends it; `surfaces`
   * is then present only when this differs from the request's
   * `knownSurfaces`, and an agent runtime that holds surfaces with this hash
   * keeps using them.
   */
  surfacesHash?: string;

  /** Present when this answer was trimmed to be delivered (§7.3.6). */
  delivery?: OUIResultDelivery;

  /**
   * False when the client's deadline passed before its UI settled, so
   * `surfaces` and `observations` may still be changing. Absent or true
   * otherwise.
   */
  settled?: boolean;
}

/** Latest observation values, keyed by surface id and then observation id. */
export type OUIObservationSnapshot = Record<string, Record<string, unknown>>;

/**
 * What a client can do right now: the surfaces it has mounted and their latest
 * observation values. A client sends this to its agent runtime (for example,
 * with each turn), and returns it on every action result.
 *
 * This is the full form: every action with its definition. A client made in
 * index form (§7.3.8) sends an `OUIIndexSnapshot` instead.
 */
export interface OUISurfaceSnapshot {
  surfaces: OUISurface[];
  observations: OUIObservationSnapshot;
  /**
   * `surfacesHash(surfaces)`: what an agent runtime sends back as a request's
   * `knownSurfaces`, so the client's answer need not repeat surfaces the
   * runtime already holds.
   */
  surfacesHash?: string;
  /** What was shortened so the snapshot fits its byte budget (§7.3.9). */
  fit?: OUIFit;
}

/** A client's snapshot in index form (§7.3.8): each action as an index entry, not its definition. */
export interface OUIIndexSnapshot {
  index: OUISurfaceIndex[];
  observations: OUIObservationSnapshot;
  /** `surfacesHash(index)`. */
  surfacesHash?: string;
  /** What was shortened so the snapshot fits its byte budget (§7.3.9). */
  fit?: OUIFit;
}

/** A snapshot as an agent runtime receives it: in either form. */
export type OUIClientSnapshot = OUISurfaceSnapshot | OUIIndexSnapshot;

/**
 * An observation update pushed from the surface to the agent.
 */
export interface OUIObservationUpdate {
  /** Which surface this observation belongs to */
  surfaceId: string;

  /** Which observation updated */
  observationId: string;

  /** The new value */
  value: unknown;

  /** Timestamp of the update */
  timestamp: number;
}

/**
 * Surface registration event — sent when a surface becomes active.
 */
export interface OUISurfaceRegistration {
  /** The full surface manifest */
  surface: OUISurface;

  /** Timestamp of registration */
  timestamp: number;
}

/**
 * Surface deregistration event — sent when a surface becomes inactive.
 */
export interface OUISurfaceDeregistration {
  /** Which surface is being deregistered */
  surfaceId: string;

  /** Timestamp */
  timestamp: number;
}

// ─── Transport Protocol Events ───────────────────────────────────────────────

/**
 * All protocol events exchanged between agent runtime and surfaces.
 */
export type OUIProtocolEvent =
  | { type: "surface:register"; payload: OUISurfaceRegistration }
  | { type: "surface:deregister"; payload: OUISurfaceDeregistration }
  | { type: "action:request"; payload: OUIActionRequest }
  | { type: "action:result"; payload: OUIActionResult }
  | { type: "observation:update"; payload: OUIObservationUpdate };

/**
 * Protocol event type strings (for type guards and routing).
 */
export const OUI_PROTOCOL_EVENTS = {
  SURFACE_REGISTER: "surface:register",
  SURFACE_DEREGISTER: "surface:deregister",
  ACTION_REQUEST: "action:request",
  ACTION_RESULT: "action:result",
  OBSERVATION_UPDATE: "observation:update",
} as const;

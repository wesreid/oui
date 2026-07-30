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

  /** JSON Schema for the action's input parameters */
  input: JSONSchema;

  /** JSON Schema for the action's return value (optional — agent still gets the result) */
  output?: JSONSchema;

  /** If true, the agent runtime should confirm with the user before executing */
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
  updateFrequency?: 'realtime' | 'on-change' | 'polling';
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
}

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
  | { type: 'surface:register'; payload: OUISurfaceRegistration }
  | { type: 'surface:deregister'; payload: OUISurfaceDeregistration }
  | { type: 'action:request'; payload: OUIActionRequest }
  | { type: 'action:result'; payload: OUIActionResult }
  | { type: 'observation:update'; payload: OUIObservationUpdate };

/**
 * Protocol event type strings (for type guards and routing).
 */
export const OUI_PROTOCOL_EVENTS = {
  SURFACE_REGISTER: 'surface:register',
  SURFACE_DEREGISTER: 'surface:deregister',
  ACTION_REQUEST: 'action:request',
  ACTION_RESULT: 'action:result',
  OBSERVATION_UPDATE: 'observation:update',
} as const;

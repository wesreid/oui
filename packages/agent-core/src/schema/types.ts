export interface SchemaLoadOptions {
  /** Base directory for resolving $ref paths */
  basePath?: string;
  /** File extensions to scan (default: ['.yaml', '.yml', '.json']) */
  extensions?: string[];
  /** Whether to recursively scan subdirectories (default: true) */
  recursive?: boolean;
}

export type SchemaSource =
  | { type: 'directory'; path: string; options?: SchemaLoadOptions }
  | { type: 'files'; paths: string[] }
  | { type: 'inline'; documents: RawSchemaDocument[] };

export interface RawSchemaDocument {
  domain?: RawDomainSchema;
  entity?: RawEntitySchema;
  intent?: RawIntentSchema;
  workflow?: RawWorkflowSchema;
}

export interface RawDomainSchema {
  id: string;
  name: string;
  description: string;
  entities?: Array<string | { $ref: string }>;
  intents?: Array<string | { $ref: string }>;
  relationships?: RawRelationshipSchema[];
  workflows?: Array<string | { $ref: string }>;
  metadata?: Record<string, unknown>;
}

export interface RawEntitySchema {
  id: string;
  domain: string;
  description?: string;
  properties: Record<string, RawPropertySchema>;
  display: {
    title: string;
    subtitle?: string;
    image?: string;
    badge?: string;
  };
  indexable?: boolean;
  metadata?: Record<string, unknown>;
}

export interface RawPropertySchema {
  type: string;
  description?: string;
  required?: boolean;
  searchable?: boolean;
  display?: string;
  values?: string[];
  entity?: string;
  optional?: boolean;
  items?: RawPropertySchema;
  properties?: Record<string, RawPropertySchema>;
  default?: unknown;
}

export interface RawIntentSchema {
  id: string;
  domain: string;
  description: string;
  /**
   * Whether this intent has side effects (creates, mutates, or deletes state).
   * When `false`, the orchestrator allows up to DEFAULT_TOOL_QUOTA invocations
   * instead of the restrictive SIDE_EFFECT_TOOL_QUOTA (2). Fail-closed: omitting
   * this field (or setting it to `true`) caps the tool at the side-effect quota.
   */
  sideEffects?: boolean;
  parameters: Record<string, RawParameterSchema>;
  preconditions?: RawPreconditionSchema[];
  /**
   * How the intent is executed against the host's AgentApiSurface.
   * Present in all generation/mutation intents; absent for pure-UI intents.
   */
  execution?: RawIntentExecutionSchema;
  outcome: {
    produces?: string;
    mutates?: string;
    deletes?: string;
    async?: boolean;
    estimatedDuration?: string;
    sideEffects?: string[];
  };
  composableWith?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Execution block — declares which service + method the intent calls, how
 * parameters map, how results map, and (for async intents) which realtime
 * event to subscribe to for completion.
 */
export interface RawIntentExecutionSchema {
  service: string;
  method: string;
  parameterMapping?: Record<string, unknown>;
  resultMapping?: Record<string, string>;
  subscribe?: RawIntentSubscribeSchema;
}

/**
 * Subscription block — for async intents, the declared events that settle the
 * job (W9). The SDK waits for the completion or the failure (with a timeout)
 * instead of polling. Each name must be declared in the product's event
 * declarations, or the tools fail to load.
 */
export interface RawIntentSubscribeSchema {
  service: string;
  /** The declared completion event. */
  event: string;
  /** The declared failure event. Default: the one the declarations pair with `event`. */
  failure?: string;
  /** One entry: the completion's correlation field, and where the dispatch returns the job's id (`${ response.x }`). */
  filter?: Record<string, unknown>;
  /** How long to wait, e.g. `60s` or `2m`. Default 60s. */
  timeout?: string;
  /** Fields for the model, each read from the completion (`${ event.x }`). */
  resultMapping?: Record<string, string>;
}

export interface RawParameterSchema {
  type: string;
  description?: string;
  required?: boolean;
  entity?: string;
  values?: string[];
  maxLength?: number;
  minLength?: number;
  min?: number;
  max?: number;
  default?: unknown;
  items?: RawParameterSchema;
}

export interface RawPreconditionSchema {
  check: string;
  entity?: string;
  relation?: string;
  property?: string;
  value?: unknown;
  remedy?: string;
  message?: string;
}

export interface RawRelationshipSchema {
  from: string;
  to: string;
  type: string;
  via: string;
  inverse?: string;
}

export interface RawWorkflowSchema {
  id: string;
  name: string;
  description: string;
  trigger: string;
  steps: Array<{
    intent: string;
    description?: string;
    condition?: string;
    outputMapping?: Record<string, string>;
  }>;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  path: string;
  message: string;
  schemaId?: string;
  code: string;
}

export interface ValidationWarning {
  path: string;
  message: string;
  schemaId?: string;
  code: string;
}

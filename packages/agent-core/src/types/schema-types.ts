/**
 * Core schema types for the agent SDK.
 * These represent the runtime shape of parsed declarative schemas (JSON/YAML).
 */

export interface AgentDomain {
  id: string;
  name: string;
  description: string;
  entities: AgentEntity[];
  intents: AgentIntent[];
  relationships: AgentRelationship[];
  workflows?: AgentWorkflow[];
  metadata?: Record<string, unknown>;
}

export interface AgentEntity {
  id: string;
  domain: string;
  description?: string;
  properties: Record<string, AgentEntityProperty>;
  display: AgentEntityDisplay;
  query?: AgentEntityQuery;
  indexable: boolean;
  metadata?: Record<string, unknown>;
}

export interface AgentEntityQuery {
  service: string;
  module: string;
  methods: {
    list: string;
    get: string;
    search?: string;
    create?: string;
    update?: string;
    delete?: string;
  };
  resultMapping?: Record<string, string>;
}

export interface AgentEntityProperty {
  type: 'string' | 'number' | 'boolean' | 'enum' | 'relation' | 'array' | 'object' | 'date';
  description?: string;
  required?: boolean;
  searchable?: boolean;
  display?: 'title' | 'subtitle' | 'image' | 'badge' | 'hidden';
  values?: string[];
  entity?: string;
  optional?: boolean;
  items?: AgentEntityProperty;
  properties?: Record<string, AgentEntityProperty>;
  default?: unknown;
}

export type AgentEntityRelation = AgentEntityProperty & {
  type: 'relation';
  entity: string;
};

export interface AgentEntityDisplay {
  title: string;
  subtitle?: string;
  image?: string;
  badge?: string;
}

export interface AgentIntent {
  id: string;
  domain: string;
  description: string;
  /**
   * Whether this intent has side effects. `false` opts the tool out of the
   * restrictive SIDE_EFFECT_TOOL_QUOTA, allowing the orchestrator to call it
   * up to DEFAULT_TOOL_QUOTA times per turn. Fail-closed: absent ≡ `true`.
   */
  sideEffects?: boolean;
  parameters: Record<string, AgentIntentParameter>;
  preconditions?: AgentIntentPrecondition[];
  outcome: AgentIntentOutcome;
  execution?: AgentIntentExecution;
  composableWith?: string[];
  metadata?: Record<string, unknown>;
}

export interface AgentIntentExecution {
  service: string;
  method: string;
  parameterMapping?: Record<string, string>;
  resultMapping?: Record<string, string>;
  subscribe?: AgentIntentSubscription;
}

export interface AgentIntentSubscription {
  service: string;
  event: string;
  filter?: Record<string, string>;
  timeout?: string;
  resultMapping?: Record<string, string>;
}

export interface AgentIntentParameter {
  type: 'string' | 'number' | 'boolean' | 'enum' | 'entity' | 'array' | 'object';
  description?: string;
  required?: boolean;
  entity?: string;
  values?: string[];
  maxLength?: number;
  minLength?: number;
  min?: number;
  max?: number;
  default?: unknown;
  items?: AgentIntentParameter;
}

export interface AgentIntentPrecondition {
  check: string;
  entity?: string;
  relation?: string;
  property?: string;
  value?: unknown;
  remedy?: string;
  message?: string;
}

export interface AgentIntentOutcome {
  produces?: string;
  mutates?: string;
  deletes?: string;
  async?: boolean;
  estimatedDuration?: string;
  sideEffects?: string[];
}

export interface AgentRelationship {
  from: string;
  to: string;
  type: 'has_one' | 'has_many' | 'belongs_to' | 'many_to_many';
  via: string;
  inverse?: string;
}

export interface AgentWorkflow {
  id: string;
  name: string;
  description: string;
  trigger: string;
  steps: AgentWorkflowStep[];
}

export interface AgentWorkflowStep {
  intent: string;
  description?: string;
  condition?: string;
  outputMapping?: Record<string, string>;
}

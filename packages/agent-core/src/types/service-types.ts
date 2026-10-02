/**
 * Service layer types for the agent SDK.
 * Defines how services are declared, resolved, and bound to intents/entities.
 */

// ─── Agent Manifest ────────────────────────────────────────────────────────────

export interface AgentManifest {
  agent: {
    id: string;
    name: string;
    version: string;
    authority: AgentAuthority;
    identity: AgentIdentityConfig;
    runtime: AgentRuntimeConfig;
    features: AgentFeatures;
    domains?: Array<{ $ref: string }>;
  };
}

export interface AgentAuthority {
  schemas: string;
  services: string;
}

export interface AgentIdentityConfig {
  name: string;
  role: string;
  personality?: string;
  instructions?: string;
}

export interface AgentRuntimeConfig {
  orchestrator: 'server' | 'client' | 'hybrid';
  llm: {
    default: LLMProviderConfig;
    fallback?: LLMProviderConfig;
  };
  maxTurns?: number;
  maxToolCallsPerTurn?: number;
  timeoutMs?: number;
}

export interface LLMProviderConfig {
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export interface AgentFeatures {
  learning?: boolean;
  annotations?: boolean;
  sessions?: boolean;
  streaming?: boolean;
}

// ─── Service Definition ────────────────────────────────────────────────────────

export type ServiceType = 'api-client' | 'websocket' | 'local' | 'grpc';

export interface ServiceDefinition {
  id: string;
  name: string;
  type: ServiceType;
  package?: string;
  description?: string;
  config?: ServiceConfig;
  exports?: Record<string, ServiceExport | { $ref: string }>;
  events?: Record<string, ServiceEvent | { $ref: string }>;
}

export interface ServiceConfig {
  baseUrl?: string;
  url?: string;
  auth?: ServiceAuth;
  reconnect?: boolean;
  [key: string]: unknown;
}

export interface ServiceAuth {
  type: 'bearer' | 'api-key' | 'basic' | 'oauth2' | 'none';
  tokenSource?: 'session' | 'env' | 'config';
  envVar?: string;
  headerName?: string;
}

export interface ServiceExport {
  module: string;
  modulePath?: string;
  description?: string;
  methods: Record<string, ServiceMethod>;
}

export interface ServiceMethod {
  description?: string;
  params?: Record<string, ServiceMethodParam>;
  returns?: string | ServiceMethodReturn;
  async?: boolean;
}

export interface ServiceMethodParam {
  type: string;
  required?: boolean;
  optional?: boolean;
  description?: string;
  default?: unknown;
}

export interface ServiceMethodReturn {
  type: string;
  properties?: Record<string, { type: string }>;
}

// ─── Service Events (WebSocket) ────────────────────────────────────────────────

export interface ServiceEvent {
  description?: string;
  entity?: string;
  payload: Record<string, string | ServiceEventPayloadField>;
}

export interface ServiceEventPayloadField {
  type: string;
  description?: string;
  optional?: boolean;
}

// ─── Execution Binding (Intent → Service) ──────────────────────────────────────

export interface ExecutionBinding {
  service: string;
  method: string;
  parameterMapping?: Record<string, string>;
  resultMapping?: Record<string, string>;
  subscribe?: SubscriptionBinding;
}

export interface SubscriptionBinding {
  service: string;
  event: string;
  filter?: Record<string, string>;
  timeout?: string;
  resultMapping?: Record<string, string>;
}

// ─── Query Binding (Entity → Service) ──────────────────────────────────────────

export interface QueryBinding {
  service: string;
  module: string;
  methods: QueryMethods;
  resultMapping?: Record<string, string>;
}

export interface QueryMethods {
  list: string;
  get: string;
  search?: string;
  create?: string;
  update?: string;
  delete?: string;
}

// ─── Service Registry (Runtime) ────────────────────────────────────────────────

export interface ServiceInstance {
  [moduleName: string]: ServiceModuleInstance;
}

export interface ServiceModuleInstance {
  [methodName: string]: (...args: unknown[]) => unknown | Promise<unknown>;
}

export interface ServiceRegistryConfig {
  definitions: ServiceDefinition[];
  instances: Record<string, unknown>;
}

export interface ResolvedService {
  definition: ServiceDefinition;
  instance: unknown;
  getModule(moduleName: string): ServiceModuleInstance;
  callMethod(modulePath: string, params: Record<string, unknown>): Promise<unknown>;
}

// ─── Template Evaluation ───────────────────────────────────────────────────────

export type TemplateContext = {
  params?: Record<string, unknown>;
  response?: unknown;
  event?: unknown;
  config?: Record<string, unknown>;
  env?: Record<string, string>;
};

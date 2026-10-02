/**
 * Registry types — the compiled runtime representation of declarative schemas.
 */

import type { AgentDomain, AgentEntity, AgentIntent, AgentRelationship } from './schema-types.js';

export interface SchemaRegistry {
  readonly domains: ReadonlyMap<string, CompiledDomain>;
  readonly entities: ReadonlyMap<string, CompiledEntity>;
  readonly intents: ReadonlyMap<string, CompiledIntent>;
  readonly entityGraph: EntityGraph;

  getDomain(id: string): CompiledDomain | undefined;
  getEntity(id: string): CompiledEntity | undefined;
  getIntent(id: string): CompiledIntent | undefined;
  getIntentsForEntity(entityId: string): CompiledIntent[];
  getRelatedEntities(entityId: string): EntityEdge[];
  getIntentChain(fromIntent: string): CompiledIntent[];
}

export interface CompiledDomain extends AgentDomain {
  entityIds: string[];
  intentIds: string[];
}

export interface CompiledEntity extends AgentEntity {
  domainRef: CompiledDomain;
  incomingRelations: AgentRelationship[];
  outgoingRelations: AgentRelationship[];
  applicableIntents: string[];
}

export interface CompiledIntent extends AgentIntent {
  domainRef: CompiledDomain;
  resolvedPreconditions: ResolvedPrecondition[];
  compositionChain: string[];
  toolDefinition: import('./llm-types.js').ToolDefinition;
}

export interface ResolvedPrecondition {
  check: string;
  entityType?: string;
  relation?: string;
  remedyIntent?: CompiledIntent;
  message: string;
}

export interface EntityGraph {
  nodes: ReadonlyMap<string, EntityNode>;
  edges: EntityEdge[];

  getNode(entityId: string): EntityNode | undefined;
  getEdgesFrom(entityId: string): EntityEdge[];
  getEdgesTo(entityId: string): EntityEdge[];
  getShortestPath(from: string, to: string): EntityNode[];
}

export interface EntityNode {
  entityId: string;
  entity: CompiledEntity;
  depth: number;
}

export interface EntityEdge {
  from: string;
  to: string;
  relationship: AgentRelationship;
}

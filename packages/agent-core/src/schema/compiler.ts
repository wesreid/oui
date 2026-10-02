import type { RawSchemaDocument } from './types.js';
import type {
  SchemaRegistry,
  CompiledDomain,
  CompiledEntity,
  CompiledIntent,
  EntityGraph,
  EntityNode,
  EntityEdge,
  ResolvedPrecondition,
} from '../types/registry-types.js';
import type {
  AgentDomain,
  AgentEntity,
  AgentIntent,
  AgentRelationship,
  AgentIntentParameter,
} from '../types/schema-types.js';
import type { ToolDefinition } from '../types/llm-types.js';
import { validateSchemas } from './validator.js';

/**
 * Compile raw schema documents into a fully-resolved SchemaRegistry.
 * Validates schemas, builds entity graph, resolves precondition chains,
 * and generates LLM tool definitions.
 */
export function compileRegistry(documents: RawSchemaDocument[]): SchemaRegistry {
  const validation = validateSchemas(documents);
  if (!validation.valid) {
    const errorMessages = validation.errors.map(e => `  [${e.code}] ${e.path}: ${e.message}`).join('\n');
    throw new Error(`Schema validation failed:\n${errorMessages}`);
  }

  const rawDomains: AgentDomain[] = [];
  const rawEntities: AgentEntity[] = [];
  const rawIntents: AgentIntent[] = [];
  const allRelationships: AgentRelationship[] = [];

  for (const doc of documents) {
    if (doc.domain) {
      const domainEntities = rawEntities.filter(e => e.domain === doc.domain!.id);
      const domainIntents = rawIntents.filter(i => i.domain === doc.domain!.id);
      const domain: AgentDomain = {
        id: doc.domain.id,
        name: doc.domain.name,
        description: doc.domain.description,
        entities: domainEntities,
        intents: domainIntents,
        relationships: (doc.domain.relationships as AgentRelationship[]) ?? [],
        metadata: doc.domain.metadata,
      };
      rawDomains.push(domain);
      if (doc.domain.relationships) {
        allRelationships.push(...(doc.domain.relationships as AgentRelationship[]));
      }
    }
    if (doc.entity) rawEntities.push(doc.entity as AgentEntity);
    if (doc.intent) rawIntents.push(doc.intent as AgentIntent);
  }

  const domains = new Map<string, CompiledDomain>();
  const entities = new Map<string, CompiledEntity>();
  const intents = new Map<string, CompiledIntent>();

  // Compile domains
  for (const raw of rawDomains) {
    const compiled: CompiledDomain = {
      ...raw,
      entityIds: rawEntities.filter(e => e.domain === raw.id).map(e => e.id),
      intentIds: rawIntents.filter(i => i.domain === raw.id).map(i => i.id),
    };
    domains.set(raw.id, compiled);
  }

  // Compile entities
  for (const raw of rawEntities) {
    const domainRef = domains.get(raw.domain);
    if (!domainRef) continue;

    const incoming = allRelationships.filter(r => r.to === raw.id);
    const outgoing = allRelationships.filter(r => r.from === raw.id);
    const applicable = rawIntents
      .filter(i => hasEntityParameter(i, raw.id))
      .map(i => i.id);

    const compiled: CompiledEntity = {
      ...raw,
      domainRef,
      incomingRelations: incoming,
      outgoingRelations: outgoing,
      applicableIntents: applicable,
    };
    entities.set(raw.id, compiled);
  }

  // Compile intents
  for (const raw of rawIntents) {
    const domainRef = domains.get(raw.domain);
    if (!domainRef) continue;

    const resolvedPreconditions: ResolvedPrecondition[] = (raw.preconditions ?? []).map(p => ({
      check: p.check,
      entityType: p.entity,
      relation: p.relation,
      remedyIntent: undefined, // resolved after all intents compiled
      message: p.message ?? `Precondition "${p.check}" not met`,
    }));

    const compiled: CompiledIntent = {
      ...raw,
      domainRef,
      resolvedPreconditions,
      compositionChain: raw.composableWith ?? [],
      toolDefinition: intentToToolDefinition(raw),
    };
    intents.set(raw.id, compiled);
  }

  // Resolve remedy references
  for (const intent of intents.values()) {
    for (let i = 0; i < intent.resolvedPreconditions.length; i++) {
      const precondition = intent.preconditions?.[i];
      if (precondition?.remedy) {
        intent.resolvedPreconditions[i].remedyIntent = intents.get(precondition.remedy);
      }
    }
  }

  // Build entity graph
  const entityGraph = buildEntityGraph(entities, allRelationships);

  return createRegistryObject(domains, entities, intents, entityGraph);
}

function hasEntityParameter(intent: AgentIntent, entityId: string): boolean {
  return Object.values(intent.parameters).some(
    p => p.type === 'entity' && p.entity === entityId,
  );
}

function intentToToolDefinition(intent: AgentIntent): ToolDefinition {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [name, param] of Object.entries(intent.parameters)) {
    properties[name] = parameterToJsonSchema(param);
    if (param.required) required.push(name);
  }

  return {
    type: 'function',
    function: {
      name: intent.id,
      description: intent.description,
      parameters: {
        type: 'object',
        properties,
        required: required.length > 0 ? required : undefined,
      },
    },
  };
}

function parameterToJsonSchema(param: AgentIntentParameter): Record<string, unknown> {
  const schema: Record<string, unknown> = {};

  switch (param.type) {
    case 'string':
      schema.type = 'string';
      if (param.maxLength) schema.maxLength = param.maxLength;
      if (param.minLength) schema.minLength = param.minLength;
      break;
    case 'number':
      schema.type = 'number';
      if (param.min !== undefined) schema.minimum = param.min;
      if (param.max !== undefined) schema.maximum = param.max;
      break;
    case 'boolean':
      schema.type = 'boolean';
      break;
    case 'enum':
      schema.type = 'string';
      schema.enum = param.values;
      break;
    case 'entity':
      schema.type = 'string';
      schema.description = `ID of a ${param.entity} entity`;
      break;
    case 'array':
      schema.type = 'array';
      if (param.items) schema.items = parameterToJsonSchema(param.items);
      break;
    case 'object':
      schema.type = 'object';
      break;
  }

  if (param.description) schema.description = param.description;
  if (param.default !== undefined) schema.default = param.default;

  return schema;
}

function buildEntityGraph(
  entities: Map<string, CompiledEntity>,
  relationships: AgentRelationship[],
): EntityGraph {
  const nodes = new Map<string, EntityNode>();
  const edges: EntityEdge[] = [];

  for (const [id, entity] of entities) {
    nodes.set(id, { entityId: id, entity, depth: 0 });
  }

  for (const rel of relationships) {
    edges.push({ from: rel.from, to: rel.to, relationship: rel });
  }

  return {
    nodes,
    edges,
    getNode: (entityId) => nodes.get(entityId),
    getEdgesFrom: (entityId) => edges.filter(e => e.from === entityId),
    getEdgesTo: (entityId) => edges.filter(e => e.to === entityId),
    getShortestPath: (from, to) => bfsPath(nodes, edges, from, to),
  };
}

function bfsPath(
  nodes: Map<string, EntityNode>,
  edges: EntityEdge[],
  from: string,
  to: string,
): EntityNode[] {
  if (from === to) return [nodes.get(from)!].filter(Boolean);

  const visited = new Set<string>();
  const queue: Array<{ id: string; path: string[] }> = [{ id: from, path: [from] }];
  visited.add(from);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const neighbors = edges
      .filter(e => e.from === current.id || e.to === current.id)
      .map(e => (e.from === current.id ? e.to : e.from));

    for (const neighbor of neighbors) {
      if (neighbor === to) {
        return [...current.path, neighbor].map(id => nodes.get(id)!).filter(Boolean);
      }
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push({ id: neighbor, path: [...current.path, neighbor] });
      }
    }
  }

  return [];
}

function createRegistryObject(
  domains: Map<string, CompiledDomain>,
  entities: Map<string, CompiledEntity>,
  intents: Map<string, CompiledIntent>,
  entityGraph: EntityGraph,
): SchemaRegistry {
  return {
    domains,
    entities,
    intents,
    entityGraph,
    getDomain: (id) => domains.get(id),
    getEntity: (id) => entities.get(id),
    getIntent: (id) => intents.get(id),
    getIntentsForEntity: (entityId) =>
      [...intents.values()].filter(i =>
        Object.values(i.parameters).some(p => p.type === 'entity' && p.entity === entityId),
      ),
    getRelatedEntities: (entityId) => entityGraph.getEdgesFrom(entityId),
    getIntentChain: (fromIntent) => {
      const intent = intents.get(fromIntent);
      if (!intent) return [];
      return intent.compositionChain
        .map(id => intents.get(id))
        .filter((i): i is CompiledIntent => i !== undefined);
    },
  };
}

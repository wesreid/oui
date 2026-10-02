/**
 * Entity CRUD tool generation — auto-generates list/get/create/update/delete
 * tools for each entity type defined in the schema.
 *
 * Instead of hand-authoring `list_characters`, `get_character`, `create_character`,
 * etc., the SDK generates them from `entities/*.yaml`. Each tool's `execute`
 * calls the corresponding `AgentApiSurface` method:
 *   - list_<entity>   → apiSurface.queryEntities(type, filter)
 *   - get_<entity>     → apiSurface.getEntity(type, id)
 *   - create_<entity>  → apiSurface.mutateEntity(type, id, { create: true, set })
 *   - update_<entity>  → apiSurface.mutateEntity(type, id, { set })
 *   - delete_<entity>  → apiSurface.mutateEntity(type, id, {}) with delete semantics
 *
 * @see docs/reference/integration-contract.md §1b
 */
import { loadSchemas } from '@ouispec/agent-core';
import type { RawSchemaDocument, RawEntitySchema, RawPropertySchema } from '@ouispec/agent-core';
import type { RegisteredTool, ToolExecutionContext } from './types.js';
import type { AgentApiSurface } from '@ouispec/agent-core';

/**
 * Load entity schemas and generate CRUD tools for each entity type.
 */
export async function loadEntityToolsFromSchema(schemasDir: string): Promise<RegisteredTool[]> {
  const documents = await loadSchemas(schemasDir);
  const entities = extractEntities(documents);

  const tools: RegisteredTool[] = [];
  for (const entity of entities) {
    tools.push(...generateEntityCrudTools(entity));
  }
  return tools;
}

function extractEntities(documents: RawSchemaDocument[]): RawEntitySchema[] {
  const entities: RawEntitySchema[] = [];
  const seen = new Set<string>();
  for (const doc of documents) {
    if (doc.entity && !seen.has(doc.entity.id)) {
      entities.push(doc.entity);
      seen.add(doc.entity.id);
    }
    if (doc.domain?.entities) {
      for (const e of doc.domain.entities) {
        if (typeof e === 'object' && e !== null && 'id' in e) {
          const ent = e as unknown as RawEntitySchema;
          if (!seen.has(ent.id)) {
            entities.push(ent);
            seen.add(ent.id);
          }
        }
      }
    }
  }
  return entities;
}

function generateEntityCrudTools(entity: RawEntitySchema): RegisteredTool[] {
  const type = entity.id;
  const lower = type.toLowerCase();
  const plural = pluralize(lower);
  const props = entity.properties ?? {};

  return [
    generateListTool(type, plural, entity),
    generateGetTool(type, lower, entity),
    generateCreateTool(type, lower, entity, props),
    generateUpdateTool(type, lower, entity, props),
    generateDeleteTool(type, lower, entity),
  ];
}

function generateListTool(type: string, lower: string, entity: RawEntitySchema): RegisteredTool {
  return {
    name: `list-${lower}`,
    description: `List ${entity.description ?? type + 's'} with optional filtering and search.`,
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search by name/title' },
        limit: { type: 'integer', description: 'Max results', default: 20 },
        offset: { type: 'integer', description: 'Pagination offset', default: 0 },
      },
      additionalProperties: false,
    },
    async execute(input, ctx: ToolExecutionContext) {
      const apiSurface = ctx.apiSurface as AgentApiSurface | undefined;
      if (!apiSurface) return noSurfaceError(`list-${lower}`);
      const filter: Record<string, unknown> = {};
      if (input.search) filter.search = input.search;
      if (input.limit) filter.limit = input.limit;
      if (input.offset) filter.offset = input.offset;
      const results = await apiSurface.queryEntities(type, filter);
      return { success: true, data: results };
    },
  };
}

function generateGetTool(type: string, lower: string, _entity: RawEntitySchema): RegisteredTool {
  return {
    name: `get-${lower}`,
    description: `Get a single ${type} by ID.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: `The ${type} ID` },
      },
      required: ['id'],
      additionalProperties: false,
    },
    async execute(input, ctx: ToolExecutionContext) {
      const apiSurface = ctx.apiSurface as AgentApiSurface | undefined;
      if (!apiSurface) return noSurfaceError(`get-${lower}`);
      const result = await apiSurface.getEntity(type, input.id as string);
      return { success: true, data: result };
    },
  };
}

function generateCreateTool(
  type: string,
  lower: string,
  entity: RawEntitySchema,
  props: Record<string, RawPropertySchema>,
): RegisteredTool {
  const { properties, required } = convertEntityProperties(props);
  return {
    name: `create-${lower}`,
    description: `Create a new ${type}.`,
    inputSchema: {
      type: 'object',
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    },
    async execute(input, ctx: ToolExecutionContext) {
      const apiSurface = ctx.apiSurface as AgentApiSurface | undefined;
      if (!apiSurface) return noSurfaceError(`create-${lower}`);
      const result = await apiSurface.mutateEntity(type, '', { create: true, set: input });
      return { success: true, data: result };
    },
  };
}

function generateUpdateTool(
  type: string,
  lower: string,
  entity: RawEntitySchema,
  props: Record<string, RawPropertySchema>,
): RegisteredTool {
  const { properties } = convertEntityProperties(props, true);
  return {
    name: `update-${lower}`,
    description: `Update properties of an existing ${type}.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: `The ${type} ID to update` },
        ...properties,
      },
      required: ['id'],
      additionalProperties: false,
    },
    async execute(input, ctx: ToolExecutionContext) {
      const apiSurface = ctx.apiSurface as AgentApiSurface | undefined;
      if (!apiSurface) return noSurfaceError(`update-${lower}`);
      const { id, ...set } = input;
      const result = await apiSurface.mutateEntity(type, id as string, { set });
      return { success: true, data: result };
    },
  };
}

function generateDeleteTool(type: string, lower: string, _entity: RawEntitySchema): RegisteredTool {
  return {
    name: `delete-${lower}`,
    description: `Delete a ${type} by ID.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: `The ${type} ID to delete` },
      },
      required: ['id'],
      additionalProperties: false,
    },
    async execute(input, ctx: ToolExecutionContext) {
      const apiSurface = ctx.apiSurface as AgentApiSurface | undefined;
      if (!apiSurface) return noSurfaceError(`delete-${lower}`);
      // mutateEntity with disconnect signals deletion; hosts interpret accordingly
      await apiSurface.mutateEntity(type, input.id as string, { disconnect: ['*'] });
      return { success: true, data: { deleted: true, id: input.id } };
    },
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function convertEntityProperties(
  props: Record<string, RawPropertySchema>,
  allOptional = false,
): { properties: Record<string, unknown>; required: string[] } {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [name, prop] of Object.entries(props)) {
    // Skip relation properties at the CRUD layer (they're managed via link/unlink)
    if (prop.type === 'relation') continue;

    properties[name] = convertEntityProperty(prop);
    if (prop.required && !allOptional) {
      required.push(name);
    }
  }

  return { properties, required };
}

function convertEntityProperty(prop: RawPropertySchema): Record<string, unknown> {
  const schema: Record<string, unknown> = {};

  if (prop.type === 'enum') {
    schema.type = 'string';
    if (prop.values) schema.enum = prop.values;
  } else if (prop.type === 'array') {
    schema.type = 'array';
    if (prop.items) schema.items = { type: prop.items.type };
  } else {
    schema.type = prop.type;
  }

  if (prop.description) schema.description = prop.description;
  return schema;
}

function pluralize(word: string): string {
  if (word.endsWith('s') || word.endsWith('x') || word.endsWith('z')) return word + 'es';
  if (word.endsWith('y') && !'aeiou'.includes(word[word.length - 2])) return word.slice(0, -1) + 'ies';
  return word + 's';
}

function noSurfaceError(toolName: string) {
  return {
    success: false,
    error: `Tool '${toolName}' requires an AgentApiSurface binding. Provide apiSurface in the worker config.`,
  };
}

/**
 * Test fixtures for MCP server tests.
 *
 * Provides mock implementations of SchemaRegistry, AgentApiSurface, and
 * UISurfaceSchema that carry realistic data for integration testing.
 */

import type {
  SchemaRegistry,
  AgentApiSurface,
  CompiledDomain,
  CompiledEntity,
  CompiledIntent,
  EntityGraph,
  EntityNode,
  EntityEdge,
  IntentResult,
  EntityInstance,
  ViewAnnotationState,
  NavigationState,
  UISurfaceSchema,
} from '@ouispec/agent-core';

// ---------------------------------------------------------------------------
// Domain + Entities + Intents
// ---------------------------------------------------------------------------

const mockDomain: CompiledDomain = {
  id: 'video',
  name: 'Video Production',
  description: 'Video production domain',
  entities: [],
  intents: [],
  relationships: [],
  entityIds: ['clip', 'project'],
  intentIds: ['create_clip', 'list_clips', 'delete_clip'],
};

const mockClipEntity: CompiledEntity = {
  id: 'clip',
  domain: 'video',
  description: 'A video clip',
  properties: {
    title: { type: 'string', description: 'Clip title', required: true, searchable: true },
    duration: { type: 'number', description: 'Duration in seconds' },
  },
  display: { title: 'title' },
  indexable: true,
  domainRef: mockDomain,
  incomingRelations: [],
  outgoingRelations: [],
  applicableIntents: ['create_clip', 'list_clips', 'delete_clip'],
};

const mockProjectEntity: CompiledEntity = {
  id: 'project',
  domain: 'video',
  description: 'A video project',
  properties: {
    name: { type: 'string', description: 'Project name', required: true, searchable: true },
  },
  display: { title: 'name' },
  indexable: true,
  domainRef: mockDomain,
  incomingRelations: [],
  outgoingRelations: [],
  applicableIntents: [],
};

function createMockIntent(
  id: string,
  description: string,
  params: Record<string, { type: string; description: string }>,
  outcome: CompiledIntent['outcome'] = {},
): CompiledIntent {
  return {
    id,
    domain: 'video',
    description,
    parameters: Object.fromEntries(
      Object.entries(params).map(([key, val]) => [
        key,
        { type: val.type as 'string', description: val.description, required: true },
      ]),
    ),
    outcome,
    domainRef: mockDomain,
    resolvedPreconditions: [],
    compositionChain: [],
    toolDefinition: {
      type: 'function',
      function: {
        name: id,
        description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            Object.entries(params).map(([key, val]) => [key, { type: val.type, description: val.description }]),
          ),
          required: Object.keys(params),
        },
      },
    },
  };
}

const createClipIntent = createMockIntent(
  'create_clip',
  'Create a new video clip',
  { title: { type: 'string', description: 'The clip title' }, duration: { type: 'number', description: 'Duration in seconds' } },
  { produces: 'clip' },
);

const listClipsIntent = createMockIntent(
  'list_clips',
  'List all video clips',
  {},
);

const deleteClipIntent = createMockIntent(
  'delete_clip',
  'Delete a video clip',
  { clipId: { type: 'string', description: 'The ID of the clip to delete' } },
  { deletes: 'clip' },
);

// ---------------------------------------------------------------------------
// SchemaRegistry
// ---------------------------------------------------------------------------

const intentsMap = new Map<string, CompiledIntent>([
  ['create_clip', createClipIntent],
  ['list_clips', listClipsIntent],
  ['delete_clip', deleteClipIntent],
]);

const entitiesMap = new Map<string, CompiledEntity>([
  ['clip', mockClipEntity],
  ['project', mockProjectEntity],
]);

const domainsMap = new Map<string, CompiledDomain>([
  ['video', mockDomain],
]);

const mockEntityGraph: EntityGraph = {
  nodes: new Map<string, EntityNode>([
    ['clip', { entityId: 'clip', entity: mockClipEntity, depth: 0 }],
    ['project', { entityId: 'project', entity: mockProjectEntity, depth: 0 }],
  ]),
  edges: [],
  getNode: (id: string) => mockEntityGraph.nodes.get(id),
  getEdgesFrom: () => [],
  getEdgesTo: () => [],
  getShortestPath: () => [],
};

export function createMockRegistry(): SchemaRegistry {
  return {
    domains: domainsMap,
    entities: entitiesMap,
    intents: intentsMap,
    entityGraph: mockEntityGraph,
    getDomain: (id: string) => domainsMap.get(id),
    getEntity: (id: string) => entitiesMap.get(id),
    getIntent: (id: string) => intentsMap.get(id),
    getIntentsForEntity: (entityId: string) =>
      [...intentsMap.values()].filter(i => i.outcome.produces === entityId || i.outcome.deletes === entityId),
    getRelatedEntities: () => [] as EntityEdge[],
    getIntentChain: () => [],
  };
}

// ---------------------------------------------------------------------------
// AgentApiSurface
// ---------------------------------------------------------------------------

export interface MockApiOptions {
  executeResult?: IntentResult;
  executeError?: Error;
}

export function createMockApi(options: MockApiOptions = {}): AgentApiSurface {
  const defaultResult: IntentResult = {
    success: true,
    data: { id: 'clip-001', title: 'Test Clip', duration: 30 },
  };

  return {
    queryEntities: async () => [] as EntityInstance[],
    getEntity: async (_type: string, id: string) => ({
      id,
      type: _type,
      properties: {},
    }),
    mutateEntity: async (_type: string, id: string) => ({
      id,
      type: _type,
      properties: {},
    }),
    executeIntent: async (_intentId: string, _params: Record<string, unknown>) => {
      if (options.executeError) {
        throw options.executeError;
      }
      return options.executeResult ?? defaultResult;
    },
    getVisibleAnnotations: () => [] as ViewAnnotationState[],
    getNavigationState: () => ({ route: '/dashboard' }) as NavigationState,
    navigate: async () => {},
  };
}

// ---------------------------------------------------------------------------
// UISurfaceSchema
// ---------------------------------------------------------------------------

export function createMockSurface(): UISurfaceSchema {
  return {
    pages: [
      {
        id: 'clip_editor',
        route: '/clips/:clipId/edit',
        title: 'Clip Editor',
        description: 'Edit a video clip: trim, add effects, adjust audio',
        entities: ['clip'],
        actions: [
          {
            id: 'save_clip',
            label: 'Save',
            description: 'Save the current clip edits',
          },
          {
            id: 'render_clip',
            label: 'Render',
            description: 'Start rendering the clip for export',
            confirmRequired: true,
          },
        ],
        forms: [
          {
            id: 'clip_metadata',
            title: 'Clip Metadata',
            fields: [
              { id: 'title', label: 'Title', type: 'text', required: true },
              { id: 'description', label: 'Description', type: 'textarea' },
            ],
            submitAction: 'save_clip',
          },
        ],
        players: [
          {
            id: 'preview_player',
            type: 'video',
            commands: ['play', 'pause', 'seek', 'loop'],
            seekable: true,
          },
        ],
      },
      {
        id: 'project_dashboard',
        route: '/projects/:projectId',
        title: 'Project Dashboard',
        description: 'Overview of all clips and assets in a project',
        entities: ['project', 'clip'],
        actions: [
          {
            id: 'new_clip',
            label: 'New Clip',
            description: 'Create a new clip in this project',
          },
        ],
        selectable: {
          entityType: 'clip',
          multi: true,
          bulkActions: ['delete_clip'],
        },
      },
    ],
    modals: [
      {
        id: 'confirm_delete',
        title: 'Confirm Delete',
        description: 'Confirmation dialog before deleting a clip',
        actions: [
          {
            id: 'confirm',
            label: 'Delete',
            description: 'Confirm the deletion',
            destructive: true,
          },
          {
            id: 'cancel',
            label: 'Cancel',
            description: 'Cancel the deletion',
          },
        ],
      },
    ],
    globalActions: [
      {
        id: 'open_search',
        label: 'Search',
        description: 'Open the global search dialog',
      },
      {
        id: 'toggle_theme',
        label: 'Toggle Theme',
        description: 'Switch between light and dark mode',
      },
    ],
    entityRoutes: {
      clip: '/clips/:id/edit',
      project: '/projects/:id',
    },
  };
}

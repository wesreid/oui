/**
 * The fixture product's event declarations (W9): exporting a report is a job
 * that ends as `report:ready` (with the file) or `report:failed` (with why).
 * The product declares them once; its API's async operation (`runReport`'s
 * `x-async-binding`), its realtime server, the worker's async tools and its tab
 * all follow this one document.
 */
import { PLATFORM_EVENTS, createEventCatalog, type EventDeclarationDocument } from '@ouispec/agent-events';

export const DESK_EVENTS: EventDeclarationDocument = {
  version: 1,
  product: 'desk',
  rooms: {
    member: { pattern: 'member:{userId}' },
    export: { pattern: 'export:{exportId}' },
  },
  events: {
    'report:ready': {
      description: 'An export finished; its file is ready.',
      payload: {
        type: 'object',
        properties: {
          exportId: { type: 'string' },
          url: { type: 'string' },
          pages: { type: 'integer' },
        },
        required: ['exportId', 'url'],
      },
      rooms: ['export', 'member'],
      correlation: ['exportId'],
      role: 'completion',
      completes: 'export',
      result: ['url', 'pages'],
    },
    'report:failed': {
      description: 'An export failed.',
      payload: {
        type: 'object',
        properties: { exportId: { type: 'string' }, error: { type: 'string' } },
        required: ['exportId'],
      },
      rooms: ['export', 'member'],
      correlation: ['exportId'],
      role: 'failure',
      completes: 'export',
      reason: { field: 'error', fallback: 'The export failed' },
    },
    'report:progress': {
      description: 'An export is rendering.',
      payload: {
        type: 'object',
        properties: { exportId: { type: 'string' }, progress: { type: 'number' } },
        required: ['exportId'],
      },
      rooms: ['export'],
      correlation: ['exportId'],
      role: 'progress',
    },
  },
};

/** The platform's events and Desk's, checked and merged. */
export const deskEvents = createEventCatalog(PLATFORM_EVENTS, DESK_EVENTS);

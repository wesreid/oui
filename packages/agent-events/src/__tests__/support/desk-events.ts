import type { EventDeclarationDocument } from '../../index.js';

/** A reporting product: exports are jobs that end as `report:ready` or `report:failed`. */
export function deskEvents(): EventDeclarationDocument {
  return {
    version: 1,
    product: 'desk',
    $defs: {
      ReportRef: {
        type: 'object',
        properties: { exportId: { type: 'string' }, reportId: { type: 'string' } },
        required: ['exportId'],
      },
    },
    rooms: {
      member: { pattern: 'member:{userId}' },
      export: { pattern: 'export:{exportId}' },
    },
    events: {
      'report:ready': {
        description: 'An export finished; its file is ready.',
        payload: {
          allOf: [
            { $ref: '#/$defs/ReportRef' },
            { type: 'object', properties: { url: { type: 'string' }, pages: { type: ['integer', 'null'] } }, required: ['url'] },
          ],
        },
        rooms: ['export', 'member'],
        correlation: ['exportId'],
        role: 'completion',
        completes: 'export',
        result: ['url', 'pages'],
      },
      'report:failed': {
        description: 'An export failed.',
        payload: { allOf: [{ $ref: '#/$defs/ReportRef' }, { type: 'object', properties: { error: { type: 'string' } } }] },
        rooms: ['export', 'member'],
        correlation: ['exportId'],
        role: 'failure',
        completes: 'export',
        reason: { field: 'error', fallback: 'The export failed' },
      },
      'report:progress': {
        description: 'An export is still rendering.',
        payload: { allOf: [{ $ref: '#/$defs/ReportRef' }, { type: 'object', properties: { progress: { type: 'number' } } }] },
        rooms: ['export'],
        correlation: ['exportId'],
        role: 'progress',
      },
    },
  };
}

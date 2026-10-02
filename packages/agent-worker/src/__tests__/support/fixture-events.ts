/**
 * The fixture product's event declarations (W9), shared with its API
 * (`../../testing/desk-events.ts`): exporting a report is a job that ends as
 * `report:ready` or `report:failed`.
 */
import { DESK_EVENTS, deskEvents } from '../../testing/desk-events.js';

export const FIXTURE_EVENTS = DESK_EVENTS;
export const fixtureEvents = deskEvents;

/** The intent that exports a report and waits for it: the fixture's one async tool. */
export const EXPORT_REPORT_INTENT = `
intent:
  id: export-report
  domain: reporting
  description: Export a saved report as a PDF.
  parameters:
    reportId:
      type: string
      required: true
      description: The report to export
  execution:
    service: desk-api
    method: reports.export
    resultMapping:
      exportId: \${ response.exportId }
    subscribe:
      service: realtime
      event: report:ready
      filter:
        exportId: \${ response.exportId }
      timeout: 20s
      resultMapping:
        fileUrl: \${ event.url }
        pages: \${ event.pages }
  outcome:
    produces: Report export
    async: true
    estimatedDuration: 5-20s
`;

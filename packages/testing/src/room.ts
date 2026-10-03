/**
 * A tier 3 room against the contract (ADR-0244 §2.8): its catalog matches the
 * published schema, and whatever it lists can be read. A room that reports a
 * list of things with ids and gives the assistant no way to read one of them
 * is a room the assistant can act in only by guessing.
 */
import {
  ROOM_INSPECT_ID,
  ROOM_QUERY_ID,
  declaredLists,
  roomListProblems,
  type JsonSchema,
  type RoomCatalogData,
  type RoomResult,
} from '@ouispec/bindings';
import { contractProblems } from '@ouispec/contract/validate';

import { describeError } from './harness.js';
import { ReportBuilder, type ConformanceReport } from './report.js';

export interface RoomSpec {
  /** The room, for the report. */
  name: string;
  /** The room's catalog as data (`agent-catalog.json`, or `catalogData(catalog)`). */
  catalog: unknown;
  /** Runs one of the catalog's actions against a room holding something to read, as its host does. */
  run(actionId: string, input: Record<string, unknown>): RoomResult | Promise<RoomResult>;
  /** What the room reports now, by observation id: the same room `run` reads. */
  observations: Readonly<Record<string, unknown>>;
}

type Row = Record<string, unknown>;

/** The rows a list holds in what the room reports, and how they are addressed. */
function reportedRows(catalog: RoomCatalogData, observations: Readonly<Record<string, unknown>>, list: string) {
  const [observationId, property] = list.split('/');
  const observation = catalog.observations.find(o => o.id === observationId)!;
  const schema = (property ? observation.schema.properties?.[property] : observation.schema) as JsonSchema;
  const reported = observations[observationId];
  const value = property ? (reported as Row | undefined)?.[property] : reported;
  return { rows: schema['x-rows']!, value: Array.isArray(value) ? (value as Row[]) : null };
}

export async function checkRoom(spec: RoomSpec): Promise<ConformanceReport> {
  const out = new ReportBuilder(spec.name);
  const problems = contractProblems('room-catalog-data.json', spec.catalog);
  if (!out.check('matches-contract', 'catalog', problems.length ? problems.join('; ') : null)) return out.report();
  const catalog = spec.catalog as RoomCatalogData;

  const declared = roomListProblems(catalog);
  out.check('lists-readable', 'declarations', declared.length ? declared.join('; ') : null);
  if (declared.length) return out.report();

  const run = async (id: string, input: Record<string, unknown>): Promise<RoomResult> => {
    try {
      return await spec.run(id, input);
    } catch (err) {
      return { ok: false, code: 'THREW', message: describeError(err) };
    }
  };

  for (const list of declaredLists(catalog)) {
    const { rows, value } = reportedRows(catalog, spec.observations, list);
    if (!out.check('lists-readable', list, value === null ? 'is declared, and the room reports no such list' : null)) continue;
    if (!out.check('lists-readable', list, value!.length === 0 ? 'is empty: check the room with something in it to read' : null)) continue;

    const queried = await run(ROOM_QUERY_ID, { list, limit: value!.length });
    const listed = queried.ok ? ((queried.data?.rows as Row[] | undefined) ?? []) : [];
    out.check(
      'lists-readable',
      `${list} › ${ROOM_QUERY_ID}`,
      !queried.ok
        ? `failed: ${queried.message}`
        : listed.length !== value!.length
        ? `lists ${listed.length} row(s), and the room reports ${value!.length}`
        : listed.some(row => typeof row[rows.ref] !== 'string' || row[rows.title] === undefined)
        ? `returns a row without its ${rows.ref} or its ${rows.title}`
        : listed.some((row, i) => row[rows.ref] !== value![i][rows.ref])
        ? 'lists rows in another order than the room reports them'
        : null,
    );

    const ref = String(value![0][rows.ref]);
    const inspected = await run(ROOM_INSPECT_ID, { refs: [ref] });
    const item = inspected.ok ? (inspected.data?.items as { list?: string; ref?: string; detail?: Row }[] | undefined)?.[0] : undefined;
    out.check(
      'lists-readable',
      `${list} › ${ROOM_INSPECT_ID}`,
      !inspected.ok
        ? `failed for ${ref}: ${inspected.message}`
        : !item || item.ref !== ref || item.list !== list
        ? `did not return ${ref} as a row of ${list}`
        : !item.detail || Object.keys(item.detail).length === 0
        ? `returned nothing about ${ref}`
        : null,
    );
  }
  return out.report();
}

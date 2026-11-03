/**
 * A long form for the live evals, in the runtime's own shape: a production
 * board (lines, figures, shots, graphics), one control per field per row, as a
 * form of that kind registers them. It goes through the real binding registry
 * and `connectBindings`, as a product's tab does, so what the worker is sent
 * and what `ui_describe` answers are what a product's page sends and answers.
 * A timeline room sits beside it, with state of its own, as an editor's does.
 */
import { createBindingRegistry, deriveInputSchema, deriveValueSchema, type ManifestAction, type OuiManifest } from '@ouispec/bindings';
import { connectBindings } from '@ouispec/bindings/oui';
import { createSurfaceRuntime, defineSurface } from 'oui-spec/core';
import type { OUIActionRequest } from 'oui-spec/spec';

import type { UIActionChannel } from '../../src/ui/channel.js';
import type { LivePage } from './live-page.js';

type Kind = 'choice' | 'text' | 'number' | 'button';
interface Option {
  value: string;
  title: string;
  description?: string;
}
interface Row {
  key: string;
  title: string;
  value?: unknown;
}
interface Field {
  id: string;
  title: string;
  description: string;
  kind: Kind;
  options?: Option[];
  min?: number;
  max?: number;
  rows?: Row[];
  /** A field of the board itself, not of a row. */
  value?: unknown;
}

/** Options as a form's pickers give them, with what each means where the control says. */
const options = (entries: ReadonlyArray<readonly [string, string, string?]>): Option[] =>
  entries.map(([value, title, description]) => ({ value, title, ...(description ? { description } : {}) }));

const LANGUAGES = options([
  ['en', 'English'], ['fr', 'French'], ['de', 'German'], ['es', 'Spanish'], ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['pl', 'Polish'],
  ['sv', 'Swedish'], ['no', 'Norwegian'], ['da', 'Danish'], ['fi', 'Finnish'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'], ['ar', 'Arabic'],
  ['hi', 'Hindi'], ['tr', 'Turkish'], ['ru', 'Russian'], ['uk', 'Ukrainian'],
]);
const FRAMINGS = options([['close', 'Close'], ['medium-close', 'Medium close'], ['medium', 'Medium'], ['medium-wide', 'Medium wide'], ['wide', 'Wide'], ['extreme-wide', 'Extreme wide']]);
const TRANSITIONS = options([
  ['cut', 'Cut', 'no transition; the next shot starts on the frame'],
  ['crossfade', 'Crossfade', 'the two shots blend over the transition’s length'],
  ['dip-black', 'Dip to black', 'fades out to black, then in from it'],
  ['dip-white', 'Dip to white', 'fades out to white, then in from it'],
  ['wipe-left', 'Wipe left', 'the next shot wipes in from the right edge'],
  ['wipe-right', 'Wipe right', 'the next shot wipes in from the left edge'],
  ['push-left', 'Push left', 'the next shot pushes this one out to the left'],
  ['push-right', 'Push right', 'the next shot pushes this one out to the right'],
  ['zoom-in', 'Zoom in', 'zooms through this shot into the next'],
  ['zoom-out', 'Zoom out', 'zooms back from this shot to the next'],
  ['blur', 'Blur', 'blurs through to the next shot'],
  ['flash', 'Flash', 'a short flash of white between the shots'],
]);
const KINDS = options([
  ['presenter', 'Presenter', 'a cast member speaks to camera; needs a line and someone cast'],
  ['broll', 'Generated footage', 'footage generated from the description, with a voice over it'],
  ['graphic', 'Graphic', 'a full-frame graphic from the library, with a voice over it'],
  ['screen', 'Screen recording', 'a recording from the media library, with a voice over it'],
]);
const ENGINES = options([['auto', 'Automatic'], ['live', 'Live presenter'], ['studio', 'Studio presenter'], ['footage', 'Footage model']]);
const TEMPLATES = options(
  ['Title', 'Lower third', 'KPI card', 'KPI wall', 'Chart card', 'End card'].flatMap((name, i) =>
    (['16:9', '9:16', '1:1'] as const).map((shape) => [`board-${i + 1}::${shape}`, `${name} · ${shape}`] as const),
  ),
);
const PURPOSES = options([
  ['title', 'Title', 'opens the video'], ['lower-third', 'Lower third', 'names who is speaking'], ['kpi-card', 'KPI card', 'one figure over footage'],
  ['kpi-wall', 'KPI wall', 'several figures, full frame'], ['chart-card', 'Chart card', 'a chart from the data, full frame'], ['end-card', 'End card', 'closes the video'],
]);
const LAYERS = options([['full-frame', 'Full frame', 'takes the whole frame for its shot'], ['overlay', 'Overlay', 'sits over the shot’s footage']]);
const AGGREGATES = options([['sum', 'Sum'], ['average', 'Average'], ['min', 'Minimum'], ['max', 'Maximum'], ['count', 'Count']]);
const FORMATS = options([['number', 'Number'], ['currency', 'Money'], ['percent', 'Percent'], ['compact', 'Short (1.2M)'], ['text', 'As written']]);
const COLUMNS = options([['month', 'month'], ['region', 'region'], ['revenue', 'revenue'], ['new_customers', 'new_customers']]);
const OPS = options([['eq', 'is'], ['ne', 'is not'], ['gt', 'is more than'], ['gte', 'is at least'], ['lt', 'is less than'], ['lte', 'is at most']]);
const VOICES = options(Array.from({ length: 24 }, (_, i) => [`voice-${i + 1}`, `Voice ${i + 1}`] as const));

const SHOTS = [
  { key: 'title', title: 'Shot 1: Graphic', kind: 'graphic', transition: 'cut', framing: 'medium-close', minimum: 3 },
  { key: 'open', title: 'Shot 2: Wilmer speaks to camera', kind: 'presenter', transition: 'cut', framing: 'medium-close', minimum: 0 },
  { key: 'team', title: 'Shot 3: A sales team celebrates around a desk', kind: 'broll', transition: 'cut', framing: 'medium-wide', minimum: 0 },
  { key: 'wall', title: 'Shot 4: Graphic', kind: 'graphic', transition: 'cut', framing: 'medium-close', minimum: 3 },
  { key: 'chart', title: 'Shot 5: Graphic', kind: 'graphic', transition: 'cut', framing: 'medium-close', minimum: 3 },
  { key: 'chart-line', title: 'Shot 6: Graphic', kind: 'graphic', transition: 'cut', framing: 'medium-close', minimum: 3 },
  { key: 'chart-area', title: 'Shot 7: Graphic', kind: 'graphic', transition: 'cut', framing: 'medium-close', minimum: 3 },
  { key: 'close', title: 'Shot 8: Wilmer nods and smiles', kind: 'presenter', transition: 'cut', framing: 'medium-close', minimum: 0 },
  { key: 'end', title: 'Shot 9: Graphic', kind: 'graphic', transition: 'cut', framing: 'medium-close', minimum: 3 },
];
const SHOT_OPTIONS = SHOTS.map((s) => ({ value: s.key, title: s.title }));
const LINES = [
  { key: 'intro', title: 'Hi, I’m Wilmer. Here’s how October went…', text: 'Hi, I’m Wilmer. Here’s how October went for the sales team.', speaker: 'wilmer', shot: 'open' },
  { key: 'revenue', title: 'October revenue reached {{octRevenue}}…', text: 'October revenue reached {{octRevenue}}, {{revenueChange}} on September.', speaker: 'narrator', shot: 'team' },
  { key: 'customers', title: 'We added {{newCustomers}} new customers…', text: 'We added {{newCustomers}} new customers across every region.', speaker: 'narrator', shot: 'wall' },
  { key: 'trend', title: 'Revenue has grown every month since July.', text: 'Revenue has grown every month since July.', speaker: 'narrator', shot: 'chart' },
  { key: 'outro', title: 'That’s October. Thanks for watching…', text: 'That’s October. Thanks for watching, and on to November.', speaker: 'wilmer', shot: 'close' },
];
const FIGURES = [
  { key: 'octRevenue', title: 'October revenue', column: 'revenue', format: 'currency' },
  { key: 'revenueChange', title: 'Revenue change', column: 'revenue', format: 'percent' },
  { key: 'newCustomers', title: 'New customers', column: 'new_customers', format: 'number' },
  { key: 'westRevenue', title: 'West revenue', column: 'revenue', format: 'currency' },
  { key: 'eastRevenue', title: 'East revenue', column: 'revenue', format: 'currency' },
];
const GRAPHICS = [
  { key: 'title-card', title: 'Title on shot 1', shot: 'title', layer: 'full-frame', purpose: 'title', template: 'board-1::16:9' },
  { key: 'name', title: 'Lower third on shot 2', shot: 'open', layer: 'overlay', purpose: 'lower-third', template: 'board-2::16:9' },
  { key: 'kpi', title: 'KPI card on shot 3', shot: 'team', layer: 'overlay', purpose: 'kpi-card', template: 'board-3::16:9' },
  { key: 'wall-card', title: 'KPI wall on shot 4', shot: 'wall', layer: 'full-frame', purpose: 'kpi-wall', template: 'board-4::16:9' },
  { key: 'chart-card', title: 'Chart card on shot 5', shot: 'chart', layer: 'full-frame', purpose: 'chart-card', template: 'board-5::16:9' },
  { key: 'chart-line-card', title: 'Chart card on shot 6', shot: 'chart-line', layer: 'full-frame', purpose: 'chart-card', template: 'board-5::16:9' },
  { key: 'chart-area-card', title: 'Chart card on shot 7', shot: 'chart-area', layer: 'full-frame', purpose: 'chart-card', template: 'board-5::16:9' },
  { key: 'end-card', title: 'End card on shot 9', shot: 'end', layer: 'full-frame', purpose: 'end-card', template: 'board-6::1:1' },
];

const rows = <T extends { key: string; title: string }>(list: readonly T[], value?: (row: T) => unknown): Row[] =>
  list.map((row) => ({ key: row.key, title: row.title, ...(value ? { value: value(row) } : {}) }));
const scale = (n: number) => Array.from({ length: n }, (_, copy) => copy);
/** The same board `times` over, each copy's keys its own, as a longer production is. */
const copied = <T extends { key: string; title: string }>(list: readonly T[], times: number): T[] =>
  scale(times).flatMap((copy) => list.map((row) => (copy === 0 ? row : { ...row, key: `${row.key}-${copy + 1}`, title: `${row.title} (${copy + 1})` })));

/** Every control of the board, in the order a form registers them: its sections from the top. */
export function boardFields(times = 1): Field[] {
  const shots = copied(SHOTS, times);
  const lines = copied(LINES, times);
  const figures = copied(FIGURES, times);
  const graphics = copied(GRAPHICS, times);
  const shotOptions = copied(SHOT_OPTIONS.map((o) => ({ ...o, key: o.value })), times).map((o) => ({ value: o.key, title: o.title }));
  return [
    { id: 'board.brief', title: 'Brief', description: 'What the production is about', kind: 'text', value: 'October end-of-month sales report from the sales dataset, Wilmer presents.' },
    { id: 'board.narrator', title: 'Narrator', description: 'The voice of lines nobody on camera speaks', kind: 'choice', options: VOICES, value: 'voice-2' },
    { id: 'board.cast.voice', title: 'Voice', description: 'The cast member’s voice', kind: 'choice', options: VOICES, rows: rows([{ key: 'wilmer', title: 'Wilmer' }], () => 'voice-1') },
    { id: 'board.cast.role', title: 'Role', description: 'The cast member’s role', kind: 'text', rows: rows([{ key: 'wilmer', title: 'Wilmer' }], () => 'presenter') },
    { id: 'board.line.text', title: 'Line', description: 'What the line says', kind: 'text', rows: rows(lines, (l) => l.text) },
    { id: 'board.line.speaker', title: 'Speaker', description: 'Who speaks the line', kind: 'choice', options: options([['wilmer', 'Wilmer'], ['narrator', 'Narrator']]), rows: rows(lines, (l) => l.speaker) },
    { id: 'board.line.language', title: 'Language', description: 'The language of the line', kind: 'choice', options: LANGUAGES, rows: rows(lines, () => 'en') },
    { id: 'board.line.delivery', title: 'Delivery', description: 'How the line is delivered', kind: 'text', rows: rows(lines, () => '') },
    { id: 'board.line.shot', title: 'Shot', description: 'The shot the line plays over', kind: 'choice', options: shotOptions.slice(0, 20), rows: rows(lines, (l) => l.shot) },
    { id: 'board.line.remove', title: 'Remove', description: 'Remove the line', kind: 'button', rows: rows(lines) },
    { id: 'board.figure.label', title: 'Label', description: 'What the figure is called', kind: 'text', rows: rows(figures, (f) => f.title) },
    { id: 'board.figure.column', title: 'Column', description: 'The dataset column the figure reads', kind: 'choice', options: COLUMNS, rows: rows(figures, (f) => f.column) },
    { id: 'board.figure.aggregate', title: 'Aggregate', description: 'How the column’s rows are combined', kind: 'choice', options: AGGREGATES, rows: rows(figures, () => 'sum') },
    { id: 'board.figure.format', title: 'Format', description: 'How the figure is written', kind: 'choice', options: FORMATS, rows: rows(figures, (f) => f.format) },
    { id: 'board.figure.filter-op', title: 'Filter', description: 'How a filter compares', kind: 'choice', options: OPS, rows: rows(figures, () => 'eq') },
    { id: 'board.figure.remove', title: 'Remove', description: 'Remove the figure', kind: 'button', rows: rows(figures) },
    { id: 'board.shot.kind', title: 'Kind', description: 'What kind of shot it is', kind: 'choice', options: KINDS, rows: rows(shots, (s) => s.kind) },
    { id: 'board.shot.framing', title: 'Framing', description: 'How the shot is framed', kind: 'choice', options: FRAMINGS, rows: rows(shots, (s) => s.framing) },
    { id: 'board.shot.engine', title: 'Engine', description: 'What makes the shot', kind: 'choice', options: ENGINES, rows: rows(shots, () => 'auto') },
    { id: 'board.shot.transition', title: 'Transition', description: 'How the shot starts from the one before it', kind: 'choice', options: TRANSITIONS, rows: rows(shots, (s) => s.transition) },
    { id: 'board.shot.min-duration', title: 'Least duration', description: 'The shortest the shot may be', kind: 'number', min: 0, max: 60, rows: rows(shots, (s) => s.minimum) },
    { id: 'board.shot.description', title: 'Description', description: 'What the shot shows', kind: 'text', rows: rows(shots, () => '') },
    { id: 'board.shot.remove', title: 'Remove', description: 'Remove the shot', kind: 'button', rows: rows(shots) },
    { id: 'board.graphic.template', title: 'Template', description: 'The library board the graphic is made from', kind: 'choice', options: TEMPLATES, rows: rows(graphics, (g) => g.template) },
    { id: 'board.graphic.shot', title: 'Shot', description: 'The shot the graphic belongs to', kind: 'choice', options: shotOptions.slice(0, 20), rows: rows(graphics, (g) => g.shot) },
    { id: 'board.graphic.layer', title: 'Layer', description: 'Whether the graphic fills the frame or sits over the shot', kind: 'choice', options: LAYERS, rows: rows(graphics, (g) => g.layer) },
    { id: 'board.graphic.purpose', title: 'Purpose', description: 'What the graphic is for', kind: 'choice', options: PURPOSES, rows: rows(graphics, (g) => g.purpose) },
    { id: 'board.graphic.in', title: 'Starts at', description: 'When the graphic starts in its shot', kind: 'number', min: 0, max: 600, rows: rows(graphics, () => 0) },
    { id: 'board.graphic.remove', title: 'Remove', description: 'Remove the graphic', kind: 'button', rows: rows(graphics) },
    { id: 'board.music.description', title: 'Music', description: 'The music to make for the production', kind: 'text', value: 'Warm, upbeat corporate bed: light piano, soft percussion, gentle bass, no vocals' },
    { id: 'board.music.level', title: 'Music level', description: 'How loud the music is under the voices', kind: 'number', min: -40, max: 0, value: -8 },
  ];
}

const nameOf = (id: string) => id.replace(/[.-]/g, '_');
const schemaOf = (field: Field) =>
  deriveValueSchema(field.kind, { options: field.options, ...(field.min !== undefined ? { min: field.min } : {}), ...(field.max !== undefined ? { max: field.max } : {}) });

function manifestAction(field: Field): ManifestAction {
  const itemized = !!field.rows;
  return {
    name: nameOf(field.id),
    id: field.id,
    source: 'control',
    control: field.kind,
    title: field.title,
    description: field.description,
    input: deriveInputSchema(field.kind, { options: field.options, min: field.min, max: field.max }, { itemized }),
    ...(itemized ? { itemized: true } : {}),
    reach: [],
  };
}

/** The timeline room's clips, as a room reports them: rather more than a row's key and title. */
function timelineState() {
  return {
    project: { name: 'October report', frameRate: 30, width: 1920, height: 1080, durationSeconds: 48 },
    tracks: ['Video 1', 'Graphics', 'Voice', 'Music'].map((name, t) => ({
      id: `track-${t + 1}`,
      name,
      clips: Array.from({ length: 12 }, (_, c) => ({
        id: `clip-${t + 1}-${c + 1}`,
        name: `${name} clip ${c + 1}`,
        startSeconds: c * 4,
        durationSeconds: 4,
        speed: 1,
        muted: false,
        opacity: 1,
        source: `asset-${t + 1}-${c + 1}`,
      })),
    })),
    selection: [],
    playheadSeconds: 0,
  };
}

/** The board and its timeline, as a tab holds them; what ran is what the page's handlers ran. */
export async function boardPage(times = 1): Promise<LivePage & { fields: Field[] }> {
  const fields = boardFields(times);
  const manifest: OuiManifest = {
    version: 1,
    buildId: 'board',
    surfaces: [
      {
        id: 'page:BoardPage',
        kind: 'page',
        title: 'Production board',
        description: 'A production’s brief, cast, lines, figures, shots, graphics and music.',
        routes: ['/board'],
        actions: fields.map(manifestAction),
        observations: [
          {
            id: 'state',
            description: `What the page shows now. values and lists: ${fields.map((f) => `${f.id} (${f.title})`).join(', ')}.`,
            schema: { type: 'object', properties: { values: { type: 'object' }, lists: { type: 'object' }, unavailable: { type: 'array', items: { type: 'string' } } } },
          },
        ],
      },
    ],
  };
  const runtime = createSurfaceRuntime({ form: 'index', announce: false, settle: { quietMs: 0, timeoutMs: 100 } });
  const registry = createBindingRegistry();
  connectBindings({ registry, runtime, manifest, navigation: undefined });
  const ran: LivePage['ran'] = [];
  const requests: OUIActionRequest[] = [];
  for (const field of fields) {
    const valueSchema = schemaOf(field);
    const register = (row?: Row) => {
      const handle = registry.registerControl({
        id: field.id,
        kind: field.kind,
        title: field.title,
        valueSchema,
        ...((row ? row.value : field.value) !== undefined ? { value: row ? row.value : field.value } : {}),
        ...(row ? { item: { key: row.key, title: row.title } } : {}),
        run: (input) => {
          ran.push({ action: nameOf(field.id), params: { ...(row ? { item: row.key } : {}), ...input } });
          if (input.value !== undefined) handle.update({ value: input.value });
          return { ok: true };
        },
      });
    };
    if (field.rows) field.rows.forEach(register);
    else register();
  }
  const timeline = defineSurface({
    id: 'room:timeline',
    name: 'Timeline',
    description: 'The video’s tracks and clips.',
    observations: [{ id: 'state', description: 'The tracks and clips', schema: { type: 'object' } }],
    actions: [
      {
        id: 'timeline_select_clips',
        description: 'Select clips on the timeline.',
        effect: 'view',
        input: { type: 'object', properties: { clipIds: { type: 'array', items: { type: 'string' } } }, required: ['clipIds'], additionalProperties: false },
        handler: async () => ({ success: true }),
      },
    ],
  });
  runtime.mount(timeline, () => ({})).pushObservation('state', timelineState());
  // The registry tells the runtime in a microtask, as it does when a page's controls mount.
  await Promise.resolve();

  const channel: UIActionChannel = {
    dispatch: async (_room, request) => {
      requests.push(request);
      return { acknowledged: 1, accepted: 1 };
    },
    awaitResult: async (requestId) => runtime.execute(requests.find((r) => r.requestId === requestId)!),
  };
  return { channel, snapshot: () => runtime.snapshot(), ran, requests, loseState: () => {}, fields };
}

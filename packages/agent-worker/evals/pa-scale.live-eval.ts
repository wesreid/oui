/**
 * Live scale eval (ADR-0245 §3.9): can the assistant work a page that offers
 * four hundred actions, one of them a whole catalogue, from its index?
 *
 * The page is the one PA session 618701bb failed on, in miniature: a studio
 * with 400 actions and an effect action whose input is a 90 KB union of sixty
 * effects. The model is given the page's index and three tools (`ui_act`,
 * `ui_describe`, `ui_read`), through the worker itself, and each scenario is
 * graded on the document afterwards, never on what the model says it did,
 * except where the scenario is about what it says.
 *
 * 1. **Find an action in the index** — rename a layer: one action among 400.
 * 2. **Open a catalogue by path** — add one effect of sixty with its own
 *    parameters: the definition is read in outline, one member is opened, and
 *    the action runs with it.
 * 3. **A kind the catalogue does not have** — the model looks the catalogue up,
 *    says the effect cannot be added, and adds nothing in its place.
 * 4. **Recover from a blind answer** — the first answer arrives without the
 *    page's state: the model reads the page before it changes anything else,
 *    and the document ends as asked, with nothing done twice.
 * 5. **Context** — the largest call of a turn on this page stays under 30,000
 *    tokens, where the definitions alone were about 154,000.
 *
 * Run: `pnpm --filter @ouispec/agent-worker eval:live` with Bedrock
 * credentials (e.g. `AWS_PROFILE=<profile> AWS_REGION=us-east-1`).
 * `EVAL_MODEL_ID` sets the model, `EVAL_RUNS` the runs per scenario, and
 * `EVAL_TEMPERATURE=none` sends no temperature, for a model that takes none.
 */
import { describe, expect, it } from 'vitest';
import { jsonBytes, type JSONSchema } from 'oui-spec/spec';

import { LIVE_MODEL_ID, livePage, liveTurn, type LiveAction } from './support/live-page.js';

const RUNS = Number(process.env.EVAL_RUNS ?? 3);

interface Layer {
  id: string;
  name: string;
  effects: Array<Record<string, unknown>>;
}

/** Sixty effects, as a studio's catalogue names them. Halftone is not one of them. */
const EFFECTS = [
  'glow', 'drop-shadow', 'inner-shadow', 'gaussian-blur', 'motion-blur', 'radial-blur', 'zoom-blur', 'outline', 'bevel', 'emboss',
  'long-shadow', 'neon', 'gradient-map', 'duotone', 'tint', 'hue-shift', 'saturation', 'brightness', 'contrast', 'exposure',
  'vignette', 'film-grain', 'noise', 'pixelate', 'mosaic', 'posterize', 'threshold', 'invert', 'sepia', 'grayscale',
  'chromatic-aberration', 'rgb-split', 'scanlines', 'vhs', 'glitch-blocks', 'wave', 'ripple', 'twirl', 'bulge', 'pinch',
  'fisheye', 'perspective', 'skew', 'mirror', 'kaleidoscope', 'tile', 'echo', 'trails', 'strobe', 'flicker',
  'light-sweep', 'lens-flare', 'bokeh', 'light-rays', 'fog', 'rain', 'snow', 'sparkle', 'confetti', 'fire',
];

function effectSchema(): JSONSchema {
  return {
    oneOf: EFFECTS.map((effect, e) => ({
      type: 'object',
      title: effect.replace(/-/g, ' '),
      required: effect === 'glow' ? ['effect', 'layerId', 'radius'] : ['effect', 'layerId'],
      additionalProperties: false,
      properties: {
        effect: { const: effect },
        layerId: { type: 'string', description: 'The id of the layer the effect is added to.' },
        ...(effect === 'glow'
          ? {
              radius: { type: 'number', minimum: 0, maximum: 100, 'x-unit': 'px', description: 'How far the glow reaches from the layer’s edge.' },
              colour: { type: 'string', description: 'The glow’s colour, as a CSS colour. Default: the layer’s fill.' },
              intensity: { type: 'number', minimum: 0, maximum: 1, 'x-unit': 'fraction', description: 'How strong the glow is at the edge.' },
            }
          : Object.fromEntries(
              Array.from({ length: 12 }, (_, p) => [
                `param_${p}`,
                { type: 'number', minimum: 0, maximum: 100, 'x-unit': 'px', description: `Parameter ${p} of ${effect} (effect ${e}): how far it reaches at the playhead.` },
              ]),
            )),
      },
    })),
  };
}

function studio() {
  const layers: Layer[] = [
    { id: 'ly-7f3a', name: 'Title', effects: [] },
    { id: 'ly-91bc', name: 'Subtitle', effects: [] },
    { id: 'ly-2d44', name: 'Logo', effects: [] },
    { id: 'ly-c0e8', name: 'Backdrop', effects: [] },
  ];
  let next = 1;
  const find = (id: unknown) => layers.find((l) => l.id === id);
  const noLayer = (id: unknown) => ({ success: false, error: { code: 'NO_LAYER', message: `No layer has the id "${String(id)}". Read the layers for their ids.` } });

  const actions: LiveAction[] = [
    {
      id: 'studio_layer_add',
      title: 'Add a layer',
      description: 'Adds an empty layer on top of the stack.',
      effect: 'edit',
      input: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', maxLength: 80 } } },
      run: (p) => {
        const layer = { id: `ly-new${next++}`, name: String(p.name), effects: [] };
        layers.push(layer);
        return { success: true, data: { added: layer.id } };
      },
    },
    {
      id: 'studio_layer_rename',
      title: 'Rename a layer',
      description: 'Gives a layer another name.',
      effect: 'edit',
      input: { type: 'object', required: ['id', 'name'], additionalProperties: false, properties: { id: { type: 'string', description: 'The layer’s id.' }, name: { type: 'string', maxLength: 80 } } },
      run: (p) => {
        const layer = find(p.id);
        if (!layer) return noLayer(p.id);
        layer.name = String(p.name);
        return { success: true, data: { renamed: layer.id } };
      },
    },
    {
      id: 'studio_layers_query',
      title: 'Query layers',
      description: 'Lists the layers with their ids, names and effects.',
      effect: 'view',
      input: { type: 'object', additionalProperties: false, properties: { name_contains: { type: 'string' } } },
      run: (p) => {
        const wanted = typeof p.name_contains === 'string' ? p.name_contains.toLowerCase() : '';
        return { success: true, data: { rows: layers.filter((l) => l.name.toLowerCase().includes(wanted)), total: layers.length } };
      },
    },
    {
      id: 'studio_effect_add',
      title: 'Add an effect',
      description: 'Adds an effect to a layer. Each effect takes its own parameters. Effects draw in the order they were added.',
      effect: 'edit',
      input: effectSchema(),
      run: (p) => {
        const layer = find(p.layerId);
        if (!layer) return noLayer(p.layerId);
        const { layerId: _layerId, ...effect } = p;
        layer.effects.push(effect);
        return { success: true, data: { added: p.effect, to: layer.id } };
      },
    },
    ...Array.from({ length: 396 }, (_, a): LiveAction => ({
      id: `studio_set_property_${a}`,
      title: `Set property ${a}`,
      description: `Sets property ${a} of the selected layers. It is one undo step.`,
      effect: 'edit',
      input: {
        type: 'object',
        required: ['value'],
        properties: {
          value: { type: 'number', minimum: 0, maximum: 1000, 'x-unit': 'px', description: `How far property ${a} reaches, from the layer's own origin.` },
          easing: { enum: ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'spring'], description: 'How the change is eased when it is animated.' },
        },
      },
    })),
  ];

  const page = livePage([
    {
      id: 'room:studio',
      name: 'Studio',
      description: 'The editor, with the vector studio docked: layers, their properties and their effects.',
      actions,
      observations: () => ({ layers: layers.map((l) => ({ ...l })) }),
    },
  ]);
  return { page, layers, definitionsBytes: jsonBytes(actions.map(({ run: _run, ...a }) => a)) };
}

function report(scenario: string, run: number, detail: Record<string, unknown>) {
  console.log(JSON.stringify({ eval: 'pa-scale', model: LIVE_MODEL_ID, scenario, run, ...detail }));
}

/** A sentence that says it cannot be done. */
const SAYS_CANNOT = /\b(can(?:no|')t|unable|not (?:able|possible|available|supported|offered|one of|among|in the)|(?:isn|aren|doesn|don)['’]?t|no (?:such|halftone)|does not (?:have|offer|include))\b/i;

describe(`pa-scale on ${LIVE_MODEL_ID}: a page of 400 actions, worked from its index`, () => {
  it('the page’s definitions would not fit a frame, and its index does', () => {
    const { page, definitionsBytes } = studio();
    expect(definitionsBytes).toBeGreaterThan(200 * 1024);
    expect(jsonBytes(page.snapshot())).toBeLessThan(128 * 1024);
  });

  for (let run = 1; run <= RUNS; run++) {
    it(`finds one action among 400 and runs it (run ${run})`, async () => {
      const { page, layers } = studio();
      const turn = await liveTurn(page, 'Rename the layer called Subtitle to Tagline.');
      report('find-in-index', run, { names: layers.map((l) => l.name), calls: turn.calls, peakPromptTokens: turn.usage.peakPromptTokens });
      expect(layers.map((l) => l.name)).toEqual(['Title', 'Tagline', 'Logo', 'Backdrop']);
      expect(page.ran.filter((r) => r.action !== 'studio_layers_query').map((r) => r.action)).toEqual(['studio_layer_rename']);
      // The largest call of the turn: tools, index, prompt and the page's state.
      expect(turn.usage.peakPromptTokens).toBeLessThan(30_000);
    }, 180_000);

    it(`opens one effect of sixty by path and adds it with its own parameters (run ${run})`, async () => {
      const { page, layers } = studio();
      const turn = await liveTurn(page, 'Add a glow to the Title layer, with a radius of 12.');
      const title = layers.find((l) => l.name === 'Title')!;
      report('open-by-path', run, { effects: title.effects, calls: turn.calls, peakPromptTokens: turn.usage.peakPromptTokens });
      expect(title.effects).toHaveLength(1);
      expect(title.effects[0]).toMatchObject({ effect: 'glow', radius: 12 });
      expect(layers.filter((l) => l !== title).every((l) => l.effects.length === 0)).toBe(true);
      // It read what the action takes before it used it: the index line only says "one of 60 shapes by effect".
      expect(turn.calls).toContain('ui_describe');
      expect(turn.usage.peakPromptTokens).toBeLessThan(30_000);
    }, 180_000);

    it(`says an effect the catalogue does not have cannot be added, and adds nothing in its place (run ${run})`, async () => {
      const { page, layers } = studio();
      const turn = await liveTurn(page, 'Add a halftone dot pattern effect to the Title layer.');
      // It may say so in its reply, or in the question it hands the turn back with.
      const said = `${turn.text}\n${turn.asked}`;
      report('not-in-catalogue', run, { effects: layers.map((l) => l.effects.length), calls: turn.calls, said: said.slice(0, 240) });
      expect(layers.every((l) => l.effects.length === 0), 'something was added in place of the halftone').toBe(true);
      expect(page.ran.filter((r) => r.action !== 'studio_layers_query')).toEqual([]);
      expect(said).toMatch(SAYS_CANNOT);
    }, 180_000);

    it(`reads the page again after an answer without its state, before changing anything else (run ${run})`, async () => {
      const { page, layers } = studio();
      // The answer to the first action arrives without the page's state.
      page.loseState(1);
      const turn = await liveTurn(page, 'Add a layer called Badge, then rename the Logo layer to Mark.');
      report('blind-recovery', run, { names: layers.map((l) => l.name), calls: turn.calls });
      expect(layers.map((l) => l.name)).toEqual(['Title', 'Subtitle', 'Mark', 'Backdrop', 'Badge']);
      // Nothing was done twice, and nothing was changed to find out what the page showed.
      expect(page.ran.filter((r) => r.action === 'studio_layer_add')).toHaveLength(1);
      expect(page.ran.filter((r) => r.action === 'studio_layer_rename')).toHaveLength(1);
      // Between the blind answer and the next change, the page was read.
      const sent = page.requests.map((r) => (r.surfaceId === 'oui' ? `oui.${r.actionId}` : r.actionId));
      const blindAt = sent.indexOf('studio_layer_add');
      const nextChange = sent.indexOf('studio_layer_rename');
      const between = sent.slice(blindAt + 1, nextChange);
      expect(between.some((id) => id === 'oui.read' || id === 'studio_layers_query'), `nothing read the page between the blind answer and the rename: ${sent.join(', ')}`).toBe(true);
    }, 180_000);
  }
});

import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { resolveKnowledge, toolInputProblems, type ManifestSurface } from '@ouispec/bindings';

import { generate, writeOrCheck, type GenerateResult } from '../src/index.js';
import { CATALOG, config, FIXTURE } from './fixture-config.js';
import ts from 'typescript';
import { UNKNOWN, evaluate } from '../src/program.js';

const surface = (surfaces: readonly ManifestSurface[], id: string) => {
  const s = surfaces.find(x => x.id === id);
  if (!s) throw new Error(`no surface ${id}: ${surfaces.map(x => x.id).join(', ')}`);
  return s;
};

describe('generate', () => {
  let result: GenerateResult;
  let surfaces: readonly ManifestSurface[];
  beforeAll(async () => {
    result = await generate(config());
    surfaces = result.manifest.surfaces;
  });

  it('finds every page, through wrappers and lazy imports, and no redirect or splat', () => {
    expect(surfaces.filter(s => s.kind === 'page').map(s => [s.id, s.routes])).toEqual([
      ['page:CreateVoicePage', ['/voices/create']],
      ['page:StudioPage', ['/studio']],
      ['page:UnboundPage', ['/unbound']],
      ['page:VoicesPage', ['/voices']],
    ]);
  });

  it('reports no problems for a correctly declared app', () => {
    expect(result.errors).toEqual([]);
  });

  it('names a page from the navigation and describes it from its header', () => {
    const voices = surface(surfaces, 'page:VoicesPage');
    expect(voices.title).toBe('Voices');
    expect(voices.description).toBe('Your voice library. Voices shared with your account.');
  });

  it('derives each action’s input from the control’s props', () => {
    const create = surface(surfaces, 'page:CreateVoicePage');
    const pitch = create.actions.find(a => a.name === 'create_pitch')!;
    expect(pitch.input.properties?.value).toMatchObject({
      type: 'number',
      minimum: -12,
      maximum: 12,
      multipleOf: 1,
      'x-unit': 'st',
    });
    const language = create.actions.find(a => a.name === 'create_language')!;
    expect(language.input.properties?.value?.enum).toEqual(['en', 'fr']);
  });

  it('builds a description from constants written once, and adds the field’s own hint and placeholder', () => {
    const style = surface(surfaces, 'page:CreateVoicePage').actions.find(a => a.name === 'create_style')!;
    expect(style.description).toContain(
      'The character style. A style names the character and describes only what a head-and-shoulders ' +
        'portrait shows. Good: "Maya, short black hair, a grey blazer"',
    );
    expect(style.description).toContain(
      "The field's hint: Only what a head-and-shoulders portrait shows; at most 1000 characters.",
    );
    expect(style.description).toContain(
      'Its placeholder, an example of what goes in it: "Name, face, hair and clothing".',
    );
    // A hint only known at run time is left out, so the output never depends on it.
    const notes = surface(surfaces, 'page:CreateVoicePage').actions.find(a => a.name === 'create_notes')!;
    expect(notes.description).not.toContain('hint');
  });

  it('reports what a page shows that is not a control, with its facts’ labels, and needs no binding to show it', () => {
    const voices = result.knowledge.pages.find(p => p.surface === 'page:VoicesPage')!;
    expect(voices.detail.content).toContain('What it shows (read it in its state, under shown, by id):');
    expect(voices.detail.content).toContain(
      '- Parameters (Engine, Seed) [voices.parameters]: The library’s generation parameters',
    );
    const state = surface(surfaces, 'page:VoicesPage').observations.find(o => o.id === 'state')!;
    expect(state.schema.properties?.shown).toBeDefined();
    // A display is not a control: it is neither a tool nor, unbound, a gap.
    expect(surface(surfaces, 'page:VoicesPage').actions.map(a => a.id)).not.toContain('voices.parameters');
    expect(result.errors.filter(e => e.message.includes('FactList'))).toEqual([]);
  });

  it('names no redirect as a page: neither a <Navigate> nor a component that only renders one', () => {
    const nav = surface(surfaces, 'app:navigation');
    expect(nav.routes).not.toContain('/old');
    expect(nav.routes).not.toContain('/voice/:id');
    expect(surfaces.some(s => s.id === 'page:RedirectKeepId')).toBe(false);
  });

  it('goes to any page by its address, from the routes, and says which page the person is on', () => {
    const nav = surface(surfaces, 'app:navigation');
    expect(nav.kind).toBe('navigation');
    const go = nav.actions.find(a => a.name === 'app_navigate')!;
    expect(go.source).toBe('navigation');
    const path = go.input.properties?.path as { description: string };
    for (const route of nav.routes) expect(path.description).toContain(route);
    expect(path.description).toContain('(Voices)');
    expect(nav.observations.map(o => o.id)).toEqual(['location', 'problems']);
    expect(result.knowledge.overview.content).toContain('[app_navigate]');
  });

  it('says why a page does not open, on the navigation surface, where it is seen when the page is not', () => {
    const problems = surface(surfaces, 'app:navigation').observations.find(o => o.id === 'problems')!;
    expect(problems.description).toContain('access it needs');
    expect(problems.schema.type).toBe('array');
  });

  it('ends the binding’s own words as a sentence before what it adds, such as the placeholder', () => {
    const name = surface(surfaces, 'page:CreateVoicePage').actions.find(a => a.name === 'create_name')!;
    expect(name.description).toContain(
      'The voice’s name. Required. Its placeholder, an example of what goes in it: "Warm narrator".',
    );
  });

  it('reads menu entries pushed onto an array, those pushed in a loop as rows of one action', () => {
    const create = surface(surfaces, 'page:CreateVoicePage');
    const mood = create.actions.find(a => a.name === 'create_mood')!;
    expect(mood.itemized).toBe(true);
    expect(mood.reach.at(-1)).toMatchObject({ kind: 'menu', title: 'Moods' });
    const clear = create.actions.find(a => a.name === 'create_mood_clear')!;
    expect(clear.itemized).toBeFalsy();
    expect(clear.title).toBe('Clear moods');
  });

  it('describes a job as started on return and done only when its status says complete', () => {
    const generate = surface(surfaces, 'page:CreateVoicePage').actions.find(a => a.name === 'create_generate')!;
    // Its timeout is a constant built from constants: 30 * MINUTE_MS.
    expect(generate.effect).toEqual({ kind: 'job', estimatedDuration: '10–20 s', timeoutMs: 1_800_000 });
    expect(generate.description).toContain(
      'It starts a job that takes about 10–20 s: the call returns once the job has started, ' +
        'and the job is done only when its status says complete.',
    );
  });

  it('reads menu entries made per row, each an item of one action', () => {
    const direction = surface(surfaces, 'page:CreateVoicePage').actions.find(
      a => a.name === 'create_direction',
    )!;
    expect(direction.itemized).toBe(true);
    expect(direction.reach.slice(1)).toEqual([{ kind: 'menu', title: 'Add direction' }]);
  });

  it('takes a binding a wrapper forwards from where the wrapper is used', () => {
    const create = surface(surfaces, 'page:CreateVoicePage');
    const forwarded = create.actions.filter(a =>
      ['create_accent_language', 'create_script_language'].includes(a.name),
    );
    expect(forwarded.map(a => [a.name, a.declaredIn, a.input.properties?.value?.enum])).toEqual([
      ['create_accent_language', 'src/pages/CreateVoicePage.tsx', ['en', 'fr']],
      ['create_script_language', 'src/pages/CreateVoicePage.tsx', ['en', 'fr']],
    ]);
    // A wrapper used several times in its own file is a binding per use.
    expect(
      create.actions.filter(a => ['create_subtitle_language', 'create_dub_language'].includes(a.name)),
    ).toHaveLength(2);
  });

  it('records where each control is: its tab, its dialog and what opens it, its row', () => {
    const voices = surface(surfaces, 'page:VoicesPage');
    const byName = Object.fromEntries(voices.actions.map(a => [a.name, a]));
    expect(byName.voices_rename.reach.slice(1)).toEqual([
      { kind: 'tab', binding: 'voices.library', value: 'account', title: 'Account Voices' },
    ]);
    expect(byName.voices_rename_name.reach.slice(1)).toEqual([
      { kind: 'dialog', binding: 'voices.rename-dialog', title: 'Rename', openedBy: ['voices.rename'] },
    ]);
    expect(byName.voices_bulk_delete_confirm.reach.slice(1)).toEqual([
      { kind: 'dialog', title: 'Delete Voices', openedBy: ['voices.bulk-delete'] },
    ]);
    expect(byName.voices_open.itemized).toBe(true);
    expect(byName.voices_open.input.required).toEqual(['item']);
    // A slot the control registers per row takes a row without the page naming one;
    // a slot a flag makes interactive (`sortable`) is bound like a callback's.
    expect(byName.voices_row.itemized).toBe(true);
    expect(byName.voices_row.input.required).toEqual(['item']);
    // The slot's own defaults widen its declared schema: a table's sort can be cleared.
    expect(byName.voices_sort.input.properties?.value?.type).toEqual(['string', 'null']);
    expect(byName.voices_open.input.properties?.value).toBeUndefined();
    expect(byName.voices_sort.itemized).toBeFalsy();
    // A slot with no callback is always interactive, and bound like any other.
    expect(byName.voices_play.input.properties?.value?.type).toBe('boolean');
    expect(byName.voices_bulk_delete.destructive).toBe(true);
    // Changing what the person works in, not their work: asked first, and not destructive.
    expect(byName.voices_switch_account.confirm).toBe(true);
    expect(byName.voices_switch_account.destructive).toBeUndefined();
    const page = result.knowledge.pages.find(p => p.surface === 'page:VoicesPage')!;
    expect(page.detail.content).toMatch(/\[voices_switch_account\][^\n]*confirm first/);
  });

  it('infers where a button goes from the literal it navigates to', () => {
    const add = surface(surfaces, 'page:VoicesPage').actions.find(a => a.name === 'voices_add')!;
    expect(add.effect).toEqual({ kind: 'navigate', to: '/voices/create' });
    expect(add.description).toContain('It goes to /voices/create.');
  });

  it('gives a room one tool per catalog action', () => {
    const room = surface(surfaces, 'room:demo-room');
    expect(room.routes).toEqual(['/studio']);
    expect(room.actions.map(a => a.name)).toEqual([
      'demo_room_add_text',
      'demo_room_run_command',
      'demo_room_select',
      'demo_room_set_properties',
      'demo_room_toggle_keyframe',
    ]);
    expect(room.actions.find(a => a.name === 'demo_room_add_text')!.description).toBe(
      'Add text: Sets a new text layer. (The Type tool (T))',
    );
    expect(room.observations.map(o => o.id)).toEqual(['document', 'problems']);
  });

  it('loads a room catalog the app declares, found through a generic hook it is passed to', () => {
    const board = surface(surfaces, 'room:demo-board');
    expect(board.routes).toEqual(['/studio']);
    expect(board.actions.map(a => [a.name, a.title])).toEqual([
      ['demo_board_save_png', 'Save PNG'],
      ['demo_board_save_svg', 'Save SVG'],
    ]);
  });

  it('refuses a room whose fields or commands have no generic action to reach them', async () => {
    const bare = {
      ...CATALOG,
      actions: CATALOG.actions.filter(a => a.id !== 'set-properties' && a.id !== 'run-command'),
      recipes: undefined,
    };
    const r = await generate(
      config({ catalogs: [{ package: '@closurestudio/demo-room', hosts: [], catalog: bare }] }),
    );
    expect(r.errors.map(e => e.message)).toEqual([
      'demo-room declares commands but no "run-command" action to run them',
      'demo-room declares fields but no "set-properties" action to set them',
    ]);
  });

  it('gives every tool it generates an object schema as its input, with no union at the top level', () => {
    const tools = surfaces.flatMap(s => s.actions.map(a => ({ tool: a.name, input: a.input })));
    expect(tools.length).toBeGreaterThan(10);
    for (const { tool, input } of tools) {
      expect({ tool, type: (input as { type?: unknown }).type, problems: toolInputProblems(input) }).toEqual({
        tool,
        type: 'object',
        problems: [],
      });
    }
  });

  it('fails the build on an action whose input is a union at the top level, or not an object, naming each', async () => {
    const union = {
      ...CATALOG,
      actions: [
        ...CATALOG.actions,
        {
          kind: 'action' as const,
          id: 'add-shape',
          title: 'Add a shape',
          description: 'Adds a shape of one of two kinds.',
          control: 'The Shape tool',
          input: {
            type: 'object' as const,
            properties: { kind: { type: 'string' as const } },
            oneOf: [
              { type: 'object' as const, properties: { kind: { const: 'circle' } } },
              { type: 'object' as const, properties: { kind: { const: 'square' } } },
            ],
          },
          effect: 'edit' as const,
        },
        {
          kind: 'action' as const,
          id: 'add-points',
          title: 'Add points',
          description: 'Adds points.',
          control: 'The Pen tool',
          input: { type: 'array' as const, items: { type: 'number' as const, 'x-unit': 'px' } },
          effect: 'edit' as const,
        },
      ],
    };
    const r = await generate(
      config({ catalogs: [{ package: '@closurestudio/demo-room', hosts: ['DemoRoom'], catalog: union }] }),
    );
    expect(r.errors.map(e => [e.file, e.message])).toEqual([
      [
        'room:demo-room',
        'demo-room/action/add-points (tool demo_room_add_points): its input\'s type is "array"; a tool’s input must be "type": "object"',
      ],
      [
        'room:demo-room',
        'demo-room/action/add-shape (tool demo_room_add_shape): its input has oneOf at the top level, which model providers refuse; put the alternatives inside a property and check them when it runs',
      ],
    ]);
  });

  it('generates knowledge: capabilities, reach, relationships and recipes', () => {
    const studio = resolveKnowledge(result.knowledge, '/studio');
    const text = studio.entries.map(e => `${e.title}\n${e.content}`).join('\n');
    expect(text).toContain('Add text [demo_room_add_text]');
    expect(text).toContain('text accepts: Tracking (tracking), Angle (angle)');
    expect(text).toContain('Keyframeable (set at the playhead, a keyframe there when animated): Angle');
    expect(text).toContain('Not built yet (their keys do nothing): Knife');
    expect(
      studio.workflows.map(w => w.name).filter(n => n.includes('Demo Room') || n.startsWith('Add text')),
    ).toEqual([
      'Change a property in the Demo Room',
      'Add text and style it',
      'Animate a property in the Demo Room',
      'Fix what the Demo Room reports',
    ]);

    const voices = resolveKnowledge(result.knowledge, '/voices');
    expect(voices.workflows.map(w => w.name)).toContain('Use the "Rename" dialog');
    const rename = voices.workflows.find(w => w.name === 'Use the "Rename" dialog')!;
    expect(rename.steps).toEqual([
      'Be on the "Account Voices" tab (select it with voices_library).',
      'Open it with voices_rename.',
      'Set what it asks for: Name [voices_rename_name].',
      expect.stringContaining('tell the user only what they confirm'),
    ]);
    // A page this one leads to is summarised alongside it.
    expect(voices.entries.map(e => e.title)).toContain('Create Voice');
  });

  it('infers no recipe from ids: a room that declares none has none, whatever its entries are called', async () => {
    const undeclared = { ...CATALOG, recipes: undefined };
    const r = await generate(config({ catalogs: [{ package: '@closurestudio/demo-room', hosts: ['DemoRoom'], catalog: undeclared }] }));
    expect(r.errors).toEqual([]);
    const names = resolveKnowledge(r.knowledge, '/studio').workflows.map(w => w.name);
    expect(names).not.toContain('Animate a property in the Demo Room');
    expect(names).toContain('Fix what the Demo Room reports');
  });

  it('is deterministic', async () => {
    const again = await generate(config());
    expect(again.files.map(f => f.content)).toEqual(result.files.map(f => f.content));
    expect(again.manifest.buildId).toBe(result.manifest.buildId);
  });

  it('writes, then checks clean, then reports a stale file', async () => {
    const cfg = config();
    const r = await generate(cfg);
    expect(writeOrCheck(r, cfg, false)).toEqual([]);
    expect(writeOrCheck(r, cfg, true)).toEqual([]);
    const changed = { ...r, files: r.files.map(f => ({ ...f, content: f.content + ' ' })) };
    expect(writeOrCheck(changed, cfg, true)).toHaveLength(2);
  });
});

describe('the app\'s frame', () => {
  it('is a shell surface on every page it frames, with the controls bound in it', async () => {
    const r = await generate(config());
    const shell = surface(r.manifest.surfaces, 'shell:Shell');
    expect(shell.kind).toBe('shell');
    expect(shell.routes).toEqual(['*']);
    expect(shell.actions.map(a => a.name)).toEqual(['shell_assistant']);
    // It is not a page: the page count and the map of the app leave it out.
    expect(r.manifest.surfaces.some(s => s.id === 'page:Shell')).toBe(false);
    expect(r.knowledge.pages.some(p => p.surface === 'shell:Shell')).toBe(false);
  });

  it('comes with the knowledge of every page it frames', async () => {
    const r = await generate(config());
    for (const path of ['/voices', '/studio']) {
      const text = resolveKnowledge(r.knowledge, path)
        .entries.map(e => `${e.title}\n${e.content}`)
        .join('\n');
      expect(text).toContain('the app’s frame, whatever page is open');
      expect(text).toContain('[shell_assistant]');
    }
  });

  it('is enforced as a page is, and may be listed as not yet bound', async () => {
    const bare = { shell: [{ module: 'src/BareShell.tsx', export: 'BareShell' }] };
    const enforced = await generate(config(bare));
    expect(enforced.errors.map(e => e.message)).toEqual([
      '<Button> has no agent binding (on BareShell, whose bindings are enforced)',
    ]);
    const allowed = await generate(config({ ...bare, unbound: ['UnboundPage', 'BareShell'] }));
    expect(allowed.errors).toEqual([]);
  });

  it('frames only the routes it names', async () => {
    const r = await generate(config({ shell: [{ module: 'src/Shell.tsx', export: 'Shell', routes: ['/voices'] }] }));
    expect(surface(r.manifest.surfaces, 'shell:Shell').routes).toEqual(['/voices']);
    const onStudio = resolveKnowledge(r.knowledge, '/studio').entries.map(e => e.content).join('\n');
    expect(onStudio).not.toContain('[shell_assistant]');
  });
});

describe('enforcement', () => {
  it('fails an unbound control on an enforced page', async () => {
    const r = await generate(config({ unbound: [] }));
    expect(r.errors.map(e => e.message)).toEqual([
      '<Button> has no agent binding (on UnboundPage, whose bindings are enforced)',
      '<LanguageField> passes no agent to the <Select> it renders (on UnboundPage, whose bindings are enforced)',
      '<SyncedMediaPlayer> has no agent binding for "play" (on UnboundPage, whose bindings are enforced)',
      "Entries of <DropdownMenu>'s `items` are built where the generator cannot read them (`menuFromServer()`): " +
        'build them as an array literal, a .map, or pushes of object literals (on UnboundPage, whose bindings are enforced)',
      'A raw <button> someone can use cannot carry a binding: use the design system\'s control, or data-non-agent="<reason>" (on UnboundPage, whose bindings are enforced)',
      // A key or pointer handler makes an element someone can use (ADR-0226 §2.5 row 3).
      'A raw <div> someone can use cannot carry a binding: use the design system\'s control, or data-non-agent="<reason>" (on UnboundPage, whose bindings are enforced)',
      'A raw <canvas> someone can use cannot carry a binding: use the design system\'s control, or data-non-agent="<reason>" (on UnboundPage, whose bindings are enforced)',
      // So does a callback on a component that is neither a design-system control nor a room host (row 2).
      '<Slider> from third-party-ui takes onValueChange, but is neither a design-system control nor a room host: ' +
        'use a bound control that does the same, or data-non-agent="<reason>" (on UnboundPage, whose bindings are enforced)',
      // And a design-system export its control table leaves out.
      "<Carousel> from @closurestudio/ui takes onSlide, but is not in @closurestudio/ui's control table: bind it there, " +
        'or data-non-agent="<reason>" (on UnboundPage, whose bindings are enforced)',
    ]);
    expect(r.errors[0].file).toBe('src/pages/UnboundPage.tsx');
  });

  it('fails an "unbound" entry for a page that is fully bound, so the list only shrinks', async () => {
    const r = await generate(config({ unbound: ['UnboundPage', 'VoicesPage'] }));
    expect(r.errors.map(e => e.message)).toEqual([
      'VoicesPage has every control bound: remove it from "unbound"',
    ]);
  });

  it('fails an "unbound" entry no route renders', async () => {
    const r = await generate(config({ unbound: ['UnboundPage', 'GonePage'] }));
    expect(r.errors.map(e => e.message)).toEqual(['"unbound" lists GonePage, which no route renders']);
  });
});

describe('evaluate: what is known without running anything', () => {
  const copy = join(FIXTURE, 'src', 'copy.ts');
  const program = ts.createProgram([copy], { strict: true, target: ts.ScriptTarget.ES2022 });
  const checker = program.getTypeChecker();
  const initializer = (name: string) => {
    let found: ts.Expression | undefined;
    ts.forEachChild(program.getSourceFile(copy)!, node => {
      if (!ts.isVariableStatement(node)) return;
      for (const d of node.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name) found = d.initializer;
      }
    });
    if (!found) throw new Error(`no const ${name}`);
    return found;
  };

  it('resolves a template literal of constants, numbers included', () => {
    expect(evaluate(checker, initializer('STYLE_HINT'))).toBe(
      'Only what a head-and-shoulders portrait shows; at most 1000 characters',
    );
  });

  it('resolves `+` over constants and a constant object’s property', () => {
    expect(evaluate(checker, initializer('STYLE_GUIDANCE'))).toBe(
      'A style names the character and describes only what a head-and-shoulders portrait shows. ' +
        'Good: "Maya, short black hair, a grey blazer"',
    );
  });

  it('reads a declared constant’s one value from its type, as a generated schema declares it', () => {
    expect(evaluate(checker, initializer('TONE_HINT'))).toBe('One word for the tone.');
    // A type that allows many values says nothing about which.
    expect(evaluate(checker, initializer('OPEN_TEXT'))).toBe(UNKNOWN);
  });

  it('does arithmetic on known numbers, and nothing with an unknown one', () => {
    expect(evaluate(checker, initializer('HALF_HOUR_MS'))).toBe(1_800_000);
    expect(evaluate(checker, initializer('OPEN_SUM'))).toBe(UNKNOWN);
  });

  it('refuses a value built by a call, and any text that contains one', () => {
    expect(evaluate(checker, initializer('JOINED'))).toBe(UNKNOWN);
    expect(evaluate(checker, initializer('WITH_JOINED'))).toBe(UNKNOWN);
  });
});


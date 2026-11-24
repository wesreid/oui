/**
 * An action family (`roomActionFamily`): near-identical room actions as one,
 * its input naming the member by `op`. Each member still runs exactly as it
 * did, its input checked against its own schema first; the members that cannot
 * be one action (a destructive one, another effect, a property that means
 * something else) are refused when the catalog is built, never at run time.
 */
import { indexEntry } from 'oui-spec/spec';
import { describe, expect, it } from 'vitest';

import { gatherRoomFamilies, offeredAction, roomFamilyMembers, roomActionFamily, roomChoices, RoomFamilyError, ROOM_FAMILY_KEY, type JsonSchema, type RoomAction } from '../src/index.js';

interface Doc {
  effects: Array<{ id: string; kind: string; amount: number; enabled: boolean }>;
}

const clipId: JsonSchema = { type: 'string', description: 'The clip’s id, as the timeline lists it' };
const effectId: JsonSchema = { type: 'string', description: 'The effect’s id on the clip' };

const add: RoomAction<Doc, { clipId: string; kind: string; amount?: number }> = {
  kind: 'action',
  id: 'clip-effect-add',
  title: 'Add an effect',
  description: 'Adds an effect to a clip: a blur, a glow or a grade, with its amount.',
  control: 'Effects panel › Add',
  effect: 'edit',
  input: {
    type: 'object',
    properties: { clipId, kind: { type: 'string', enum: ['blur', 'glow', 'grade'], description: 'Which effect' }, amount: { type: 'number', minimum: 0, maximum: 100, description: 'How strong, 0–100' } },
    required: ['clipId', 'kind'],
    additionalProperties: false,
  },
  run: (doc, i) => {
    const id = `fx${doc.effects.length + 1}`;
    doc.effects.push({ id, kind: i.kind, amount: i.amount ?? 50, enabled: true });
    return { ok: true, data: { effectId: id } };
  },
};
const set: RoomAction<Doc, { clipId: string; id: string; amount: number }> = {
  kind: 'action',
  id: 'clip-effect-set',
  title: 'Set an effect',
  description: 'Sets an effect’s amount.',
  control: 'Effects panel › the effect’s slider',
  effect: 'edit',
  input: {
    type: 'object',
    properties: { clipId, id: effectId, amount: { type: 'number', minimum: 0, maximum: 100, description: 'The new amount' } },
    required: ['clipId', 'id', 'amount'],
    additionalProperties: false,
  },
  run: (doc, i) => {
    const fx = doc.effects.find(e => e.id === i.id);
    if (!fx) return { ok: false, code: 'NO_SUCH_EFFECT', message: `No effect ${i.id}` };
    fx.amount = i.amount;
    return { ok: true, data: { amount: fx.amount } };
  },
};
const enable: RoomAction<Doc, { clipId: string; id: string; enabled: boolean }> = {
  kind: 'action',
  id: 'clip-effect-enable',
  title: 'Switch an effect',
  description: 'Switches an effect off, keeping it, or back on.',
  control: 'Effects panel › the effect’s switch',
  effect: 'edit',
  input: {
    type: 'object',
    properties: { clipId, id: effectId, enabled: { type: 'boolean', description: 'On or off' } },
    required: ['clipId', 'id', 'enabled'],
    additionalProperties: false,
  },
  run: (doc, i) => {
    const fx = doc.effects.find(e => e.id === i.id)!;
    fx.enabled = i.enabled;
    return { ok: true, data: { enabled: fx.enabled } };
  },
};

const family = () =>
  roomActionFamily<Doc>({
    id: 'clip-effect',
    title: 'Change a clip’s effects',
    description: 'Adds, sets or switches a clip’s effects.',
    control: 'The Effects panel',
    members: [add, set, enable] as RoomAction<Doc, never>[],
  });

describe('an action family', () => {
  it('is one action whose op names each member, each line in the form the app’s search reads', () => {
    const f = family();
    expect(f).toMatchObject({ kind: 'action', id: 'clip-effect', effect: 'edit' });
    const op = f.input.properties![ROOM_FAMILY_KEY];
    expect(op.enum).toEqual(['add', 'set', 'enable']);
    expect(op.description).toBe(
      'add = Add an effect: Adds an effect to a clip: a blur, a glow or a grade, with its amount. Needs clipId, kind.\n' +
        'set = Set an effect: Sets an effect’s amount. Needs clipId, id, amount.\n' +
        'enable = Switch an effect: Switches an effect off, keeping it, or back on. Needs clipId, id, enabled.',
    );
    expect(f.input.required).toEqual([ROOM_FAMILY_KEY]);
    // Each op's member by its own id, for a generator and a reason that names the member.
    expect(roomFamilyMembers(f.input)).toEqual(['clip-effect-add', 'clip-effect-set', 'clip-effect-enable']);
    // What every member takes keeps its words; what only some take says which.
    expect(f.input.properties!.clipId.description).toBe('The clip’s id, as the timeline lists it');
    expect(f.input.properties!.id.description).toBe('For set, enable: The effect’s id on the clip');
    expect(f.input.properties!.kind.description).toBe('For add: Which effect');
  });

  it('is one short index line that names its members, where three were', () => {
    const lines = [add, set, enable].map(a => indexEntry(offeredAction({ ...a, name: a.id } as never)));
    const one = indexEntry(offeredAction({ ...family(), name: 'clip-effect' } as never));
    expect(one.input.startsWith('op: add|set|enable')).toBe(true);
    const length = (e: { description: string; input: string }) => e.description.length + e.input.length;
    expect(length(one)).toBeLessThan(lines.reduce((n, e) => n + length(e), 0) * 0.6);
  });

  it('runs the member its op names, with what it takes, and the result is the member’s own', async () => {
    const f = family();
    const doc: Doc = { effects: [] };
    expect(await f.run(doc, { op: 'add', clipId: 'c1', kind: 'glow', amount: 30 })).toEqual({ ok: true, data: { effectId: 'fx1' } });
    expect(await f.run(doc, { op: 'set', clipId: 'c1', id: 'fx1', amount: 80 })).toEqual({ ok: true, data: { amount: 80 } });
    expect(await f.run(doc, { op: 'enable', clipId: 'c1', id: 'fx1', enabled: false })).toEqual({ ok: true, data: { enabled: false } });
    // The document the three left: one glow, at 80, switched off.
    expect(doc.effects).toEqual([{ id: 'fx1', kind: 'glow', amount: 80, enabled: false }]);
  });

  it('checks a call against its member’s own schema before running it, and changes nothing when it fails', async () => {
    const f = family();
    const doc: Doc = { effects: [] };
    const missing = await f.run(doc, { op: 'set', clipId: 'c1', amount: 10 });
    expect(missing).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect((missing as { message: string }).message).toMatch(/^set: .*id/);
    // A property another member takes is not this member's.
    expect(await f.run(doc, { op: 'add', clipId: 'c1', kind: 'glow', enabled: true })).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(await f.run(doc, { op: 'remove', clipId: 'c1' })).toEqual({
      ok: false,
      code: 'NO_SUCH_OP',
      message: 'remove is not one of clip-effect\'s: add, set, enable',
    });
    expect(doc.effects).toEqual([]);
  });

  it('gives the app’s search each member by its words, with its op to pass', () => {
    const f = family();
    expect(roomChoices({ name: 'video_editor_clip_effect', id: 'video-editor/action/clip-effect', source: 'room-action', title: f.title, description: f.description, input: f.input, reach: [] } as never)).toEqual([
      { property: 'op', id: 'add', title: 'Add an effect', what: 'Adds an effect to a clip: a blur, a glow or a grade, with its amount. Needs clipId, kind.' },
      { property: 'op', id: 'set', title: 'Set an effect', what: 'Sets an effect’s amount. Needs clipId, id, amount.' },
      { property: 'op', id: 'enable', title: 'Switch an effect', what: 'Switches an effect off, keeping it, or back on. Needs clipId, id, enabled.' },
    ]);
  });

  it('refuses members that cannot be one action, naming the family and the member', () => {
    const build = (members: RoomAction<Doc, never>[]) => () =>
      roomActionFamily<Doc>({ id: 'clip-effect', title: 't', description: 'd', control: 'c', members });
    const remove = { ...set, id: 'clip-effect-remove', destructive: true } as RoomAction<Doc, never>;
    expect(build([add, remove] as RoomAction<Doc, never>[])).toThrow(RoomFamilyError);
    expect(build([add, remove] as RoomAction<Doc, never>[])).toThrow('cannot hold clip-effect-remove: it is destructive');
    expect(build([add, { ...set, effect: 'view' }] as RoomAction<Doc, never>[])).toThrow('its effect is view');
    expect(build([add] as RoomAction<Doc, never>[])).toThrow('needs at least two members');
    const otherId = { ...enable, input: { ...enable.input, properties: { ...enable.input.properties, id: { type: 'integer' } } } };
    expect(build([set, otherId] as RoomAction<Doc, never>[])).toThrow('its id is not the id the others take');
    const takesOp = { ...set, input: { ...set.input, properties: { ...set.input.properties, op: { type: 'string' } } } };
    expect(build([add, takesOp] as RoomAction<Doc, never>[])).toThrow('it already takes op');
    expect(build([add, { ...set, id: 'clip-effect-add' }] as RoomAction<Doc, never>[])).toThrow('two members whose op is add');
  });
});

describe('a room’s families, declared by their members’ ids', () => {
  const other: RoomAction<Doc, never> = { ...add, id: 'split-clip', title: 'Split', description: 'Splits a clip.', input: { type: 'object', properties: {} } } as never;
  const remove: RoomAction<Doc, never> = { ...set, id: 'clip-effect-remove', title: 'Remove an effect', destructive: true } as never;
  const declared = [{ id: 'clip-effect', title: 'Change a clip’s effects', description: 'Adds, sets or switches a clip’s effects.', control: 'The Effects panel', members: ['clip-effect-add', 'clip-effect-set', 'clip-effect-enable'] }];

  it('puts each family where its first member was, and keeps every other action and its order', () => {
    const actions = gatherRoomFamilies([other, add, remove, set, enable] as RoomAction<Doc, never>[], declared);
    expect(actions.map(a => a.id)).toEqual(['split-clip', 'clip-effect', 'clip-effect-remove']);
    expect(actions[1].input.properties!.op.enum).toEqual(['add', 'set', 'enable']);
  });

  it('refuses a member the room does not have, or one two families claim', () => {
    expect(() => gatherRoomFamilies([add, set] as RoomAction<Doc, never>[], declared)).toThrow('names clip-effect-enable, which the room does not have');
    expect(() =>
      gatherRoomFamilies([add, set, enable] as RoomAction<Doc, never>[], [...declared, { ...declared[0], id: 'effects', members: ['clip-effect-set', 'clip-effect-enable'] }]),
    ).toThrow('clip-effect-set is in two families: clip-effect and effects');
  });
});

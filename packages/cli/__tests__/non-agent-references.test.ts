/**
 * A reason a control gives for not being the assistant's, when it names the
 * action the assistant uses instead, names one that exists.
 *
 * An editor's Add Asset button said "opens Add Asset, as the editor's
 * insert.media command does". The assistant was never shown that command, and
 * the person added the media by hand. A reason is a claim the build can check.
 */
import { describe, expect, it } from 'vitest';

import { nonAgentReferenceProblems } from '../src/assemble.js';
import { knownNames, namesAlternative } from '../src/non-agent.js';

const bindings = new Set(['editor.add-asset.open', 'library.place', 'video-editor/action/run-command']);
const commands = new Set(['insert.media', 'graphic.edit', 'tool.select']);
const problems = (reason: string) => nonAgentReferenceProblems(reason, bindings, commands);

describe('what a non-agent reason names', () => {
  it('passes a binding in parentheses and a command by name, when each exists', () => {
    expect(problems('opens Add Asset, as the Add Asset button in the header (editor.add-asset.open) does')).toEqual([]);
    expect(problems('opens Add Asset, as the editor’s insert.media command (run-command) does')).toEqual([]);
    expect(problems('places the composite as clicking its card does (library.place)')).toEqual([]);
    // A command may also be named in parentheses.
    expect(problems('the same as Edit Graphic (graphic.edit)')).toEqual([]);
  });

  it('fails a binding that is not there, naming it', () => {
    expect(problems('clears the filters, as the Clear beside them (editor.library.clear-filters) does')).toEqual([
      'A non-agent reason names "editor.library.clear-filters", which is no binding, room action or command of the app: name the action the assistant uses instead, or bind this control',
    ]);
  });

  it('fails a command no room has, naming it', () => {
    expect(problems('the same as the tool.razor command')).toEqual([
      'A non-agent reason names the command "tool.razor", which no room’s catalog has: name a command the assistant can run, or bind this control',
    ]);
  });

  it('reads nothing else in the sentence as a name', () => {
    expect(problems('the PA’s own chat chrome: it cannot switch, rename or delete the chat it is answering in')).toEqual([]);
    expect(problems('layout: arranging panels is arranging the screen, not the work (see the integrator guide)')).toEqual([]);
    expect(problems('a file input (hidden); e.g. the picker opens it')).toEqual([]);
    expect(problems('saves as v1.2 of the board')).toEqual([]);
  });

  it('reports each missing name once per mention', () => {
    expect(problems('as (a.b) and (c.d) do, or the x.y command')).toHaveLength(3);
  });
});

describe('a room action family’s members', () => {
  // As roomActionFamily writes it: the family is the action, each member named under x-members.
  const surfaces = [
    {
      actions: [
        {
          name: 'video_editor_segment',
          id: 'video-editor/action/segment',
          input: { properties: { op: { type: 'string', enum: ['add-segment', 'update-segment'], 'x-members': { 'add-segment': 'add-segment', 'update-segment': 'update-segment' } } } },
        },
      ],
    },
  ];

  it('are names the build has, by their own ids, so a reason naming one names the assistant’s way in', () => {
    const known = knownNames(surfaces, []);
    expect(known.has('update-segment')).toBe(true);
    expect(known.has('segment')).toBe(true);
    expect(namesAlternative('the editor catalog’s update-segment sets the same property', known)).toBe(true);
    expect(namesAlternative('the editor catalog’s remove-segment does it', known)).toBe(false);
  });
});

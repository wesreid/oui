import { describe, expect, it } from 'vitest';
import {
  AGENT_HIDDEN_WORK_TOOLS,
  agentWorkRuns,
  currentWorkStep,
  formatWorkStep,
  hasWords,
  humanizeToolName,
  workLabel,
  type AgentWorkMessage,
} from '../work/index.js';

const call = (name: string, extra: Partial<NonNullable<AgentWorkMessage['toolCall']>> = {}): AgentWorkMessage => ({
  role: 'tool',
  content: null,
  toolCall: { name, status: 'complete', ...extra },
});
const said = (text: string): AgentWorkMessage => ({ role: 'assistant', content: text });
const asked = (text: string): AgentWorkMessage => ({ role: 'user', content: text });
const labels = { vector_studio_add_shape: 'Draw a shape', vector_studio_draw_paths: 'Draw paths' };

describe('humanizeToolName', () => {
  it("names a tool by what it does, the room's prefix dropped and the verb first", () => {
    expect(humanizeToolName('vector_studio_set_keyframe')).toBe('Set keyframe');
    expect(humanizeToolName('vector_studio_rename')).toBe('Rename');
    expect(humanizeToolName('vector_studio_version_save')).toBe('Save version');
    expect(humanizeToolName('ui_describe')).toBe('Describe');
  });
});

describe('workLabel', () => {
  it("is the action's label on screen, or its name humanized", () => {
    expect(workLabel({ name: 'vector_studio_add_shape' }, { toolLabels: labels })).toBe('Draw a shape');
    expect(workLabel({ name: 'vector_studio_set_keyframe' }, { toolLabels: labels })).toBe('Set keyframe');
  });

  it('names an act call by the action it ran', () => {
    expect(workLabel({ name: 'ui_act', arguments: { action: 'vector_studio_add_shape', input: {} } }, { toolLabels: labels })).toBe(
      'Draw a shape',
    );
  });

  it('is null for bookkeeping, reading the page, a card, and a call that failed', () => {
    for (const name of AGENT_HIDDEN_WORK_TOOLS) expect(workLabel({ name })).toBeNull();
    expect(workLabel({ name: 'present_options' })).toBeNull();
    expect(workLabel({ name: 'vector_studio_add_shape', status: 'error' })).toBeNull();
  });
});

describe('formatWorkStep', () => {
  it('counts a step taken more than once', () => {
    expect(formatWorkStep({ label: 'Draw a shape', count: 12 })).toBe('Draw a shape · 12');
    expect(formatWorkStep({ label: 'Rename', count: 1 })).toBe('Rename');
  });
});

describe('hasWords', () => {
  it('is true for text, false for nothing, blank or a call', () => {
    expect(hasWords('Done.')).toBe(true);
    expect(hasWords([{ type: 'text', text: 'Done.' }])).toBe(true);
    expect(hasWords('  ')).toBe(false);
    expect(hasWords(null)).toBe(false);
    expect(hasWords([{ type: 'tool-call' }])).toBe(false);
  });
});

describe('agentWorkRuns', () => {
  it('groups calls taken without a word in between, counted by label in first-seen order', () => {
    const runs = agentWorkRuns(
      [
        asked('Build it'),
        call('vector_studio_add_shape'),
        call('ui_read'),
        call('vector_studio_draw_paths'),
        call('vector_studio_add_shape'),
        said('The badge is done; now the type.'),
        call('vector_studio_set_keyframe'),
      ],
      { toolLabels: labels },
    );
    expect(runs.map((r) => ({ from: r.from, to: r.to, steps: r.steps, last: r.last }))).toEqual([
      {
        from: 1,
        to: 4,
        steps: [
          { label: 'Draw a shape', count: 2 },
          { label: 'Draw paths', count: 1 },
        ],
        last: { label: 'Draw a shape', count: 2 },
      },
      { from: 6, to: 6, steps: [{ label: 'Set keyframe', count: 1 }], last: { label: 'Set keyframe', count: 1 } },
    ]);
  });

  it('ends a run at a card or the person', () => {
    const runs = agentWorkRuns([call('vector_studio_add_shape'), call('present_options'), call('vector_studio_add_shape'), asked('go'), call('vector_studio_add_shape')]);
    expect(runs.map((r) => r.from)).toEqual([0, 2, 4]);
  });
});

describe('currentWorkStep', () => {
  it("is the step of the turn's latest call while nothing has been said since", () => {
    const turn = [asked('Build it'), call('vector_studio_draw_paths'), call('vector_studio_draw_paths'), call('ui_read')];
    expect(currentWorkStep(turn, { toolLabels: labels })).toEqual({ label: 'Draw paths', count: 2 });
  });

  it('is null once the assistant speaks or offers a card, and before any work', () => {
    expect(currentWorkStep([asked('Build it'), call('vector_studio_add_shape'), said('Done.')])).toBeNull();
    expect(currentWorkStep([asked('Build it'), call('vector_studio_add_shape'), call('present_options')])).toBeNull();
    expect(currentWorkStep([asked('Build it')])).toBeNull();
  });
});

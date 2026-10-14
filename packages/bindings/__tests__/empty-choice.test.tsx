/**
 * A choice with nothing to choose is not offered.
 *
 * On dev (2026-10-14) the PA opened a new Experience, whose Video Project
 * picker had no options: the account's only published video was not in the
 * list it read. The picker's schema then had no enum, so the PA was offered a
 * free string; it typed the video's name, the page took the name for an
 * option's value (a Media Project id), and the request it made answered
 * "Project not found (HTTP 404)". Now a choice whose live options are all gone
 * is unavailable, as a disabled control is; once options arrive it is offered
 * with exactly their values, and a name that is not one is refused before the
 * page sees it.
 */
import { act, render } from '@testing-library/react';
import { useState } from 'react';
import { createSurfaceRuntime } from 'oui-spec/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createBindingRegistry,
  deriveInputSchema,
  deriveValueSchema,
  hasNothingToChoose,
  type OuiManifest,
} from '../src/index.js';
import { connectBindings } from '../src/oui.js';
import { AgentBindingProvider, useAgentBinding } from '../src/react.js';

/** The generated manifest, which declares a clearable choice as clearable. */
const manifestFor = (clearable: boolean): OuiManifest => ({
  version: 1,
  buildId: 'test',
  surfaces: [
    {
      id: 'page:ExperiencePage',
      kind: 'page',
      title: 'Experience',
      description: 'An Experience',
      routes: ['/experience'],
      actions: [
        {
          name: 'experience_video_project',
          id: 'experience.video.project',
          source: 'control',
          control: 'choice',
          title: 'Video Project',
          description: 'Choose the published Video Project the Experience plays',
          input: deriveInputSchema('choice', clearable ? { clearable } : {}),
          reach: [],
        },
      ],
      observations: [{ id: 'state', description: 'What the page shows', schema: { type: 'object' } }],
    },
  ],
});

type Option = { value: string; title: string; disabled?: boolean };

/** A picker whose options load after it mounts, as the Experience's Video Project picker's do. */
let setOptions: ((options: Option[]) => void) | null = null;
function Picker({ initial, clearable, chosen }: { initial: Option[]; clearable?: boolean; chosen: unknown[] }) {
  const [options, set] = useState(initial);
  setOptions = set;
  useAgentBinding({
    agent: { id: 'experience.video.project', description: 'Choose the published Video Project' },
    kind: 'choice',
    title: 'Video Project',
    schemaProps: { options, ...(clearable ? { clearable } : {}) },
    value: '',
    run: ({ value }) => {
      chosen.push(value);
    },
  });
  return null;
}

let disconnect: (() => void) | null = null;
afterEach(() => {
  disconnect?.();
  disconnect = null;
  setOptions = null;
});

async function mount(initial: Option[], clearable = false) {
  const chosen: unknown[] = [];
  const registry = createBindingRegistry();
  const runtime = createSurfaceRuntime({ announce: false, settle: { quietMs: 0, timeoutMs: 50 } });
  disconnect = connectBindings({ registry, runtime, manifest: manifestFor(clearable) });
  render(
    <AgentBindingProvider registry={registry}>
      <Picker initial={initial} clearable={clearable} chosen={chosen} />
    </AgentBindingProvider>,
  );
  await act(async () => {});
  const tool = () =>
    runtime
      .snapshot()
      .surfaces.flatMap(s => s.actions)
      .find(a => a.id === 'experience_video_project');
  const state = () =>
    runtime.snapshot().observations['page:ExperiencePage']?.state as { unavailable: string[] } | undefined;
  let n = 0;
  const choose = (value: unknown) =>
    act(() =>
      runtime.execute({
        requestId: `r${++n}`,
        surfaceId: 'page:ExperiencePage',
        actionId: 'experience_video_project',
        params: { value },
        timestamp: 0,
      }),
    );
  return { tool, state, choose, chosen };
}

const SPRING: Option = { value: 'mp_spring', title: 'Spring offer' };
const AUTUMN: Option = { value: 'mp_autumn', title: 'Autumn template' };

describe('a choice with nothing to choose', () => {
  it('is not offered and is listed unavailable; once options arrive it takes only their values', async () => {
    const page = await mount([]);
    expect(page.tool()).toBeUndefined();
    expect(page.state()?.unavailable).toEqual(['experience.video.project']);

    act(() => setOptions?.([SPRING, AUTUMN]));
    await act(async () => {});
    expect(page.tool()?.input.properties?.value?.enum).toEqual(['mp_spring', 'mp_autumn']);
    expect(page.state()?.unavailable).toEqual([]);

    // A name is not a value: refused before the page sees it.
    expect(await page.choose('Spring offer')).toMatchObject({ success: false, error: { code: 'INVALID_VALUE' } });
    expect(page.chosen).toEqual([]);

    expect((await page.choose('mp_spring')).success).toBe(true);
    expect(page.chosen).toEqual(['mp_spring']);
  });

  it('is unavailable again when every option it had is gone or disabled', async () => {
    const page = await mount([SPRING]);
    expect(page.tool()).toBeDefined();
    act(() => setOptions?.([{ ...SPRING, disabled: true }]));
    await act(async () => {});
    expect(page.tool()).toBeUndefined();
    expect(page.state()?.unavailable).toEqual(['experience.video.project']);
  });

  it('stays offered when it can be cleared, taking only null', async () => {
    const page = await mount([], true);
    expect(page.tool()?.input.properties?.value?.enum).toEqual([null]);
    expect(await page.choose('Spring offer')).toMatchObject({ success: false, error: { code: 'INVALID_VALUE' } });
    expect((await page.choose(null)).success).toBe(true);
    expect(page.chosen).toEqual([null]);
  });
});

describe('hasNothingToChoose and the schema of an empty choice', () => {
  it('holds for a choice or tabs whose live options are none, or all disabled', () => {
    expect(hasNothingToChoose('choice', { options: [] })).toBe(true);
    expect(hasNothingToChoose('tabs', { options: [] })).toBe(true);
    expect(hasNothingToChoose('choice', { options: [{ value: 'a', title: 'A', disabled: true }] })).toBe(true);
    expect(deriveValueSchema('choice', { options: [] })).toMatchObject({ type: 'string', enum: [] });
  });

  it('does not hold with an option left, for a clearable choice, without live options, or for other kinds', () => {
    expect(hasNothingToChoose('choice', { options: [{ value: 'a', title: 'A' }] })).toBe(false);
    expect(hasNothingToChoose('choice', { options: [], clearable: true })).toBe(false);
    expect(hasNothingToChoose('choice', {})).toBe(false);
    expect(deriveValueSchema('choice', {})).not.toHaveProperty('enum');
    expect(hasNothingToChoose('multi-choice', { options: [] })).toBe(false);
    expect(hasNothingToChoose('text', {})).toBe(false);
  });
});

/**
 * A question stands on its own: the card the user sees carries why it is asked.
 *
 * Measured live (ADR-0245, pa-scale "not in the catalogue"): after looking an
 * effect up, the model sometimes handed the turn back with only "Which
 * substitute should I add?", never saying the effect asked for does not exist.
 * Prompt wording moved that between 1 in 6 and 6 in 6 runs; a required
 * `context` the card shows above the question does not depend on wording.
 */
import { describe, expect, it } from 'vitest';
import { loadBuiltinTools } from '../tools/builtin-tools.js';

const presentOptions = () => loadBuiltinTools().find((t) => t.name === 'present_options')!;

describe('present_options', () => {
  it('requires the context the user needs before choosing', () => {
    expect((presentOptions().inputSchema as { required: string[] }).required).toEqual(['context', 'prompt', 'options']);
  });

  it('shows the context above the question on the card', async () => {
    const result = (await presentOptions().execute(
      {
        context: 'There is no halftone effect here, so I have not changed the Title layer.',
        prompt: 'Would you like a substitute instead?',
        options: [{ label: 'Pixelate', value: 'pixelate' }],
      },
      {} as never,
    )) as unknown as Record<string, unknown>;
    expect(result).toMatchObject({
      __present_options: true,
      prompt: 'There is no halftone effect here, so I have not changed the Title layer.\n\nWould you like a substitute instead?',
      style: 'buttons',
    });
  });

  it('shows the question alone when an older caller sends no context', async () => {
    const result = (await presentOptions().execute({ prompt: 'Which logo?', options: [] }, {} as never)) as unknown as Record<string, unknown>;
    expect(result.prompt).toBe('Which logo?');
  });
});

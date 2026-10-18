/**
 * Live behavioural eval: a question the person asks is answered in words.
 *
 * On Closure's dev (2026-10-18) a person on an Experience's Data panel asked
 * "What is the "push channel"?" twice. Both turns were one step with no text
 * (`textLength: 0`): the model answered each time with a `present_options` card
 * offering to set one up, and never said what a push channel is. The card's
 * `context` is a lead-in to a choice, not an answer.
 *
 * Graded on what the person reads (the turn's text, never the card) and on
 * what the page ran:
 *
 * - **Asked fresh**: the reply says what a push channel is, and nothing on the
 *   page is changed to answer it.
 * - **Asked after a card** (the dev conversation's own history): the same.
 * - **Asked again**: a question repeated after a card that did not answer it is
 *   answered.
 * - **A request (control)**: "set one up" is done, not explained, so a model
 *   that only ever talks cannot pass.
 *
 * Each case runs several times; every run must pass. Run as ui-offers.live-eval.ts says.
 */
import { describe, expect, it } from 'vitest';
import type { ResolvedKnowledge } from '@ouispec/bindings';

import { LIVE_MODEL_ID, livePage, liveTurn, type LiveAction } from './support/live-page.js';
import type { TurnHistoryMessage } from '../src/types.js';

const MODEL_ID = LIVE_MODEL_ID;
const RUNS = Number(process.env.EVAL_RUNS ?? 3);
const PATH = '/distribution/experiences/exp-1';

/** The slots of the video the Experience plays, as its Data panel lists them. */
const SLOTS = ['commissary_name', 'service_member_name'];

/** An Experience's Data panel: where each slot takes its value, data sources, push channels. */
function experienceData() {
  const channels: Array<{ id: string; name: string }> = [];
  let newName = '';
  const action = (id: string, description: string, properties: Record<string, unknown>, run?: LiveAction['run']): LiveAction => ({
    id,
    description,
    effect: 'edit',
    input: { type: 'object', properties: properties as never, required: Object.keys(properties), additionalProperties: false },
    ...(run ? { run } : {}),
  });
  return livePage([
    {
      id: 'page:ExperienceStudioPage',
      name: 'Experience Studio',
      description: 'An Experience: the published video it plays, where each slot takes its value, and how it is shared.',
      observations: () => ({
        state: {
          values: { 'experience.channels.new-name': newName },
          lists: {
            'experience.data.binding.from': SLOTS.map((slot) => ({ key: slot, title: slot, value: 'none' })),
            'experience.channels': channels.map((c) => ({ key: c.id, title: c.name })),
          },
        },
      }),
      actions: [
        action(
          'experience_data_binding_from',
          'Where a slot gets its value: a recipient token, a data source field, an engagement answer, a fixed value, or not bound.',
          { item: { enum: SLOTS }, value: { enum: ['none', 'token', 'source', 'answer', 'literal'] } },
        ),
        action('experience_data_source_add', 'Add a data source of a kind: a push channel, loaded once, polled, or a socket.', {
          value: { enum: ['channel', 'load', 'poll', 'socket'] },
        }),
        action('experience_channels_new_name', 'The name of a new push channel.', { value: { type: 'string' } }, (p) => {
          newName = String(p.value);
          return { success: true };
        }),
        action(
          'experience_channels_create',
          'Create channel: create a push channel with the name typed, starting with one text field to declare further.',
          {},
          () => {
            channels.push({ id: `ch-${channels.length + 1}`, name: newName || 'Channel' });
            return { success: true, data: { id: channels.at(-1)!.id } };
          },
        ),
        action('experience_channels_publish', "Publish test values: publish values to a push channel's viewers.", {
          item: { type: 'string' },
          values: { type: 'object' },
        }),
      ],
    },
  ]);
}

/** What the generator knows about the page, as Closure's studio sends it: controls, not ideas. */
const KNOWLEDGE: ResolvedKnowledge = {
  entries: [
    {
      title: 'Experience Studio (/distribution/experiences/:partId)',
      content: [
        'The Experience Studio page (/distribution/experiences/:partId).',
        '- Where a slot gets its value [experience_data_binding_from]: a recipient token, a data source field, an engagement answer, a fixed value, or not bound.',
        '- Add a data source [experience_data_source_add]: a push channel, loaded once, polled, or a socket.',
        "- Create channel [experience_channels_create] changes data: createExperienceChannel — Create a push channel: a name and the payload it accepts (field → slot type), in the account or a Work Project.",
        "- Publish test values [experience_channels_publish] changes data: publishExperienceChannelValues — Publish values to a push channel's viewers, or to one Delivery's viewer; validated against the channel's schema.",
        '- Save fields [experience_channels_save_fields]: Save a push channel’s fields; publishes are validated against them.',
      ].join('\n'),
    },
  ],
  workflows: [],
};

/** The dev conversation up to the second question: the first question, and the card it was answered with. */
const AFTER_A_CARD: TurnHistoryMessage[] = [
  {
    role: 'user',
    content:
      "What options do I have for setting up an experience with this video? I'd like to be able to put together some data that I can test this out with, but I don't know how to set this up at all.",
  },
  {
    role: 'assistant',
    content: "I'll open the Data panel and check what it offers.",
    tool_calls: [
      {
        id: 'call-card',
        type: 'function',
        function: {
          name: 'present_options',
          arguments: JSON.stringify({
            context: "Nothing is bound yet. I can set up whichever test route you pick, and I'd suggest the push channel.",
            prompt: 'Which way do you want to test this Experience?',
            options: [
              { label: 'Push channel with test values', value: 'Set up a push channel with test values', description: 'Define fields, publish values by hand, and bind the slots to them' },
              { label: 'Fixed values', value: 'Just type fixed values into the slots', description: 'The fastest way to see text in the video' },
              { label: 'Recipient tokens', value: 'Use recipient tokens with a sample contact', description: 'Personalise from contact details' },
            ],
            style: 'cards',
            allowCustom: true,
          }),
        },
      },
    ],
  },
  {
    role: 'tool',
    tool_call_id: 'call-card',
    name: 'present_options',
    content: JSON.stringify({ __present_options: true, prompt: 'Which way do you want to test this Experience?' }),
  },
];

/** A card that offered to set one up instead of saying what it is: the dev conversation's second turn. */
const ASKED_ONCE: TurnHistoryMessage[] = [
  ...AFTER_A_CARD,
  { role: 'user', content: 'What is the "push channel"?' },
  {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call-card-2',
        type: 'function',
        function: {
          name: 'present_options',
          arguments: JSON.stringify({
            context: "I'd start with the two name slots and add the Title and Subtitle slots afterwards.",
            prompt: 'Want me to set up that starter channel?',
            options: [{ label: 'Yes, set up the starter channel', value: 'Yes, set up the starter channel' }],
            style: 'buttons',
            allowCustom: true,
          }),
        },
      },
    ],
  },
  {
    role: 'tool',
    tool_call_id: 'call-card-2',
    name: 'present_options',
    content: JSON.stringify({ __present_options: true, prompt: 'Want me to set up that starter channel?' }),
  },
];

/** The reply says what a push channel is: it names one and what it carries or does. */
function explainsPushChannel(text: string): boolean {
  return /push channel/i.test(text) && /\b(values?|viewers?|live|while (?:it|the video) plays|publish(?:es|ed)?|sends?|pushe[sd]|updates?)\b/i.test(text);
}

const CHANGES_PAGE = new Set(['experience_data_binding_from', 'experience_data_source_add', 'experience_channels_create', 'experience_channels_publish']);

describe(`a question is answered in words (${MODEL_ID}, ${RUNS} runs each)`, () => {
  const cases: Array<[string, string, TurnHistoryMessage[]]> = [
    ['asked fresh', 'What is a push channel?', []],
    ['asked after a card', 'What is the "push channel"?', AFTER_A_CARD],
    ['asked again after a card that did not answer it', 'Can you tell me what a "push channel" is?', ASKED_ONCE],
  ];
  for (const [label, question, before] of cases) {
    it(`${label}: "${question}" — the reply says what it is, and nothing is changed to answer it`, async () => {
      for (let run = 0; run < RUNS; run++) {
        const page = experienceData();
        const { text, asked, calls } = await liveTurn(page, question, { path: PATH, before, knowledge: KNOWLEDGE, maxRounds: 4 });
        const ran = page.ran.map((r) => r.action);
        console.log(`[${run + 1}/${RUNS}] ${label}\n  said: ${JSON.stringify(text)}\n  asked: ${JSON.stringify(asked)}\n  calls: ${calls.join(', ') || 'none'}`);
        expect(explainsPushChannel(text), `run ${run + 1} did not say what a push channel is in its reply`).toBe(true);
        expect(ran.filter((name) => CHANGES_PAGE.has(name)), `run ${run + 1} changed the page to answer a question`).toEqual([]);
      }
    }, 300_000);
  }

  it('does what is asked, as a control: "Set up a push channel called Test values."', async () => {
    for (let run = 0; run < RUNS; run++) {
      const page = experienceData();
      const { calls } = await liveTurn(page, 'Set up a push channel called Test values.', { path: PATH, knowledge: KNOWLEDGE, maxRounds: 6 });
      const ran = page.ran.map((r) => r.action);
      console.log(`[${run + 1}/${RUNS}] control — calls: ${calls.join(', ') || 'none'}; ran: ${ran.join(', ') || 'nothing'}`);
      expect(ran, `run ${run + 1} did not create the channel`).toContain('experience_channels_create');
    }
  }, 300_000);
});

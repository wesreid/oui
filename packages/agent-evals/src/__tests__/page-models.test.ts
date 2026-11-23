/**
 * A part of the page rendered in code from its own state (`page.models`):
 * what a fixed `controls` cannot show, because each of those shows one way on
 * a page. A form asked one step at a time is the case here, as a product's
 * creator asks a kind's questions:
 *
 * - only the step's own field is shown, as the row of its answer control;
 * - Next is offered once the step is answered (an optional step may be left),
 *   Back from the second step on, and the last button once every required
 *   step is answered;
 * - what the form shows (`shown`) and its problems follow the answers;
 * - an agent walks it through `ui_act`, and what ran is the page's record;
 * - a recording knows the model's declarations (`identity`): change them and
 *   it replays as stale.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { conversationOf, messageText, type ChatRequest, type ScriptedReply } from '@ouispec/agent-worker/testing';
import { deriveInputSchema, deriveValueSchema, PROBLEMS_OBSERVATION_ID, PROBLEMS_SCHEMA, toolName, type OuiManifest } from '@ouispec/bindings';
import { OUI_READ_ACTION, OUI_RUNTIME_SURFACE, type OUIActionResult } from 'oui-spec/spec';
import type { AgentEvalPage, AgentEvalSuite } from '@ouispec/contract';
import { createFixturePage, EvalPageError, type EvalPage, type EvalPageModel, type EvalPageModelFactory } from '../page.js';
import { runEvals } from '../run.js';
import { configFor, recordWith, scratch } from './support.js';

const dirs: Array<() => void> = [];
afterAll(() => dirs.forEach((cleanup) => cleanup()));
const tempDir = () => {
  const s = scratch();
  dirs.push(s.cleanup);
  return s.dir;
};

// ─── The product: a form of questions, as its manifest declares it ──────────

type Kind = 'button' | 'text' | 'choice';
const control = (id: string, kind: Kind, title: string, itemized = false) => ({
  name: toolName(id),
  id,
  source: 'control' as const,
  control: kind,
  ...(itemized ? { itemized: true } : {}),
  title,
  description: `${title}.`,
  effect: 'edit' as const,
  input: deriveInputSchema(kind, {}, { itemized }),
  reach: [],
  declaredIn: 'form.tsx',
});

const FORM: OuiManifest = {
  version: 1,
  buildId: 'eval',
  surfaces: [
    {
      id: 'page:form',
      kind: 'page',
      title: 'New order',
      description: 'Its questions, one at a time, then Send.',
      routes: ['/orders/new'],
      actions: [
        control('form.answer.text', 'text', 'Text', true),
        control('form.answer.choice', 'choice', 'Choice', true),
        control('form.next', 'button', 'Next'),
        control('form.back', 'button', 'Back'),
        control('form.send', 'button', 'Send'),
        control('form.other', 'button', 'Other'),
      ],
      observations: [
        { id: 'state', description: 'What the page shows.', schema: { type: 'object' } },
        { id: PROBLEMS_OBSERVATION_ID, description: 'What is wrong that a person would see.', schema: PROBLEMS_SCHEMA },
      ],
      displays: [{ id: 'form.step', title: 'Step', description: 'Where the questions stand', labels: ['Step'] }],
    },
    { id: 'page:order', kind: 'page', title: 'Order', description: 'An order.', routes: ['/orders/:id'], actions: [], observations: [] },
  ],
};

/** The form's questions: the product's own declaration, which the model reads. */
interface Question {
  id: string;
  prompt: string;
  answer: 'text' | 'choice';
  required: boolean;
  options?: string[];
  /** Asked only when an earlier question is answered so. */
  showIf?: { question: string; equals: string };
}
const QUESTIONS: Question[] = [
  { id: 'what', prompt: 'What are you ordering?', answer: 'text', required: true },
  { id: 'size', prompt: 'Which size?', answer: 'choice', required: false, options: ['small', 'large'] },
  { id: 'engraving', prompt: 'What does the engraving say?', answer: 'text', required: true, showIf: { question: 'size', equals: 'large' } },
];

/** The form, rendered from its state as the product's component renders it. */
const formModel: EvalPageModelFactory = Object.assign(
  (data: Readonly<Record<string, unknown>>): EvalPageModel => {
    const answers: Record<string, string> = {};
    let step = 0;
    const visible = () => QUESTIONS.filter((q) => !q.showIf || answers[q.showIf.question] === q.showIf.equals);
    const missing = (q: Question) => q.required && !answers[q.id];
    return {
      owns: ['form.answer.text', 'form.answer.choice', 'form.next', 'form.back', 'form.send'],
      render(at) {
        if (!at.startsWith('/orders/new')) return null;
        const questions = visible();
        const question = questions[Math.min(step, questions.length)] ?? null;
        const field = question
          ? {
              [`form.answer.${question.answer}`]: {
                rows: [{ key: question.id, title: question.prompt, ...(answers[question.id] !== undefined ? { value: answers[question.id] } : {}) }],
                ...(question.options ? { valueSchema: deriveValueSchema('choice', { options: question.options.map((value) => ({ value, title: value })) })! } : {}),
              },
            }
          : {};
        return {
          controls: {
            ...field,
            'form.back': { disabled: step === 0 },
            ...(question ? { 'form.next': { disabled: missing(question) } } : { 'form.send': { disabled: questions.some(missing) } }),
          },
          shown: [{ id: 'form.step', facts: { Step: question ? `Question ${step + 1} of ${questions.length}: ${question.prompt}` : 'Send' } }],
          problems: question || !questions.some(missing) ? [] : [{ source: 'form.send', problems: questions.filter(missing).map((q) => ({ kind: 'invalid', message: `“${q.prompt}” needs an answer` })) }],
        };
      },
      run({ control: id, input }) {
        if (id === 'form.next') step++;
        else if (id === 'form.back') step--;
        else if (id === 'form.send') return { navigate: String(data.sent), result: { success: true, data: { orderId: 'o-1' } } };
        else if (typeof input.value === 'string') {
          if (input.value) answers[String(input.item)] = input.value;
          else delete answers[String(input.item)];
        }
      },
    };
  },
  { identity: { questions: QUESTIONS } },
);

const FIXTURE: AgentEvalPage = { at: '/orders/new', models: { form: { sent: '/orders/o-1' } } };

// ─── Reading and acting on the page as the agent does ────────────────────────

let requests = 0;
async function execute(page: EvalPage, actionId: string, params: Record<string, unknown> = {}, surfaceId = 'page:form'): Promise<OUIActionResult> {
  const requestId = `m${++requests}`;
  await page.channel.dispatch('eval-room', { requestId, surfaceId, actionId, params, timestamp: 0 });
  return (await page.channel.awaitResult(requestId, { userId: 'u-1', timeoutMs: 1_000 }))!;
}
interface PageState {
  values?: Record<string, unknown>;
  lists?: Record<string, Array<{ key: string; title: string }>>;
  unavailable?: string[];
  shown?: Array<{ id: string; facts: Record<string, string> }>;
}
const stateOf = async (page: EvalPage) =>
  ((await execute(page, OUI_READ_ACTION, { surface: 'page:form', observation: 'state' }, OUI_RUNTIME_SURFACE)).data as { value: PageState }).value;
const offered = async (page: EvalPage) => {
  const index = ((await page.context()).oui as { index: Array<{ id: string; index: Array<{ id: string }> }> }).index;
  return (index.find((s) => s.id === 'page:form')?.index ?? []).map((a) => a.id).sort();
};

describe('a form asked one step at a time, rendered by a page model', () => {
  it('shows only the step’s field, offers Next once it is answered, and Send once every required step is', async () => {
    const page = createFixturePage(FIXTURE, { manifest: FORM, models: { form: formModel } });
    try {
      let state = await stateOf(page);
      expect(state.lists).toEqual({ 'form.answer.text': [{ key: 'what', title: 'What are you ordering?' }] });
      expect(state.shown).toEqual([{ id: 'form.step', title: 'Step', facts: { Step: 'Question 1 of 2: What are you ordering?' } }]);
      // Next and Back are on the page, and cannot be used yet; Send is not shown before the last step.
      expect(state.unavailable).toEqual(expect.arrayContaining(['form.next', 'form.back']));
      expect(await offered(page)).toEqual([toolName('form.answer.text')]);
      expect((await execute(page, toolName('form.next'))).success).toBe(false);

      expect((await execute(page, toolName('form.answer.text'), { item: 'what', value: 'A watch' })).success).toBe(true);
      expect(await offered(page)).toEqual([toolName('form.answer.text'), toolName('form.next')]);
      await execute(page, toolName('form.next'));
      // The optional choice: its options are the step's own, and Next is offered unanswered.
      state = await stateOf(page);
      expect(state.lists).toEqual({ 'form.answer.choice': [{ key: 'size', title: 'Which size?' }] });
      expect(await offered(page)).toEqual([toolName('form.answer.choice'), toolName('form.back'), toolName('form.next')].sort());
      // Choosing large asks one more, required, question.
      await execute(page, toolName('form.answer.choice'), { item: 'size', value: 'large' });
      expect((await stateOf(page)).shown![0].facts.Step).toBe('Question 2 of 3: Which size?');
      await execute(page, toolName('form.next'));
      await execute(page, toolName('form.next')).then((r) => expect(r.success).toBe(false));
      await execute(page, toolName('form.back'));
      await execute(page, toolName('form.back'));
      // Back keeps what was answered; Back, disabled by its own press, is busy for a moment, as the product's is.
      state = await stateOf(page);
      expect(state.lists).toEqual({ 'form.answer.text': [{ key: 'what', title: 'What are you ordering?', value: 'A watch' }] });
      await execute(page, toolName('form.next'));
      await execute(page, toolName('form.next'));
      await execute(page, toolName('form.answer.text'), { item: 'engraving', value: 'For A.' });
      await execute(page, toolName('form.next'));
      state = await stateOf(page);
      expect(state.shown![0].facts.Step).toBe('Send');
      expect(state.unavailable ?? []).not.toContain('form.send');
      const sent = await execute(page, toolName('form.send'));
      expect(sent.success).toBe(true);
      expect(sent.data).toMatchObject({ orderId: 'o-1' });
      expect(page.location()).toBe('/orders/o-1');
      // Away from the form, nothing of it is shown.
      expect(await offered(page)).toEqual([]);
      // What could not be used never ran: the refused Next is not in the page's record.
      expect(page.ran.map((r) => [r.action, r.input])).toEqual([
        ['form_answer_text', { item: 'what', value: 'A watch' }],
        ['form_next', {}],
        ['form_answer_choice', { item: 'size', value: 'large' }],
        ['form_next', {}],
        ['form_back', {}],
        ['form_back', {}],
        ['form_next', {}],
        ['form_next', {}],
        ['form_answer_text', { item: 'engraving', value: 'For A.' }],
        ['form_next', {}],
        ['form_send', {}],
      ]);
    } finally {
      page.close();
    }
  });

  it('reports the problems the model shows, by the area that shows them, while it shows them', async () => {
    const notice: EvalPageModelFactory = () => {
      let open = true;
      return {
        render: (at) =>
          at.startsWith('/orders/new')
            ? {
                controls: { 'form.other': {} },
                problems: open ? [{ source: 'form.send', problems: [{ kind: 'invalid', message: '“What are you ordering?” needs an answer' }] }] : [],
              }
            : null,
        run: () => {
          open = false;
        },
      };
    };
    const page = createFixturePage(FIXTURE, { manifest: FORM, models: { form: notice } });
    try {
      const problems = async () => ((await page.context()).oui as { observations: Record<string, Record<string, unknown>> }).observations['page:form']?.[PROBLEMS_OBSERVATION_ID];
      expect(await problems()).toEqual([{ kind: 'invalid', message: '“What are you ordering?” needs an answer' }]);
      await execute(page, toolName('form.other'));
      expect(await problems()).toEqual([]);
    } finally {
      page.close();
    }
  });

  it('refuses a model the configuration does not give, one it cannot make, and a control that is the fixture’s too', () => {
    expect(() => createFixturePage(FIXTURE, { manifest: FORM })).toThrow(/gives no page model "form"/);
    const broken: EvalPageModelFactory = () => {
      throw new Error('no questions given');
    };
    expect(() => createFixturePage(FIXTURE, { manifest: FORM, models: { form: broken } })).toThrow(/"form" cannot be made from its data: no questions given/);
    expect(() => createFixturePage({ ...FIXTURE, controls: { 'form.next': {} } }, { manifest: FORM, models: { form: formModel } })).toThrow(
      /the control "form.next" is the page model "form"’s and the fixture’s/,
    );
    const stray: EvalPageModelFactory = () => ({ render: () => ({ controls: { 'form.nope': {} } }), run: () => undefined });
    expect(() => createFixturePage(FIXTURE, { manifest: FORM, models: { form: stray } })).toThrow(EvalPageError);
    expect(() => createFixturePage(FIXTURE, { models: { form: formModel } })).toThrow(/`models` renders the product’s controls/);
  });

  it('mounts `allControls` around what a model shows, never over it', async () => {
    const page = createFixturePage({ ...FIXTURE, allControls: true }, { manifest: FORM, models: { form: formModel } });
    try {
      // The other button is mounted empty; Send is the model's, and not shown before the last step.
      expect(await offered(page)).toEqual([toolName('form.answer.text'), toolName('form.other')].sort());
    } finally {
      page.close();
    }
  });
});

// ─── An agent walking it, recorded and replayed ──────────────────────────────

const lastTool = (request: ChatRequest) => {
  const last = conversationOf(request).at(-1);
  return last?.role === 'tool' ? messageText(last) : null;
};

describe('an agent walking a modelled form', () => {
  const suite: AgentEvalSuite = {
    version: 1,
    name: 'orders',
    page: FIXTURE,
    scenarios: [
      {
        id: 'order-a-watch',
        title: 'Answers the questions one at a time, and sends',
        turns: [
          {
            user: 'Order a small watch.',
            expect: {
              page: {
                ran: [
                  { action: 'form_answer_text', input: { item: 'what', value: 'A watch' } },
                  { action: 'form_answer_choice', input: { item: 'size', value: 'small' } },
                  { action: 'form_send' },
                ],
                at: '/orders/o-1',
              },
            },
          },
        ],
      },
    ],
  };
  const steps: Array<{ action: string; input: Record<string, unknown> }> = [
    { action: 'form_answer_text', input: { item: 'what', value: 'A watch' } },
    { action: 'form_next', input: {} },
    { action: 'form_answer_choice', input: { item: 'size', value: 'small' } },
    { action: 'form_next', input: {} },
    { action: 'form_send', input: {} },
  ];
  const model = (request: ChatRequest): ScriptedReply | undefined => {
    const done = conversationOf(request).filter((m) => m.role === 'tool').length;
    if (done > 0 && /"error"/.test(lastTool(request) ?? '')) return { text: `Step ${done} failed: ${lastTool(request)}` };
    const next = steps[done];
    return next ? { toolCalls: [{ id: `s${done}`, name: 'ui_act', args: next }] } : { text: 'Sent: order o-1.' };
  };
  const agentConfig = () => ({
    persona: { name: 'Ava', identity: 'You are Ava.', instructions: [], overrides: { disableUIControlRules: true } },
    tools: [],
    toolPolicy: { evaluate: async () => ({ action: 'allow' as const }) },
  });

  it('runs each step on the page as the product would, and replays as stale once the model’s declarations change', async () => {
    const cassettes = tempDir();
    const config = configFor(cassettes, { suites: [suite], channels: { web_chat: {} }, page: { manifest: FORM, models: { form: formModel } }, agent: agentConfig });
    const { result } = await recordWith(model, () => runEvals(config, { mode: 'record' }));
    expect(result.cases[0].turns[0].reply).toBe('Sent: order o-1.');
    expect(result.cases[0].failures).toEqual([]);

    expect((await runEvals(config)).cases[0].failures).toEqual([]);
    const changed: EvalPageModelFactory = Object.assign((data: Readonly<Record<string, unknown>>) => formModel(data), {
      identity: { questions: QUESTIONS.slice(0, 2) },
    });
    const stale = await runEvals({ ...config, page: { manifest: FORM, models: { form: changed } } });
    expect(stale.cases[0].failures.map((f) => f.assertion)).toEqual(['recording']);
  });
});

describe('what the case has left done (`page.ranInCase`)', () => {
  // The agent answers what it can, asks the person the rest, and finishes on their answer: each answer may come in either turn.
  const suite: AgentEvalSuite = {
    version: 1,
    name: 'orders, asked',
    page: FIXTURE,
    scenarios: [
      {
        id: 'order-asked',
        title: 'Answers, asks the size, and sends on the answer',
        turns: [
          { user: 'Order a watch.', expect: { page: { ran: [{ action: 'form_answer_text', input: { item: 'what' } }], notRan: ['form_send'] } } },
          {
            user: 'Large, engraved "For A."',
            expect: {
              page: {
                ranInCase: [
                  { action: 'form_answer_text', input: { item: 'what', value: 'A watch' } },
                  { action: 'form_answer_choice', input: { item: 'size', value: 'large' } },
                  { action: 'form_answer_text', input: { item: 'engraving', value: 'For A.' } },
                ],
                ran: [{ action: 'form_send' }],
                at: '/orders/o-1',
              },
            },
          },
        ],
      },
    ],
  };
  const turns: Array<Array<{ action: string; input: Record<string, unknown> }>> = [
    [
      { action: 'form_answer_text', input: { item: 'what', value: 'A watch' } },
      { action: 'form_next', input: {} },
    ],
    [
      { action: 'form_answer_choice', input: { item: 'size', value: 'small' } },
      { action: 'form_answer_choice', input: { item: 'size', value: 'large' } },
      { action: 'form_next', input: {} },
      { action: 'form_answer_text', input: { item: 'engraving', value: 'For A.' } },
      { action: 'form_next', input: {} },
      { action: 'form_send', input: {} },
    ],
  ];
  const model = (request: ChatRequest): ScriptedReply | undefined => {
    const messages = conversationOf(request);
    const users = messages.filter((m) => m.role === 'user').length;
    const lastUser = messages.map((m) => m.role).lastIndexOf('user');
    const done = messages.slice(lastUser).filter((m) => m.role === 'tool').length;
    const plan = turns[users - 1];
    const next = plan[done];
    if (next) return { toolCalls: [{ id: `t${users}-${done}`, name: 'ui_act', args: next }] };
    return { text: users === 1 ? 'Which size, and what should the engraving say?' : 'Sent: order o-1.' };
  };
  const agentConfig = () => ({
    persona: { name: 'Ava', identity: 'You are Ava.', instructions: [], overrides: { disableUIControlRules: true } },
    tools: [],
    toolPolicy: { evaluate: async () => ({ action: 'allow' as const }) },
  });

  it('holds an answer given in an earlier turn, and reads a row’s answer from its last run', async () => {
    const config = configFor(tempDir(), { suites: [suite], channels: { web_chat: {} }, page: { manifest: FORM, models: { form: formModel } }, agent: agentConfig });
    const { result } = await recordWith(model, () => runEvals(config, { mode: 'record' }));
    expect(result.cases[0].failures).toEqual([]);
  });

  it('fails when the last answer of a row is not the one wanted, naming it', async () => {
    const wrong: AgentEvalSuite = {
      ...suite,
      scenarios: [
        {
          ...suite.scenarios[0],
          turns: [suite.scenarios[0].turns[0], { ...suite.scenarios[0].turns[1], expect: { page: { ranInCase: [{ action: 'form_answer_choice', input: { item: 'size', value: 'small' } }] } } }],
        },
      ],
    };
    const config = configFor(tempDir(), { suites: [wrong], channels: { web_chat: {} }, page: { manifest: FORM, models: { form: formModel } }, agent: agentConfig });
    const { result } = await recordWith(model, () => runEvals(config, { mode: 'record' }));
    const failure = result.cases[0].failures.find((f) => f.assertion === 'page.ranInCase');
    expect(failure?.message).toMatch(/its last was \{"item":"size","value":"large"\}|its last was \{"value":"large","item":"size"\}/);
  });
});


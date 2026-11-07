/**
 * Acceptance: the assistant reports work that outlived the turn that started it, end to end on the fixture product
 * (the SDK realtime server on real Redis, a browser tab whose OUI surface runtime follows the job, and the worker on
 * both host adapters with a model from a real provider package).
 *
 * 1. The person asks for a render. The call's wait for the job ends first, so the call answers "still running" and
 *    the turn ends saying so.
 * 2. The job ends. The tab's runtime sends its final answer, the realtime server acknowledges it, and the runtime
 *    tells the tab (`onSettled`), naming the request and the turn that sent it.
 * 3. The tab resumes with that request (agent-react does this; here the test sends the turn it would). The model is
 *    given the outcome as the call's result, in place of "still running", with a note saying why the turn started.
 * 4. The person's next message: the model reads the outcome from what the resumed turn stored, not "running".
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rendersSurface, shellSurface, startFixtureProduct, type FixtureProduct } from './support/fixture-product.js';
import { FixtureConversation, runFixtureTurn, type HostAdapter } from './support/fixture-turn.js';
import { respondingOpenAI, type ChatRequest } from './support/replay.js';

let product: FixtureProduct;
beforeAll(async () => {
  product = await startFixtureProduct();
}, 20_000);
afterAll(async () => {
  await product?.stop();
});

const onRenders = { currentPath: '/renders', oui: { surfaces: [shellSurface, rendersSurface], observations: {} } };

/** The result the model was given for a call, in its request. */
function resultIn(request: ChatRequest, callId: string): string | undefined {
  const message = request.messages.find((m) => m.role === 'tool' && m.tool_call_id === callId);
  return typeof message?.content === 'string' ? message.content : undefined;
}
const userTexts = (request: ChatRequest) => request.messages.filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));

describe.each<HostAdapter>(['lambda', 'container'])('on the %s adapter', (adapter) => {
  it('a job that ends after its turn is reported by a resumed turn, and every later turn reads its outcome', async () => {
    const conversation = new FixtureConversation();
    const turn = (n: number) => `resume-${adapter}-${n}`;
    const callId = `call_render_${adapter}`;

    // ── Turn 1: the render starts; the call's wait ends first, so it answers "still running". ──
    const m1 = respondingOpenAI((_req, i) =>
      i === 0
        ? { toolCalls: [{ id: callId, name: 'ui_act', args: { action: 'renders_start', input: { reportId: 'q3' } } }] }
        : i === 1
          ? { text: 'The Q3 report is rendering; it takes about a minute.' }
          : undefined,
    );
    const t1 = await runFixtureTurn(product, {
      adapter,
      model: m1.model,
      turnId: turn(1),
      conversation,
      jobWaitMs: 200,
      payload: { content: 'Render the Q3 report', context: onRenders },
    });
    expect(t1.outcome.status).toBe('completed');
    const tab = t1.tab;
    expect(tab.ran).toEqual([{ actionId: 'renders_start', params: { reportId: 'q3' } }]);
    const running = JSON.parse(t1.persisted[0].messages[1].content!) as { status: string; note: string; result: { jobId: string } };
    expect(running).toMatchObject({ status: 'running', result: { status: 'started' } });
    expect(running.note).toMatch(/If it finishes after this turn, you are brought back to report it in this chat/);

    // ── The job ends after the turn: the tab's runtime tells, once the realtime server holds the outcome. ──
    expect(tab.settled).toEqual([]);
    tab.finishJob(running.result.jobId, { pdf: 'https://desk.example/q3.pdf', pages: 12 });
    const work = await tab.settledFor(callId);
    expect(work).toMatchObject({ requestId: callId, turnId: turn(1), surfaceId: 'renders', actionId: 'renders_start', success: true });

    // ── Turn 2: resumed, with no message, naming the request. ──
    const m2 = respondingOpenAI((_req, i) => (i === 0 ? { text: 'The Q3 report has rendered: 12 pages, ready to download.' } : undefined));
    const t2 = await runFixtureTurn(product, {
      adapter,
      model: m2.model,
      turnId: turn(2),
      tab,
      conversation,
      payload: { content: '', context: onRenders, resume: { requestIds: [work.requestId] } },
    });
    expect(t2.outcome.status).toBe('completed');
    expect(m2.requests).toHaveLength(1);
    // The model's input: the call's one result is its outcome now, and the note says why the turn started.
    const given = resultIn(m2.requests[0], callId)!;
    expect(JSON.parse(given)).toMatchObject({
      action: 'renders_start',
      jobId: running.result.jobId,
      result: { status: 'complete', pdf: 'https://desk.example/q3.pdf', pages: 12 },
    });
    expect(given).not.toMatch(/"status":"running"/);
    // The note stands as the turn's message; what is true only now (the page, the clock) follows it.
    const note = userTexts(m2.requests[0]).find((t) => t.startsWith('<resumed>'))!;
    expect(note).toMatch(/^<resumed>Nobody wrote anything: this turn started by itself/);
    expect(userTexts(m2.requests[0]).at(-1)).toMatch(/<page_state>/);
    expect(note).toContain('"Render a report" (renders_start)');
    // Nobody wrote anything: the conversation holds only the person's one message.
    expect(conversation.history.filter((m) => m.role === 'user')).toHaveLength(1);
    // Stored under the call's own id, before the reply.
    expect(t2.persisted[0].messages[0]).toEqual({ role: 'tool', content: given, toolCallId: callId, name: 'ui_act' });
    expect(t2.persisted[0].messages.at(-1)).toMatchObject({ role: 'assistant', content: 'The Q3 report has rendered: 12 pages, ready to download.' });
    // The tab was sent no action: the outcome came from the realtime server.
    expect(tab.ran).toHaveLength(1);

    // ── Turn 3: the person's next message reads the outcome, not "running". ──
    const m3 = respondingOpenAI((_req, i) => (i === 0 ? { text: 'It has 12 pages.' } : undefined));
    await runFixtureTurn(product, {
      adapter,
      model: m3.model,
      turnId: turn(3),
      tab,
      conversation,
      payload: { content: 'How many pages was it?', context: onRenders },
    });
    const later = resultIn(m3.requests[0], callId)!;
    expect(JSON.parse(later)).toMatchObject({ result: { status: 'complete', pages: 12 } });
    expect(later).not.toMatch(/"status":"running"/);
    expect(m3.requests[0].messages.filter((m) => m.role === 'tool' && m.tool_call_id === callId)).toHaveLength(1);
    expect(userTexts(m3.requests[0]).some((t) => t.includes('<resumed>'))).toBe(false);
  }, 30_000);
});

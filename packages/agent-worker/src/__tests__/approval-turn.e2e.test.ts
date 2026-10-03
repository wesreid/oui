/**
 * An irreversible action runs only on an approval the user gave, bound to the
 * call (ADR-0228), end to end on the W7 fixture: the SDK realtime server on
 * real Redis, a real browser socket that clicks the approval card, and the
 * worker on both host adapters with a model from a real provider package.
 *
 * - §5.1 (worker half): a `transaction` ends the turn at the preview, and runs
 *   only after the click, with the stored arguments.
 * - §5.2 (worker half): an approval for one set of arguments does not run a
 *   call with other arguments.
 * - §5.3 (worker half): a replayed or expired token runs nothing.
 * - §5.6: declining deletes the pending approval and the model is told the
 *   user declined.
 * - §5.4: the tab is OUI's real surface runtime: it runs the approved request
 *   only on the grant from its own click, and refuses one that reaches it with
 *   no grant, answering APPROVAL_REQUIRED.
 * - §2.1: the same holds for a host tool declared destructive, and for a call
 *   the host's policy requires approval of; approval never overrides a deny.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AGENT_SOCKET_EVENTS, argsHash, type ApprovalRequiredEvent, type PendingApprovalInput } from '@ouispec/agent-core';
import { FIXTURE_TURN, reportsSurface, shellSurface, startFixtureProduct, type FixtureProduct } from './support/fixture-product.js';
import { FixtureConversation, runFixtureTurn, type HostAdapter } from './support/fixture-turn.js';
import { respondingOpenAI, type ChatRequest } from './support/replay.js';
import type { RegisteredTool, ToolExecutionContext } from '../tools/types.js';
import type { ToolPolicy, ToolPolicyContext } from '../authz/tool-policy.js';

let product: FixtureProduct;
beforeAll(async () => {
  product = await startFixtureProduct();
}, 20_000);
afterAll(async () => {
  await product?.stop();
});

const onReports = { currentPath: '/reports', oui: { surfaces: [shellSurface, reportsSurface], observations: {} } };
const cfo = { reportId: 'q3', to: 'cfo@desk.example' };
const ceo = { reportId: 'q3', to: 'ceo@desk.example' };

/** Everything the model was sent, as one string. */
const said = (requests: ChatRequest[]) => JSON.stringify(requests);
/** The messages the model read, as their text. */
const read = (requests: ChatRequest[]) =>
  requests.flatMap((r) => r.messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')))).join('\n');
const JWS = /eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/;

const approvalEvents = (events: Array<{ event: string; data: unknown }>) =>
  events.filter((e) => e.event === AGENT_SOCKET_EVENTS.APPROVAL_REQUIRED).map((e) => e.data as ApprovalRequiredEvent);

describe.each<HostAdapter>(['lambda', 'container'])('on the %s adapter', (adapter) => {
  it('a transaction previews, waits for the click, runs exactly the stored call once, and never for other arguments', async () => {
    const conversation = new FixtureConversation();
    const turn = (n: number) => `appr-${adapter}-${n}`;

    // ── Turn 1: the model sends the report. The turn stops at the preview. ──
    const m1 = respondingOpenAI((_req, i) => (i === 0 ? { toolCalls: [{ id: 'call_send_1', name: 'ui_act', args: { action: 'reports_send', input: cfo } }] } : undefined));
    const t1 = await runFixtureTurn(product, {
      adapter,
      model: m1.model,
      turnId: turn(1),
      conversation,
      payload: { content: 'Send the Q3 report to cfo@desk.example', context: onReports },
    });
    const tab = t1.tab;
    expect(t1.outcome.status).toBe('completed');
    expect(m1.requests).toHaveLength(1); // no round after the call: the turn ended

    // The model is given three UI tools, never one per action, and the page's
    // index says which actions need approval: the card is the confirmation.
    expect(m1.requests[0].tools?.map((t) => t.function.name).sort()).toEqual(['ui_act', 'ui_describe', 'ui_read']);
    const offered = read(m1.requests).split('\n').find((line) => line.startsWith('- reports_send: ')) ?? '';
    expect(offered).toMatch(/needs approval/);
    expect(said(m1.requests)).not.toMatch(/Confirm with the user/);

    const [preview] = approvalEvents(tab.turnEvents(turn(1)));
    expect(preview).toMatchObject({
      turnId: turn(1),
      conversationId: FIXTURE_TURN.conversationId,
      approvalId: 'call_send_1',
      tool: 'reports_send',
      effect: 'transaction',
      destructive: false,
      preview: {
        title: 'Send a report',
        consequence: 'Emails a saved report to a recipient. Once sent it cannot be unsent.',
        arguments: [
          { name: 'reportId', label: 'Report', value: 'q3' },
          { name: 'to', label: 'Recipient', value: 'cfo@desk.example' },
        ],
        readback: 'Send a report: Report q3, Recipient cfo@desk.example. Emails a saved report to a recipient. Once sent it cannot be unsent.',
      },
    });
    expect(preview.expiresAt - Date.now()).toBeGreaterThan(4 * 60_000);
    expect(preview.expiresAt - Date.now()).toBeLessThanOrEqual(5 * 60_000);
    const order = tab.turnEvents(turn(1)).map((e) => e.event);
    expect(order.indexOf(AGENT_SOCKET_EVENTS.APPROVAL_REQUIRED)).toBeLessThan(order.indexOf(AGENT_SOCKET_EVENTS.TURN_COMPLETE));
    expect(tab.dispatches.filter((d) => d.actionId === 'reports_send')).toEqual([]);

    const [persisted1] = t1.persisted;
    expect(persisted1.messages[0].toolCalls).toEqual([{ id: 'call_send_1', name: 'ui_act', arguments: { action: 'reports_send', input: cfo } }]);
    expect(JSON.parse(persisted1.messages[1].content!)).toMatchObject({ awaitingApproval: true, approvalId: 'call_send_1' });
    expect(await product.internal(`/internal/approvals/call_send_1?userId=${FIXTURE_TURN.userId}`)).toMatchObject({
      status: 200,
      body: { status: 'pending' },
    });

    // ── The click, on the tab's own socket ─────────────────────────────────
    const click = await tab.decide('call_send_1', 'approve');
    if (!click.ok || click.decision !== 'approve') throw new Error(`the approval was refused: ${JSON.stringify(click)}`);

    // ── Turn 2: the continuation runs exactly the stored call ──────────────
    const m2 = respondingOpenAI((_req, i) => (i === 0 ? { text: 'Sent the Q3 report to cfo@desk.example.' } : undefined));
    const t2 = await runFixtureTurn(product, {
      adapter,
      model: m2.model,
      turnId: turn(2),
      tab,
      conversation,
      payload: { content: '', context: onReports, approval: { approvalId: 'call_send_1', decision: 'approve', token: click.token } },
    });
    expect(t2.outcome.status).toBe('completed');
    const sends = tab.dispatches.filter((d) => d.actionId === 'reports_send');
    // The request carries the approval it runs on, for the browser's own check (§2.2.6).
    expect(sends).toEqual([
      expect.objectContaining({
        requestId: 'call_send_1',
        surfaceId: 'reports',
        params: cfo,
        approval: { approvalId: 'call_send_1', argsHash: await argsHash(cfo) },
      }),
    ]);
    expect(m2.requests).toHaveLength(1);
    expect(read(m2.requests)).toContain('"sent":true');
    expect(read(m2.requests)).toMatch(/approved "Send a report"/);
    // The approved run is persisted as the result of the call the model made: no second call.
    expect(t2.persisted[0].messages).toEqual([
      expect.objectContaining({ role: 'tool', toolCallId: 'call_send_1', name: 'ui_act' }),
      { role: 'assistant', content: 'Sent the Q3 report to cfo@desk.example.' },
    ]);
    expect(JSON.parse(t2.persisted[0].messages[0].content!)).toMatchObject({ result: { sent: true } });

    // ── What the model is given: ONE call, with ONE result ────────────────
    // Shown a second call beside its own, the assistant warned of a duplicate (dev, 2026-10-03).
    const given = m2.requests[0].messages as Array<{ role: string; content?: unknown; tool_call_id?: string; tool_calls?: Array<{ id: string }> }>;
    const calls = given.flatMap((m) => m.tool_calls ?? []).map((c) => c.id);
    expect(calls).toEqual(['call_send_1']);
    const results = given.filter((m) => m.role === 'tool');
    expect(results.map((m) => m.tool_call_id)).toEqual(['call_send_1']);
    // Its result is the approved run's, where "waiting for approval" stood: straight after the call.
    expect(String(results[0].content)).toContain('"sent":true');
    expect(read(m2.requests)).not.toContain('awaitingApproval');
    expect(read(m2.requests)).not.toContain('-approved');
    expect(given.indexOf(results[0])).toBe(given.findIndex((m) => m.tool_calls?.length) + 1);
    // The note says so, on the user's message, which is last.
    expect(given[given.length - 1].role).toBe('user');
    expect(read(m2.requests)).toMatch(/it is one call, run once/);
    expect(JSON.parse(t2.persisted[0].messages[0].content!)).toMatchObject({ result: { sent: true, to: 'cfo@desk.example' } });
    // The result says how the call came to run, to the model now and in the stored row for every later turn.
    const approved = { decided: 'approved', by: 'user', ran: true, summary: 'Approved by the user on the approval card, and run once.' };
    expect(JSON.parse(String(results[0].content))).toMatchObject({ approval: approved });
    expect(JSON.parse(t2.persisted[0].messages[0].content!)).toMatchObject({ approval: approved });
    expect(tab.turnEvents(turn(2)).map((e) => e.event)).toEqual(
      expect.arrayContaining([AGENT_SOCKET_EVENTS.TOOL_CALL_STARTED, AGENT_SOCKET_EVENTS.TOOL_CALL_COMPLETE]),
    );
    expect((await product.internal(`/internal/approvals/call_send_1?userId=${FIXTURE_TURN.userId}`)).status).toBe(404);

    // ── Turn 3: other arguments are a new call, and need their own approval ─
    const m3 = respondingOpenAI((_req, i) => (i === 0 ? { toolCalls: [{ id: 'call_send_2', name: 'ui_act', args: { action: 'reports_send', input: ceo } }] } : undefined));
    const t3 = await runFixtureTurn(product, {
      adapter,
      model: m3.model,
      turnId: turn(3),
      tab,
      conversation,
      payload: { content: 'Send it to ceo@desk.example as well', context: onReports },
    });
    expect(t3.outcome.status).toBe('completed');
    expect(m3.requests).toHaveLength(1);
    expect(tab.dispatches.filter((d) => d.actionId === 'reports_send')).toHaveLength(1);
    expect(approvalEvents(tab.turnEvents(turn(3)))).toEqual([
      expect.objectContaining({
        approvalId: 'call_send_2',
        preview: expect.objectContaining({ arguments: expect.arrayContaining([{ name: 'to', label: 'Recipient', value: 'ceo@desk.example' }]) }),
      }),
    ]);

    // ── Turn 4: the first token, replayed, runs nothing ────────────────────
    const m4 = respondingOpenAI((_req, i) => (i === 0 ? { text: 'That approval was already used, so nothing was sent.' } : undefined));
    const t4 = await runFixtureTurn(product, {
      adapter,
      model: m4.model,
      turnId: turn(4),
      tab,
      conversation,
      payload: { content: '', context: onReports, approval: { approvalId: 'call_send_1', decision: 'approve', token: click.token } },
    });
    expect(t4.outcome.status).toBe('completed');
    expect(tab.dispatches.filter((d) => d.actionId === 'reports_send')).toHaveLength(1);
    expect(read(m4.requests)).toMatch(/did not run.*already been used/);
    expect(t4.persisted[0].messages.some((m) => m.toolCalls?.length)).toBe(false);

    // ── Turn 5: declining the second tells the model, and runs nothing ─────
    expect(await tab.decide('call_send_2', 'decline')).toEqual({ ok: true, decision: 'decline', approvalId: 'call_send_2' });
    const m5 = respondingOpenAI((_req, i) => (i === 0 ? { text: 'Understood, I will not send it to the CEO.' } : undefined));
    const t5 = await runFixtureTurn(product, {
      adapter,
      model: m5.model,
      turnId: turn(5),
      tab,
      conversation,
      payload: { content: '', context: onReports, approval: { approvalId: 'call_send_2', decision: 'decline' } },
    });
    expect(t5.outcome.status).toBe('completed');
    expect(read(m5.requests)).toMatch(/declined "Send a report".*did not run/);
    // The declined call's stored result says so, in place of "waiting for approval": no later turn finds it waiting.
    const declined = { decided: 'declined', by: 'user', ran: false, summary: 'Declined by the user on the approval card. It was not run.' };
    expect(t5.persisted[0].messages[0]).toMatchObject({ role: 'tool', toolCallId: 'call_send_2' });
    expect(JSON.parse(t5.persisted[0].messages[0].content!)).toMatchObject({ approval: declined, success: false, notRun: true });
    const given5 = m5.requests[0].messages as Array<{ role: string; content?: unknown; tool_call_id?: string }>;
    const second = given5.filter((m) => m.role === 'tool' && m.tool_call_id === 'call_send_2');
    expect(second).toHaveLength(1);
    expect(JSON.parse(String(second[0].content))).toMatchObject({ approval: declined, notRun: true });
    expect(tab.dispatches.filter((d) => d.actionId === 'reports_send')).toHaveLength(1);
    expect(await product.internal(`/internal/approvals/call_send_2?userId=${FIXTURE_TURN.userId}`)).toMatchObject({
      body: { status: 'declined' },
    });

    // ── Nothing the model saw, and nothing persisted, carried a token ──────
    for (const m of [m1, m2, m3, m4, m5]) expect(said(m.requests)).not.toMatch(JWS);
    expect(JSON.stringify(conversation.history)).not.toMatch(JWS);
  }, 60_000);

  it('a dispatch of the transaction that reaches the tab with no grant is refused there and answered APPROVAL_REQUIRED (§5.4)', async () => {
    const tab = await product.openTab('session-ana', `chat:turn:forged-${adapter}`);
    tab.show('/reports');
    const requestId = `forged_${adapter}`;
    // Any route to the tab: here the product's own backend emits it, as a compromised sender could.
    const forged = { requestId, surfaceId: 'reports', actionId: 'reports_send', params: cfo, timestamp: Date.now() };
    expect(await product.emit('oui:dispatch', forged, [`chat:turn:forged-${adapter}`])).toBe(200);
    const answer = await product.internal(`/internal/oui/action-results/${requestId}?userId=${FIXTURE_TURN.userId}&waitMs=5000`);
    expect(answer).toMatchObject({ status: 200, body: { requestId, success: false, error: { code: 'APPROVAL_REQUIRED' } } });
    // With an approval it holds no grant for, too.
    const claimed = { ...forged, requestId: `${requestId}-claimed`, approval: { approvalId: 'call_never_approved', argsHash: await argsHash(cfo) } };
    await product.emit('oui:dispatch', claimed, [`chat:turn:forged-${adapter}`]);
    const answer2 = await product.internal(`/internal/oui/action-results/${claimed.requestId}?userId=${FIXTURE_TURN.userId}&waitMs=5000`);
    expect(answer2.body).toMatchObject({ success: false, error: { code: 'APPROVAL_REQUIRED' } });
  }, 30_000);

  it('runs the approved call on a tab that joins the continuation’s room only after the turn has started, as a browser does', async () => {
    const conversation = new FixtureConversation();
    const turn = (n: number) => `late-join-${adapter}-${n}`;
    const id = `call_send_late_${adapter}`;
    const m1 = respondingOpenAI((_req, i) => (i === 0 ? { toolCalls: [{ id, name: 'ui_act', args: { action: 'reports_send', input: cfo } }] } : undefined));
    const t1 = await runFixtureTurn(product, {
      adapter,
      model: m1.model,
      turnId: turn(1),
      conversation,
      payload: { content: 'Send the Q3 report to cfo@desk.example', context: onReports },
    });
    const click = await t1.tab.decide(id, 'approve');
    if (!click.ok || click.decision !== 'approve') throw new Error('not approved');

    const m2 = respondingOpenAI((_req, i) => (i === 0 ? { text: 'Sent.' } : undefined));
    const t2 = await runFixtureTurn(product, {
      adapter,
      model: m2.model,
      turnId: turn(2),
      tab: t1.tab,
      tabJoinsAfterMs: 1_500,
      conversation,
      payload: { content: '', context: onReports, approval: { approvalId: id, decision: 'approve', token: click.token } },
    });
    expect(t2.outcome.status).toBe('completed');
    expect(t1.tab.dispatches.filter((d) => d.requestId === id)).not.toHaveLength(0);
    expect(read(m2.requests)).toContain('"sent":true');
    expect(JSON.parse(t2.persisted[0].messages[0].content!)).toMatchObject({ result: { sent: true } });
  }, 30_000);

  it('an expired approval runs nothing, and the model is told why', async () => {
    const approvalId = `call_late_${adapter}`;
    const pending: PendingApprovalInput = {
      approvalId,
      toolCallId: approvalId,
      conversationId: FIXTURE_TURN.conversationId,
      turnId: `late-${adapter}-0`,
      userId: FIXTURE_TURN.userId,
      tool: 'reports_send',
      args: cfo,
      argsHash: await argsHash(cfo),
      effect: 'transaction',
      destructive: false,
      argsSensitive: true,
      expiresAt: Date.now() + 1_200,
      preview: { title: 'Send a report', arguments: [], readback: 'Send a report.' },
    };
    expect((await product.internal('/internal/approvals', pending)).status).toBe(201);
    const tab = await product.openTab('session-ana', `chat:turn:late-${adapter}-0`);
    const click = await tab.decide(approvalId, 'approve');
    if (!click.ok || click.decision !== 'approve') throw new Error('not approved');
    await new Promise((r) => setTimeout(r, 1_500));

    const m = respondingOpenAI((_req, i) => (i === 0 ? { text: 'The approval expired before it could be used; nothing was sent.' } : undefined));
    const run = await runFixtureTurn(product, {
      adapter,
      model: m.model,
      turnId: `late-${adapter}-1`,
      tab,
      payload: { content: '', context: onReports, approval: { approvalId, decision: 'approve', token: click.token } },
    });
    expect(run.outcome.status).toBe('completed');
    expect(tab.dispatches).toEqual([]);
    expect(read(m.requests)).toMatch(/did not run.*expired/);
  }, 30_000);

  it('a host tool declared destructive, and a call the host policy requires approval of, take the same path; a deny still wins', async () => {
    const executed: Array<Record<string, unknown>> = [];
    const policyCalls: ToolPolicyContext[] = [];
    let denyNow = false;
    const purge: RegisteredTool = {
      name: 'files_purge',
      title: 'Purge files',
      description: 'Deletes every file in a folder for good.',
      destructive: true,
      effect: { kind: 'mutate', operation: 'purgeFolder' },
      inputSchema: { type: 'object', properties: { folder: { type: 'string', title: 'Folder' } }, required: ['folder'] },
      async execute(input: Record<string, unknown>, _ctx: ToolExecutionContext) {
        executed.push(input);
        return { success: true, data: { purged: 12 } };
      },
    };
    const archive: RegisteredTool = {
      name: 'files_archive',
      title: 'Archive a folder',
      description: 'Moves a folder to the archive.',
      effect: { kind: 'mutate', operation: 'archiveFolder' },
      inputSchema: { type: 'object', properties: { folder: { type: 'string', title: 'Folder' } }, required: ['folder'] },
      async execute(input: Record<string, unknown>) {
        executed.push({ archived: input.folder });
        return { success: true, data: { archived: true } };
      },
    };
    const toolPolicy: ToolPolicy = {
      async evaluate(ctx) {
        policyCalls.push(ctx);
        if (denyNow) return { action: 'deny', reason: 'Purging is suspended for this account' };
        if (ctx.toolName === 'files_archive') return { action: 'require_approval', reason: 'Archiving needs a manager' };
        return { action: 'allow' };
      },
    };
    const tools = [purge, archive];
    const conversation = new FixtureConversation();
    const id = (n: number) => `host-${adapter}-${n}`;

    // The destructive host tool stops the turn at a preview; the policy saw what it does.
    const m1 = respondingOpenAI((_r, i) =>
      i === 0
        ? {
            toolCalls: [
              { id: `call_purge_${adapter}`, name: 'files_purge', args: { folder: 'drafts' } },
              { id: `call_archive_${adapter}`, name: 'files_archive', args: { folder: 'old' } },
            ],
          }
        : undefined,
    );
    const t1 = await runFixtureTurn(product, { adapter, model: m1.model, turnId: id(1), conversation, tools, toolPolicy, payload: { content: 'Purge drafts, archive old' } });
    expect(t1.outcome.status).toBe('completed');
    expect(m1.requests).toHaveLength(1);
    expect(executed).toEqual([]);
    expect(policyCalls.find((c) => c.toolName === 'files_purge')).toMatchObject({
      toolKind: 'backend',
      destructive: true,
      effect: { kind: 'mutate', operation: 'purgeFolder' },
    });
    // One approval per turn: the first call stops it, and the second is not run or offered for approval.
    expect(approvalEvents(t1.tab.turnEvents(id(1)))).toEqual([
      expect.objectContaining({
        approvalId: `call_purge_${adapter}`,
        tool: 'files_purge',
        effect: 'mutate',
        destructive: true,
        preview: expect.objectContaining({ title: 'Purge files', arguments: [{ name: 'folder', label: 'Folder', value: 'drafts' }] }),
      }),
    ]);
    const archiveResult = t1.persisted[0].messages.find((m) => m.toolCallId === `call_archive_${adapter}`);
    expect(archiveResult?.content).toMatch(/not run/i);
    expect(JSON.stringify(t1.persisted)).not.toMatch(/Please ask the user to confirm/);

    const click = await t1.tab.decide(`call_purge_${adapter}`, 'approve');
    if (!click.ok || click.decision !== 'approve') throw new Error('not approved');

    // A deny at run time wins over the approval: nothing runs.
    denyNow = true;
    const m2 = respondingOpenAI((_r, i) => (i === 0 ? { text: 'Purging is suspended for this account.' } : undefined));
    const t2 = await runFixtureTurn(product, {
      adapter,
      model: m2.model,
      turnId: id(2),
      tab: t1.tab,
      conversation,
      tools,
      toolPolicy,
      payload: { content: '', approval: { approvalId: `call_purge_${adapter}`, decision: 'approve', token: click.token } },
    });
    expect(t2.outcome.status).toBe('completed');
    expect(executed).toEqual([]);
    expect(read(m2.requests)).toMatch(/approved "Purge files".*did not run: Purging is suspended for this account/);

    // A call the policy requires approval of: approved, it runs once with its stored arguments.
    denyNow = false;
    const m3 = respondingOpenAI((_r, i) => (i === 0 ? { toolCalls: [{ id: `call_archive2_${adapter}`, name: 'files_archive', args: { folder: 'old' } }] } : undefined));
    const t3 = await runFixtureTurn(product, { adapter, model: m3.model, turnId: id(3), tab: t1.tab, conversation, tools, toolPolicy, payload: { content: 'Archive old' } });
    expect(approvalEvents(t3.tab.turnEvents(id(3)))).toEqual([expect.objectContaining({ tool: 'files_archive', effect: 'mutate', destructive: false })]);
    const click2 = await t1.tab.decide(`call_archive2_${adapter}`, 'approve');
    if (!click2.ok || click2.decision !== 'approve') throw new Error('not approved');
    const m4 = respondingOpenAI((_r, i) => (i === 0 ? { text: 'Archived.' } : undefined));
    await runFixtureTurn(product, {
      adapter,
      model: m4.model,
      turnId: id(4),
      tab: t1.tab,
      conversation,
      tools,
      toolPolicy,
      payload: { content: '', approval: { approvalId: `call_archive2_${adapter}`, decision: 'approve', token: click2.token } },
    });
    expect(executed).toEqual([{ archived: 'old' }]);
  }, 60_000);
});

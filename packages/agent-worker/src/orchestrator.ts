/**
 * Agent Orchestrator — powered by Vercel AI SDK.
 *
 * The model is the host's: any `ai` library model, passed in configuration
 * (ADR-0227 §2.2, "Model"). The core names no provider. The AI SDK handles:
 *   - each provider's wire format (internal, never exposed)
 *   - tool_use / tool_result pairing (automatic, no manual repair needed)
 *   - Multi-round tool loops (via stopWhen)
 *   - True token streaming with coalescing
 *   - Step callbacks for logging
 *   - Error categorization and retries
 *
 * Our value-add stays:
 *   - UI tools from the client's OUI surfaces, answered by the client (ADR-0209)
 *   - Schema-based tool loading
 *   - Persona/prompt compilation
 *   - Emit adapter (realtime socket streaming)
 *   - ApiSurface binding for tool execution
 *   - Configurable TurnPolicy for product-specific step control
 */
import { streamText, dynamicTool, jsonSchema, isStepCount, hasToolCall } from 'ai';
import type { ModelMessage, AssistantModelMessage, ToolModelMessage, TextPart, ToolCallPart } from 'ai';
import { AGENT_SOCKET_EVENTS, argsHash, type ApprovalContinuation, type ApprovalRequiredEvent } from '@ouispec/agent-core';
import type { OUISurface, OUISurfaceSnapshot } from 'oui-spec/spec';
import type { AgentWorkerConfig, AgentTurnInput, AgentTurnResult, TurnMessage, TurnHistoryMessage } from './types.js';
import type { RegisteredTool, ToolExecutionContext, ToolExecutionResult } from './tools/types.js';
import { defaultTurnPolicy } from './turn-policy.js';
import { evaluateToolPolicySafe } from './authz/tool-policy.js';
import { createToolInputValidator } from './tools/input-validation.js';
import { readClientSnapshot, capabilityFingerprint, withoutClientUI } from './ui/snapshot.js';
import { readClientKnowledge, withClientKnowledge } from './ui/knowledge.js';
import { buildUITools } from './ui/ui-tools.js';
import { createUISequence, type UISlot } from './ui/ui-sequence.js';
import { observationsText } from './ui/observations.js';
import { approvalRequirement, APPROVAL_TOOL_NOTE, type ApprovalRequirement } from './approvals/requirement.js';
import { buildApprovalPreview, declaredTitle } from './approvals/preview.js';
import { approvalNote, ranNote, resolveContinuation, unavailableNote } from './approvals/continuation.js';

const DEFAULT_MAX_ROUNDS = 12;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.3;
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const DEFAULT_UI_RESULT_TIMEOUT_MS = 20_000;
/** Time left, before the turn's deadline, for the model to answer after waiting on a UI action's work. */
const UI_ANSWER_MARGIN_MS = 45_000;
const DEFAULT_PAGE_STATE_CHARS = 6_000;

/**
 * Tools that hand the turn back to the user. The turn stops after any of them:
 * the model must not carry on as if the user had already answered.
 */
const USER_INPUT_TOOLS = ['present_options', 'confirm_action', 'request_user_decision'] as const;

type AgentLogNamespace = 'agent:turn' | 'agent:llm' | 'agent:tool' | 'agent:prompt' | 'agent:stream' | 'agent:ui';

function log(level: 'info' | 'warn' | 'error' | 'debug', ns: AgentLogNamespace, message: string, data?: Record<string, unknown>): void {
  const entry = { level, ns, message, timestamp: new Date().toISOString(), ...data };
  if (level === 'error') console.error(JSON.stringify(entry));
  else if (level === 'warn') console.warn(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}

type AiTool = ReturnType<typeof dynamicTool>;

/** What one call came to: the text the model reads as its result, and whether the tool itself ran. */
interface CallOutcome {
  text: string;
  ran: boolean;
}

/** A call refused before its tool ran. */
const notRun = (payload: Record<string, unknown>): CallOutcome => ({ text: JSON.stringify(payload), ran: false });

/**
 * Run a complete agent turn using the Vercel AI SDK.
 *
 * A turn runs in one or more segments. Each segment is one `streamText` call
 * with a fixed tool set. When a UI action changes what the client's page
 * offers (navigating is the common case), the segment ends and the turn
 * continues in a new one whose tools are the new page's (ADR-0209 D3). The
 * round cap counts across segments.
 */
export async function runAgentTurn(
  config: AgentWorkerConfig,
  input: AgentTurnInput,
): Promise<AgentTurnResult> {
  const maxRounds = config.maxToolRounds ?? DEFAULT_MAX_ROUNDS;
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  const temperature = config.temperature ?? DEFAULT_TEMPERATURE;
  const toolTimeoutMs = config.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const turnDeadlineMs = config.turnDeadlineMs ?? 240_000; // 4 min, below the 5 min Lambda ceiling
  const retries = config.retries ?? 3;
  const uiResultTimeoutMs = config.ui?.resultTimeoutMs ?? DEFAULT_UI_RESULT_TIMEOUT_MS;

  if (!config.model) {
    throw new Error('[agent-sdk] config.model is required: pass an `ai` library model (ADR-0227 §2.2)');
  }
  const { turnId, socketRoom } = input;

  log('info', 'agent:turn', 'Turn started', {
    turnId,
    conversationId: input.conversationId,
    userId: input.userId,
    historyLength: input.history?.length ?? 0,
    contentLength: input.content.length,
    maxRounds,
    maxTokens,
    temperature,
  });

  // ─── The client's UI (ADR-0209 D1) ─────────────────────────────────────────
  // The turn carries the surfaces of the client that sent it. They are the only
  // source of UI tools, so the tools always describe the page the user is on.
  const snapshot = readClientSnapshot(input.context ?? null);
  if (snapshot && !config.ui) {
    throw new Error(
      '[agent-sdk] The turn carries UI surfaces but the worker has no UI action channel (config.ui): ' +
        'its UI actions could be sent but never answered.',
    );
  }
  let currentSurfaces: OUISurface[] = snapshot?.surfaces ?? [];
  // The turn's UI actions run one at a time, in the order the model called them,
  // across every rebuild of the UI tools (ui-sequence.ts).
  const uiSequence = createUISequence();
  // The page's surfaces as the turn's snapshot gave them, under the client's hash for them.
  if (snapshot) uiSequence.record(snapshot.surfaces, snapshot.surfacesHash);
  // Set when an answer shows the page now offers different actions; the
  // current segment then ends and the next is built from these.
  let pendingSurfaces: OUISurface[] | null = null;

  // The knowledge the client sent for its page goes after the host's prompt.
  const knowledge = readClientKnowledge(input.context ?? null);

  log('info', 'agent:ui', 'UI surfaces for this turn', {
    turnId,
    clientSentSnapshot: snapshot !== null,
    surfaceIds: currentSurfaces.map((s) => s.id),
    actionCount: currentSurfaces.reduce((n, s) => n + s.actions.length, 0),
    knowledgeEntries: knowledge?.entries.length ?? 0,
    knowledgeWorkflows: knowledge?.workflows.length ?? 0,
  });

  // ─── Turn classification via policy ────────────────────────────────────────
  const turnPolicy = config.turnPolicy ?? defaultTurnPolicy;
  const historyForClassify = input.history?.map((m) => ({
    role: m.role,
    content: 'content' in m ? (m.content ?? '') : '',
  })) ?? [];
  const turnClass = turnPolicy.classifyTurn(input.content, historyForClassify);

  // Let the policy perform side effects (e.g. deterministic navigation emit)
  if (turnPolicy.onTurnClassified) {
    await turnPolicy.onTurnClassified({
      turnClass,
      content: input.content,
      emit: config.emit,
      socketRoom,
    });
  }

  log('info', 'agent:turn', 'Turn classified', { turnId, turnClass });

  // Build system prompt: the host's, which never sees what the client sent for
  // the worker itself, then the client's knowledge.
  const hostPrompt = typeof config.systemPrompt === 'function'
    ? config.systemPrompt({ userId: input.userId, accountId: input.accountId, context: withoutClientUI(input.context) })
    : config.systemPrompt;
  const systemPrompt = withClientKnowledge(hostPrompt, input.context);

  log('debug', 'agent:prompt', 'System prompt built', { turnId, promptLength: systemPrompt.length });

  // Wall-clock deadline: abort the entire streamText call if it exceeds turnDeadlineMs.
  const turnStartedAt = Date.now();
  // A UI tool waiting on work it started stops in time for the model to answer.
  const uiWaitDeadline = () => turnStartedAt + turnDeadlineMs - UI_ANSWER_MARGIN_MS;
  const abortController = new AbortController();
  const deadlineTimer = setTimeout(() => abortController.abort('Turn deadline exceeded'), turnDeadlineMs);

  // Build tool execution context
  const toolCtx: ToolExecutionContext = {
    userId: input.userId,
    accountId: input.accountId,
    turnId,
    conversationId: input.conversationId,
    userToken: input.userToken,
    apiSurface: config.apiSurface,
    abortSignal: abortController.signal,
    socketRoom,
  };

  // Track tool executions for emit events and persistence.
  // We capture toolCallId from the execute options (2nd argument).
  const executedToolResults: Array<{ toolCallId: string; toolName: string; result: string }> = [];

  // Per-tool invocation quotas — mandatory for side-effecting tools.
  // Quota is per-turn, held in this closure — never module scope. It spans
  // segments: rebuilding the tool set does not reset what was already used.
  const toolInvocationCounts = new Map<string, number>();
  const DEFAULT_TOOL_QUOTA = 12; // matches maxRounds
  const SIDE_EFFECT_TOOL_QUOTA = 2;

  // ─── Approvals (ADR-0228) ──────────────────────────────────────────────────
  // The first call in a turn that needs the user's approval stops the turn:
  // it is stored as a pending approval, the card is shown, and nothing else
  // runs until they decide. Each call is approved separately.
  let approvalHold: { approvalId: string; title: string } | null = null;

  // jsonSchema() carries no validator, so a call's arguments are whatever the
  // model produced. Each tool's declared schema is compiled once per turn.
  const validators = new WeakMap<RegisteredTool, ReturnType<typeof createToolInputValidator>>();
  const validatorFor = (t: RegisteredTool) => {
    let v = validators.get(t);
    if (!v) {
      // The schema the tool DECLARED, not the model-facing stand-in: a strict
      // empty schema only gives the model a valid schema for a tool that
      // declared no properties, and enforcing it would reject input such a
      // tool has always received.
      v = createToolInputValidator(t.inputSchema as Record<string, unknown> | undefined);
      validators.set(t, v);
    }
    return v;
  };

  /**
   * Runs one call of a tool: validation, quota, policy, approval, then the
   * tool. `approved` is set only for the call a redeemed approval token names,
   * in the turn after the user's decision.
   */
  const executeCall = async (
    t: RegisteredTool,
    rawArgs: unknown,
    toolUseId: string,
    uiSlot: UISlot | undefined,
    approved?: { approvalId: string; argsHash: string },
  ): Promise<CallOutcome> => {
    const startMs = Date.now();
    const isUI = t.kind === 'ui';
    // A UI tool waits for the client's answer, which has its own deadline, and
    // then for the outcome of work it started, until uiWaitDeadline.
    const timeoutMs = isUI
      ? Math.max(toolTimeoutMs, uiResultTimeoutMs + 5_000, uiWaitDeadline() - Date.now() + uiResultTimeoutMs + 5_000)
      : toolTimeoutMs;

    // ── Input validation ──
    // Before quota and policy: an invalid call consumes no quota and never
    // reaches the host. The model gets the errors so it can correct the call.
    const validation = validatorFor(t)(rawArgs);
    if (!validation.ok) {
      log('warn', 'agent:tool', 'Tool call rejected: invalid input', {
        turnId,
        toolName: t.name,
        errors: validation.errors,
      });
      return notRun({
        success: false,
        error: `Invalid input for "${t.name}": ${validation.errors.join('; ')}`,
        invalidInput: true,
      });
    }
    const args = validation.value;

    // ── Quota enforcement ──
    // UI actions run as the user in their own session (ADR-0182 §3), so the
    // backend side-effect cap does not apply to them (ADR-0209 D5).
    const currentCount = toolInvocationCounts.get(t.name) ?? 0;
    const isSideEffecting = (t.inputSchema as Record<string, unknown>)?.sideEffects !== false; // fail-closed: undefined = side-effecting
    const quota = !isUI && isSideEffecting ? SIDE_EFFECT_TOOL_QUOTA : DEFAULT_TOOL_QUOTA;
    if (currentCount >= quota) {
      return notRun({
        success: false,
        error: `Tool "${t.name}" has reached its maximum invocation quota of ${quota} for this turn. Please proceed without calling it again.`,
        quotaExceeded: true,
      });
    }
    toolInvocationCounts.set(t.name, currentCount + 1);

    // ── Policy enforcement ──
    // A deny always wins, over an approval too (ADR-0228 §2.1).
    const requirement = approvalRequirement(t);
    let policyRequiresApproval = false;
    if (config.toolPolicy) {
      const decision = await evaluateToolPolicySafe(config.toolPolicy, {
        userId: input.userId,
        accountId: input.accountId,
        toolName: t.name,
        args,
        turnId,
        hasSideEffects: isSideEffecting,
        toolKind: isUI ? 'ui' : 'backend',
        effect: requirement.effect,
        destructive: requirement.destructive,
      });

      if (decision.action === 'deny') {
        return notRun({
          success: false,
          error: decision.reason,
          policyDenied: true,
        });
      }
      policyRequiresApproval = decision.action === 'require_approval';
    }

    // ── Approval (ADR-0228) ──
    // Checked and set with no await in between, so of the calls in one
    // response exactly the first that needs approval stops the turn.
    if (approvalHold && !approved) {
      return notRun({
        success: false,
        notRun: true,
        error:
          `Not run: this turn is waiting for the user's approval of "${approvalHold.title}". ` +
          'Nothing else runs until they decide; ask again afterwards if it is still needed.',
      });
    }
    if ((requirement.required || policyRequiresApproval) && !approved) {
      return { text: await requestApproval(t, args, toolUseId, requirement), ran: false };
    }

    log('info', 'agent:tool', 'Tool call started', {
      turnId,
      toolName: t.name,
      kind: t.kind ?? 'backend',
      input: args,
      ...(approved ? { approvalId: approved.approvalId } : {}),
    });

    // Emit tool call started BEFORE execution
    await config.emit.emit(socketRoom, AGENT_SOCKET_EVENTS.TOOL_CALL_STARTED, {
      turnId,
      toolUseId,
      name: t.name,
      input: args,
      timestamp: startMs,
    });

    // Execute with timeout
    let result: ToolExecutionResult;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      result = await Promise.race([
        t.execute(args, {
          ...toolCtx,
          toolCallId: toolUseId,
          ...(uiSlot ? { uiSlot } : {}),
          ...(approved ? { approval: approved } : {}),
        }),
        new Promise<ToolExecutionResult>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Tool ${t.name} timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
    } catch (err) {
      result = { success: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      if (timer) clearTimeout(timer);
    }

    const durationMs = Date.now() - startMs;

    // Normalize result — built-in tools (present_options, etc.) return the
    // raw payload directly, while schema and UI tools return { success, data, error }.
    const isWrapped = result && typeof result === 'object' && 'success' in result;
    const resultData = isWrapped ? (result.data ?? result.error ?? null) : result;
    const resultSuccess = isWrapped ? result.success : true;
    // A failed call that still carries data (a UI action's page state) must
    // not lose its error message on the way to the model.
    const modelPayload = isWrapped && !result.success && result.data !== undefined && result.error
      ? { error: result.error, ...(result.data as Record<string, unknown>) }
      : resultData;

    log('info', 'agent:tool', 'Tool call completed', {
      turnId,
      toolName: t.name,
      success: resultSuccess,
      durationMs,
      ...(isUI && !resultSuccess ? { error: isWrapped ? result.error : undefined } : {}),
    });

    await config.emit.emit(socketRoom, AGENT_SOCKET_EVENTS.TOOL_CALL_COMPLETE, {
      turnId,
      toolUseId,
      name: t.name,
      result: modelPayload,
      success: resultSuccess,
      durationMs,
      timestamp: Date.now(),
    });

    return { text: JSON.stringify(modelPayload ?? { error: 'no result' }), ran: true };
  };

  /**
   * Stops the turn at a call that needs the user's approval (ADR-0228 §2.2.1):
   * stores it as a pending approval, shows the card, and tells the model only
   * that it is waiting. The model never sees a token.
   */
  const requestApproval = async (
    t: RegisteredTool,
    args: Record<string, unknown>,
    toolUseId: string,
    requirement: ApprovalRequirement,
  ): Promise<string> => {
    const preview = buildApprovalPreview(t, args);
    approvalHold = { approvalId: toolUseId, title: preview.title };
    const refuse = (why: string) => {
      approvalHold = null;
      log('error', 'agent:tool', 'Approval could not be requested; the call was not run', { turnId, toolName: t.name, why });
      return JSON.stringify({
        success: false,
        notRun: true,
        error: `"${preview.title}" needs the user's approval, which could not be asked for (${why}). It was not run.`,
      });
    };
    if (!config.approvals) return refuse('this assistant has no approval store');

    const expiresAt = Date.now() + requirement.ttlMs;
    try {
      const hash = await argsHash(args);
      await config.approvals.create({
        approvalId: toolUseId,
        toolCallId: toolUseId,
        conversationId: input.conversationId,
        turnId,
        userId: input.userId,
        tool: t.name,
        args,
        argsHash: hash,
        effect: requirement.effectName,
        destructive: requirement.destructive,
        argsSensitive: t.argsSensitive !== false,
        expiresAt,
        preview,
      });
    } catch (err) {
      return refuse(err instanceof Error ? err.message : String(err));
    }

    await config.emit.emit(socketRoom, AGENT_SOCKET_EVENTS.APPROVAL_REQUIRED, {
      turnId,
      conversationId: input.conversationId,
      approvalId: toolUseId,
      tool: t.name,
      effect: requirement.effectName,
      destructive: requirement.destructive,
      preview,
      expiresAt,
      timestamp: Date.now(),
    } satisfies ApprovalRequiredEvent);
    log('info', 'agent:tool', 'Turn stopped for the user’s approval', {
      turnId,
      toolName: t.name,
      approvalId: toolUseId,
      effect: requirement.effectName,
      destructive: requirement.destructive,
    });
    return JSON.stringify({
      success: false,
      awaitingApproval: true,
      approvalId: toolUseId,
      message:
        `Waiting for the user to approve "${preview.title}" on the approval card. It has not run. ` +
        'The turn ends here: it runs only if they approve it there, and the next turn tells you the outcome.',
    });
  };

  // Convert a RegisteredTool to an AI SDK tool. Our tools have runtime-defined
  // JSON Schemas — dynamicTool accepts raw JSON Schema via jsonSchema(), which
  // is exactly our use case.
  function toAiTool(t: RegisteredTool): AiTool {
    const rawSchema = t.inputSchema && Object.keys(t.inputSchema.properties ?? {}).length > 0
      ? t.inputSchema
      : { type: 'object' as const, properties: {}, additionalProperties: false };
    const isUI = t.kind === 'ui';

    // A UI call takes its place in the turn's UI order synchronously, as the
    // model's call arrives: the checks and the emit below await, and calls from
    // one response may get through them in any order (ui-sequence.ts). The place
    // is given up if the call never reaches the page, and otherwise held until
    // its action settles.
    const execute = async (rawArgs: unknown, options: { toolCallId?: string } | undefined): Promise<string> => {
      const toolUseId = options?.toolCallId ?? `tool_${Date.now()}`;
      const uiSlot = isUI ? uiSequence.reserve() : undefined;
      const { text } = await executeCall(t, rawArgs, toolUseId, uiSlot).finally(() => uiSlot?.release());
      executedToolResults.push({ toolCallId: toolUseId, toolName: t.name, result: text });
      return text;
    };

    // A call that needs approval says so in its description, in place of any
    // "confirm first" instruction: the card is the confirmation.
    const description = approvalRequirement(t).required ? `${t.description}\n\n${APPROVAL_TOOL_NOTE}` : t.description;
    return dynamicTool({
      description,
      inputSchema: jsonSchema(rawSchema),
      execute,
    });
  }

  // The tools for the current surfaces: the host's tools plus one UI tool per
  // mounted action. A UI action keeps its name over a host tool of the same
  // name (ADR-0209 D6): for a UI-only agent, the page is the authority.
  function currentTools(): RegisteredTool[] {
    const hostTools = config.tools.tools;
    let uiTools: RegisteredTool[] = [];
    if (config.ui && currentSurfaces.length > 0) {
      const built = buildUITools(currentSurfaces, {
        channel: config.ui.channel,
        resultTimeoutMs: uiResultTimeoutMs,
        maxObservationChars: config.ui.maxObservationChars,
        waitDeadline: uiWaitDeadline,
        currentSurfaces: () => currentSurfaces,
        sequence: uiSequence,
        onResult: (answer) => {
          if (!answer.surfaces) return;
          if (capabilityFingerprint(answer.surfaces) !== capabilityFingerprint(currentSurfaces)) {
            pendingSurfaces = answer.surfaces;
          }
        },
      });
      uiTools = built.tools;
      for (const c of built.collisions) {
        log('error', 'agent:ui', 'Two mounted surfaces declare the same action id; the first keeps it', {
          turnId,
          ...c,
        });
      }
    }

    const uiNames = new Set(uiTools.map((t) => t.name));
    const withheld = hostTools.filter((t) => uiNames.has(t.name)).map((t) => t.name);
    if (withheld.length > 0) {
      log('error', 'agent:ui', 'UI action ids collide with host tools; the host tools are withheld this turn', {
        turnId,
        withheld,
      });
    }
    return [...hostTools.filter((t) => !uiNames.has(t.name)), ...uiTools];
  }

  function assembleTools(): Record<string, AiTool> {
    const tools: Record<string, AiTool> = {};
    for (const t of currentTools()) tools[t.name] = toAiTool(t);
    return tools;
  }

  /**
   * The turn after the user's decision on an approval card (ADR-0228 §2.2.5):
   * redeem the token and run exactly the stored call, or learn that they
   * declined. What happened goes to the model as an `<approval>` note, and a
   * call that was run as a tool call and its result, which are persisted too.
   */
  async function continueApproval(continuation: ApprovalContinuation): Promise<{
    note: string;
    messages: ModelMessage[];
    persisted: TurnMessage[];
  }> {
    const outcome = await resolveContinuation(config.approvals, continuation, {
      userId: input.userId,
      conversationId: input.conversationId,
    });
    if (outcome.kind === 'note') {
      log('info', 'agent:tool', 'Approval continuation ran nothing', { turnId, approvalId: continuation.approvalId, decision: continuation.decision });
      return { note: outcome.note, messages: [], persisted: [] };
    }
    const { call } = outcome;
    const tool = currentTools().find((t) => t.name === call.tool);
    if (!tool) {
      log('warn', 'agent:tool', 'Approved call is not available this turn; it was not run', { turnId, approvalId: call.approvalId, toolName: call.tool });
      return { note: unavailableNote(call.tool), messages: [], persisted: [] };
    }
    const uiSlot = tool.kind === 'ui' ? uiSequence.reserve() : undefined;
    const { text, ran } = await executeCall(tool, call.args, call.approvalId, uiSlot, {
      approvalId: call.approvalId,
      argsHash: call.argsHash,
    }).finally(() => uiSlot?.release());
    // An approved action that changed the page: the turn starts on the new one.
    if (pendingSurfaces) {
      currentSurfaces = pendingSurfaces;
      pendingSurfaces = null;
    }
    const { title } = declaredTitle(tool);
    const callId = `${call.approvalId}-approved`;
    const refusal = ran ? null : (JSON.parse(text) as { error?: string }).error ?? 'it was refused';
    return {
      note: ran ? ranNote(title) : approvalNote(`The user approved "${title}" on the approval card, but it did not run: ${refusal}`),
      messages: [
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: callId, toolName: tool.name, input: call.args }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: callId, toolName: tool.name, output: { type: 'text', value: text } }] },
      ],
      persisted: [
        { role: 'assistant', content: null, toolCalls: [{ id: callId, name: tool.name, arguments: call.args }] },
        { role: 'tool', content: text, toolCallId: callId, name: tool.name },
      ],
    };
  }

  // Track cumulative text length emitted this turn.
  let totalTextEmitted = 0;

  // ─── Coalesce token deltas ─────────────────────────────────────────────────
  // Buffer for 50ms or 32 chars, whichever comes first, to avoid one HTTP POST
  // per token delta to the realtime server.
  const COALESCE_MS = 50;
  const COALESCE_CHARS = 32;
  let tokenBuffer = '';
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flushTokenBuffer = async () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (tokenBuffer.length > 0) {
      const text = tokenBuffer;
      tokenBuffer = '';
      totalTextEmitted += text.length;
      await config.emit.emit(socketRoom, AGENT_SOCKET_EVENTS.TOKEN, {
        turnId,
        text,
        timestamp: Date.now(),
      });
    }
  };

  // Run the multi-round generation
  try {
  // ─── Prompt cache breakpoints ──────────────────────────────────────────────
  // Every round of every turn re-sent the same ~25k-token prefix at full price:
  // the system prompt plus ~87 tool schemas, unchanged from the first call to
  // the last. A five-round turn paid for it five times.
  //
  // Providers that cache by breakpoint (Bedrock, Anthropic) render the request
  // as tools -> system -> messages, and a breakpoint caches the whole prefix up
  // to itself. So a breakpoint at the end of the system block covers the tool
  // definitions too, even where the provider offers no way to mark tools.
  //
  // What marks a breakpoint is provider-specific, so it is the host's to say
  // (`promptCacheBreakpoint`, e.g. PROMPT_CACHE_BREAKPOINTS.bedrock). Without
  // one, nothing is marked: a provider that caches on its own still does.
  //
  // The system prompt has to travel as a message rather than the top-level
  // `system` field, because only a message carries `providerOptions`.
  //
  // Two breakpoints, both on content that is append-only:
  //   1. system (+ tools) — identical for every round of a segment, and for
  //      every turn on the same page.
  //   2. the end of the incoming history — stable across the rounds that follow
  //      it, since a round appends rather than rewrites.
  //
  // Caching is a PREFIX match: one byte earlier in the prefix invalidates
  // everything after it. Nothing volatile may move ahead of these points — no
  // timestamp or request id in the system prompt, and a stable tool order.
  // A new segment changes the tool set, so it writes a new prefix; that happens
  // only when the page changes. `cacheReadTokens` in the usage below is how you
  // tell caching is still working.
  const cachePoint = config.promptCacheBreakpoint;

  // ─── The turn after an approval decision (ADR-0228 §2.2.5) ────────────────
  const continued = input.approval ? await continueApproval(input.approval) : null;

  // Convert history to AI SDK CoreMessage format. The page the user is on
  // travels with their message, not in the system prompt: it changes on every
  // page, and in the system prompt it would invalidate the cached prefix. An
  // approved call that ran follows the user's message, as the call it was.
  const messages: ModelMessage[] = [
    ...withPageState(
      convertHistoryToCoreMessages(input.history ?? [], [input.content, continued?.note].filter(Boolean).join('\n\n')),
      snapshot,
      config.ui?.maxObservationChars ?? DEFAULT_PAGE_STATE_CHARS,
    ),
    ...(continued?.messages ?? []),
  ];

  // The system prompt goes in `instructions`, NOT in `messages`.
  //
  // ai v7 rejects a system-role entry in `messages` outright —
  // AI_InvalidPromptError, "System messages are not allowed in the prompt or
  // messages fields" — because `allowSystemInMessages` defaults to false. An
  // earlier attempt at these breakpoints put it there and broke every turn.
  //
  // `instructions` takes `string | SystemModelMessage | SystemModelMessage[]`,
  // and the message form carries `providerOptions`, so the breakpoint travels
  // with it. (`system` is the deprecated alias for the same type.)
  const instructions = {
    role: 'system' as const,
    content: systemPrompt,
    ...(cachePoint ? { providerOptions: cachePoint } : {}),
  };

  const withCachePoint = (msgs: ModelMessage[]): ModelMessage[] => !cachePoint ? msgs : [
    ...msgs.slice(0, -1),
    ...msgs.slice(-1).map((m) => ({
      ...m,
      providerOptions: { ...(m.providerOptions ?? {}), ...cachePoint },
    }) as ModelMessage),
  ];

  type SegmentStep = Awaited<ReturnType<typeof streamText>['steps']>[number];
  const allSteps: SegmentStep[] = [];
  let conversation: ModelMessage[] = messages;
  let segments = 0;
  let responseMessageCount = 0;
  const usageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  for (;;) {
    segments++;
    const aiTools = assembleTools();
    const previousSteps = [...allSteps];

    log('info', 'agent:llm', 'Messages prepared', {
      turnId,
      segment: segments,
      messageCount: conversation.length,
      toolCount: Object.keys(aiTools).length,
    });

    const result = streamText({
      model: config.model,
      instructions,
      messages: withCachePoint(conversation),
      tools: aiTools,
      maxOutputTokens: maxTokens,
      maxRetries: retries,
      abortSignal: abortController.signal,
      stopWhen: [
        isStepCount(maxRounds - allSteps.length),
        ...USER_INPUT_TOOLS.map((name) => hasToolCall(name)),
        // A call is waiting for the user's approval: the turn ends here (ADR-0228).
        () => approvalHold !== null,
        // The page now offers different actions: end this segment so the next
        // one is built from them (ADR-0209 D3).
        () => pendingSurfaces !== null,
      ],
      temperature,
      telemetry: {
        isEnabled: true,
        functionId: `agent-turn:${turnId}`,
      },
      prepareStep: async ({ steps }) => {
        const { note, ...constraints } = await turnPolicy.prepareStep({
          // The policy counts steps across the whole turn, not per segment.
          steps: [...previousSteps, ...steps],
          turnClass,
          allToolNames: Object.keys(aiTools),
        });
        // The policy's note goes after the system prompt, for this step only.
        // ai carries an instructions override forward to later steps, so a step
        // without a note sets the plain instructions back.
        return {
          ...constraints,
          instructions: note ? [instructions, { role: 'system' as const, content: note }] : instructions,
        };
      },
      onStepEnd: async ({ text, toolCalls }) => {
        log('info', 'agent:llm', 'Step completed', {
          turnId,
          turnClass,
          segment: segments,
          textLength: text?.length ?? 0,
          toolCallCount: toolCalls?.length ?? 0,
          totalTextEmitted,
        });
      },
    });

    for await (const textPart of result.textStream) {
      tokenBuffer += textPart;
      if (tokenBuffer.length >= COALESCE_CHARS) {
        await flushTokenBuffer();
      } else if (!flushTimer) {
        flushTimer = setTimeout(() => flushTokenBuffer(), COALESCE_MS);
      }
    }
    await flushTokenBuffer();

    // After the text stream completes, all promised properties resolve.
    const steps = await result.steps;
    const segmentUsage = await result.usage;
    const response = await result.response;

    allSteps.push(...steps);
    usageTotals.inputTokens += segmentUsage?.inputTokens ?? 0;
    usageTotals.outputTokens += segmentUsage?.outputTokens ?? 0;
    usageTotals.cacheReadTokens += segmentUsage?.inputTokenDetails?.cacheReadTokens ?? 0;
    usageTotals.cacheWriteTokens += segmentUsage?.inputTokenDetails?.cacheWriteTokens ?? 0;
    responseMessageCount += response.messages.length;
    conversation = [...conversation, ...response.messages];

    const askedUser = steps.some((s: { toolCalls?: Array<{ toolName: string }> }) =>
      s.toolCalls?.some((tc) => (USER_INPUT_TOOLS as readonly string[]).includes(tc.toolName)),
    );
    const next = pendingSurfaces as OUISurface[] | null;
    if (next && !askedUser && !approvalHold && allSteps.length < maxRounds) {
      log('info', 'agent:ui', 'The page changed; continuing the turn with its actions', {
        turnId,
        from: currentSurfaces.map((s) => s.id),
        to: next.map((s) => s.id),
      });
      currentSurfaces = next;
      pendingSurfaces = null;
      continue;
    }
    if (next) {
      // The turn ends here anyway; the next turn starts from the client's new snapshot.
      currentSurfaces = next;
      pendingSurfaces = null;
    }
    break;
  }

  // ─── Finalize ──────────────────────────────────────────────────────────────
  const steps = allSteps;

  // Determine stop reason
  let stopReason: AgentTurnResult['stopReason'] = 'complete';
  if (approvalHold) {
    stopReason = 'awaiting_approval';
  } else if (steps.length >= maxRounds) {
    stopReason = 'step_count';
  } else if (steps.some((s: { toolCalls?: Array<{ toolName: string }> }) => s.toolCalls?.some(tc => (USER_INPUT_TOOLS as readonly string[]).includes(tc.toolName)))) {
    stopReason = 'present_options';
  }
  // deadline and token_budget are caught by the try/catch — they produce errors, not normal returns

  // ─── Usage ─────────────────────────────────────────────────────────────────
  // `promptTokens` is the SUM over rounds, and it was the only number reported.
  // Read as a context measurement it is wrong by a factor of the round count: a
  // five-round turn showed 128,808 tokens when no single call exceeded ~26,000,
  // so the context ceiling fired on turns that were nowhere near the window and
  // said nothing about the ones that were.
  //
  // Both numbers matter, and they answer different questions:
  //   peakPromptTokens — the largest single call. What the context window sees,
  //                      and what the ceiling must be compared against.
  //   promptTokens     — the sum. What the turn costs.
  //
  // cacheReadTokens/cacheWriteTokens are the caching gauge: a read of roughly
  // the prefix size on every round after the first means the breakpoints above
  // are holding. Reads at zero across a multi-round turn mean something
  // volatile has moved into the prefix and the cache is being missed silently.
  const stepInputTokens = steps.map((s) => s.usage?.inputTokens ?? 0);
  const usage = {
    promptTokens: usageTotals.inputTokens,
    completionTokens: usageTotals.outputTokens,
    totalTokens: usageTotals.inputTokens + usageTotals.outputTokens,
    peakPromptTokens: stepInputTokens.length > 0 ? Math.max(...stepInputTokens) : 0,
    cacheReadTokens: usageTotals.cacheReadTokens,
    cacheWriteTokens: usageTotals.cacheWriteTokens,
  };

  log('info', 'agent:llm', 'Turn usage', {
    turnId,
    rounds: steps.length,
    segments,
    peakPromptTokens: usage.peakPromptTokens,
    promptTokens: usage.promptTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
  });

  await config.emit.emit(socketRoom, AGENT_SOCKET_EVENTS.TURN_COMPLETE, {
    turnId,
    rounds: steps.length,
    usage,
    timestamp: Date.now(),
  });

  log('info', 'agent:turn', 'Turn completed', {
    turnId,
    conversationId: input.conversationId,
    totalRounds: steps.length,
    segments,
    maxRoundsReached: steps.length >= maxRounds,
    usage,
    newMessageCount: responseMessageCount,
  });

  // Convert AI SDK response messages to our TurnMessage format for persistence
  const newMessages = [...(continued?.persisted ?? []), ...convertResponseToTurnMessages({ steps }, executedToolResults)];

  return {
    rounds: steps.length,
    usage,
    newMessages,
    maxRoundsReached: steps.length >= maxRounds,
    stopReason,
  };
  } finally {
    clearTimeout(deadlineTimer);
    if (flushTimer) clearTimeout(flushTimer);
  }
}

/**
 * Put the client's page state on the user's message: which surfaces are
 * mounted and their latest observations. The model reads it as part of what
 * the user said, where it is true for this message only.
 */
function withPageState(
  messages: ModelMessage[],
  snapshot: OUISurfaceSnapshot | null,
  maxChars: number,
): ModelMessage[] {
  if (!snapshot || snapshot.surfaces.length === 0) return messages;
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return messages;

  const observations = observationsText(snapshot.observations, maxChars);
  const pageState = [
    '<page_state>',
    `The user's screen offers: ${snapshot.surfaces.map((s) => `${s.name} (${s.id})`).join(', ')}.`,
    `Current values: ${observations}`,
    '</page_state>',
  ].join('\n');

  const text = typeof last.content === 'string'
    ? last.content
    : last.content.map((p) => ('text' in p ? p.text : '')).join('');
  return [...messages.slice(0, -1), { role: 'user', content: `${text}\n\n${pageState}` }];
}

/**
 * Convert our TurnHistoryMessage[] to AI SDK CoreMessage[].
 * The AI SDK handles each provider's message format internally.
 *
 * DEFENSIVE: If an assistant message has tool_calls but a matching tool result
 * is missing from history, we synthesize a placeholder result. This prevents
 * AI_MissingToolResultsError crashes when persistence has gaps (e.g., stopWhen
 * triggered before a tool result was persisted).
 */
function convertHistoryToCoreMessages(history: TurnHistoryMessage[], currentContent: string): ModelMessage[] {
  const messages: ModelMessage[] = [];

  // First pass: collect all tool_call_ids that have results in history
  // AND all tool call IDs from assistant messages (to validate results)
  const answeredToolCallIds = new Set<string>();
  const knownToolCallIds = new Set<string>();
  for (const msg of history) {
    if (msg.role === 'tool' && msg.tool_call_id) {
      answeredToolCallIds.add(msg.tool_call_id);
    }
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        knownToolCallIds.add(tc.id);
      }
    }
  }

  log('info', 'agent:llm', 'History conversion diagnostics', {
    sdkVersion: '2.4.5-diag',
    historyLength: history.length,
    answeredToolCallIds: Array.from(answeredToolCallIds),
    knownToolCallIds: Array.from(knownToolCallIds),
    toolMessages: history.filter(m => m.role === 'tool').map(m => ({
      tool_call_id: m.tool_call_id,
      name: m.name,
      inKnown: knownToolCallIds.has(m.tool_call_id ?? ''),
    })),
  });

  for (let idx = 0; idx < history.length; idx++) {
    const msg = history[idx];
    if (msg.role === 'user') {
      messages.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      if (msg.content || msg.tool_calls?.length) {
        const parts: Array<TextPart | ToolCallPart> = [];

        if (msg.content) {
          parts.push({ type: 'text', text: msg.content });
        }
        if (msg.tool_calls?.length) {
          for (const tc of msg.tool_calls) {
            let toolName: string;
            let args: Record<string, unknown>;

            if (tc.function && typeof tc.function === 'object') {
              toolName = tc.function.name;
              try {
                args = typeof tc.function.arguments === 'string'
                  ? JSON.parse(tc.function.arguments)
                  : tc.function.arguments as unknown as Record<string, unknown>;
              } catch { args = {}; }
            } else {
              const flat = tc as unknown as { id: string; name: string; arguments: unknown };
              toolName = flat.name;
              try {
                args = typeof flat.arguments === 'string'
                  ? JSON.parse(flat.arguments)
                  : (flat.arguments as Record<string, unknown>) ?? {};
              } catch { args = {}; }
            }

            parts.push({ type: 'tool-call' as const, toolCallId: tc.id, toolName, input: args });
          }
        }
        messages.push({ role: 'assistant' as const, content: parts });

        // DEFENSIVE: synthesize missing tool results for any tool_calls
        // that don't have a matching tool result in history.
        if (msg.tool_calls?.length) {
          for (const tc of msg.tool_calls) {
            if (!answeredToolCallIds.has(tc.id)) {
              const toolName = tc.function?.name ?? (tc as unknown as { name?: string }).name ?? 'unknown';
              log('info', 'agent:llm', 'SYNTHESIZING tool result (missing from history)', {
                toolCallId: tc.id,
                toolName,
                answeredIds: Array.from(answeredToolCallIds),
              });
              messages.push({
                role: 'tool' as const,
                content: [{
                  type: 'tool-result' as const,
                  toolCallId: tc.id,
                  toolName,
                  output: { type: 'text' as const, value: JSON.stringify({ acknowledged: true }) },
                }],
              });
              // Mark as answered so we don't double-synthesize
              answeredToolCallIds.add(tc.id);
            }
          }
        }
      }
    } else if (msg.role === 'tool') {
      // Skip tool results that are corrupted or orphaned:
      // 1. Empty tool_call_id (persistence bug: toolCallId was undefined)
      // 2. tool_call_id that doesn't match ANY known tool call in the conversation
      //    (persistence bug: fallback ID 'tool_${timestamp}' instead of real ID)
      // The defensive synthesis above creates proper results for the real tool calls.
      if (!msg.tool_call_id || !knownToolCallIds.has(msg.tool_call_id)) {
        log('info', 'agent:llm', 'SKIPPING orphaned tool result', {
          tool_call_id: msg.tool_call_id,
          name: msg.name,
          inKnown: msg.tool_call_id ? knownToolCallIds.has(msg.tool_call_id) : false,
        });
        continue;
      }

      log('info', 'agent:llm', 'KEEPING valid tool result', {
        tool_call_id: msg.tool_call_id,
        name: msg.name,
      });

      // Tool result output must use discriminated format: { type: 'text', value: string }
      const outputValue = msg.content || 'acknowledged';
      messages.push({
        role: 'tool' as const,
        content: [{
          type: 'tool-result' as const,
          toolCallId: msg.tool_call_id,
          toolName: msg.name ?? 'unknown',
          output: { type: 'text' as const, value: outputValue },
        }],
      });
    }
  }

  // Add current user message if not already at the end
  const lastMsg = messages[messages.length - 1];
  if (!lastMsg || lastMsg.role !== 'user') {
    messages.push({ role: 'user', content: currentContent });
  }

  // Final diagnostics: summary of converted messages
  log('info', 'agent:llm', 'Converted messages summary', {
    totalMessages: messages.length,
    byRole: messages.reduce((acc: Record<string, number>, m) => {
      acc[m.role] = (acc[m.role] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
    toolResults: messages
      .filter((m): m is ToolModelMessage => m.role === 'tool')
      .map((m) => {
        const first = m.content[0];
        return {
          toolCallId: first && 'toolCallId' in first ? first.toolCallId : undefined,
          toolName: first && 'toolName' in first ? first.toolName : undefined,
        };
      }),
    assistantToolCalls: messages
      .filter((m): m is AssistantModelMessage => m.role === 'assistant')
      .map((m) => ({
        hasToolCalls: Array.isArray(m.content) && m.content.some((p) => p.type === 'tool-call'),
        toolCallIds: Array.isArray(m.content)
          ? m.content.filter((p): p is ToolCallPart => p.type === 'tool-call').map((p) => p.toolCallId)
          : [],
      })),
  });

  return messages;
}

/**
 * Convert AI SDK response to our TurnMessage[] format for persistence.
 * Uses manually tracked executedToolResults since step.toolResults may be empty
 * for dynamicTool definitions.
 */
interface ConvertableStep {
  text: string;
  toolCalls: ReadonlyArray<{ toolCallId: string; toolName: string; args?: Record<string, unknown>; input?: unknown }>;
}

function convertResponseToTurnMessages(
  result: { steps: ReadonlyArray<ConvertableStep> },
  executedToolResults: Array<{ toolCallId: string; toolName: string; result: string }>,
): TurnMessage[] {
  const turnMessages: TurnMessage[] = [];
  let resultIdx = 0;

  for (const step of result.steps) {
    // Assistant message with text and/or tool calls
    if (step.text || step.toolCalls.length > 0) {
      const msg: TurnMessage = {
        role: 'assistant',
        content: step.text || null,
      };
      if (step.toolCalls.length > 0) {
        msg.toolCalls = step.toolCalls.map((tc) => ({
          id: tc.toolCallId,
          name: tc.toolName,
          arguments: (tc.args ?? tc.input ?? {}) as Record<string, unknown>,
        }));
      }
      turnMessages.push(msg);

      // Add tool results for the tool calls in this step
      for (let i = 0; i < step.toolCalls.length && resultIdx < executedToolResults.length; i++) {
        const tracked = executedToolResults[resultIdx++];
        turnMessages.push({
          role: 'tool',
          content: tracked.result,
          toolCallId: tracked.toolCallId,
          name: tracked.toolName,
        });
      }
    }
  }

  return turnMessages;
}


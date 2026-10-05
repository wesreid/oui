/**
 * Runs the fixture turn on either host adapter, with any model, against the
 * fixture product, and returns what the product and its user got. The
 * acceptance test replays recorded responses through it; the recorder runs it
 * on a live model.
 */
import type { SQSEvent } from 'aws-lambda';
import { AGENT_SOCKET_EVENTS } from '@ouispec/agent-core';
import { createLambdaAgentHandler } from '../../lambda/handler.js';
import { startContainerAgentWorker } from '../../container/server.js';
import { createHttpUIActionChannel } from '../../ui/channel.js';
import type { AgentRuntimeConfig } from '../../runtime/types.js';
import type { TurnOutcome } from '../../runtime/turn-runner.js';
import type { LanguageModel, ProviderOptions } from '../../model.js';
import type { TurnHistoryMessage, TurnMessage } from '../../types.js';
import type { RegisteredTool } from '../../tools/types.js';
import type { ToolPolicy } from '../../authz/tool-policy.js';
import type { AgentTurnPayload } from '../../runtime/types.js';
import type { AgentApiSurface } from '@ouispec/agent-core';
import { FIXTURE_TURN, INTERNAL_KEY, type FixtureProduct, type FixtureTab } from './fixture-product.js';

export type HostAdapter = 'lambda' | 'container';

export interface FixtureTurnRun {
  tab: FixtureTab;
  outcome: TurnOutcome;
  persisted: Array<{ turnId: string; conversationId: string; messages: TurnMessage[] }>;
  startedWithModel: string[];
}

const WORKER_KEY = 'fixture-worker-key';
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

export const FIXTURE_SYSTEM_PROMPT =
  "You are the assistant in Desk, a reporting product. Do what the user asks with the page's tools, then say in one short sentence what you did.";

/**
 * The product's conversation store: what its API keeps of each turn — the
 * user's message, then the messages the worker persists — and hands back as
 * history. Lets a test run several turns of one conversation.
 */
export class FixtureConversation {
  readonly history: TurnHistoryMessage[] = [];

  addUser(content: string): void {
    if (content) this.history.push({ role: 'user', content });
  }

  persist(messages: TurnMessage[]): void {
    for (const m of messages) {
      if (m.role === 'assistant') {
        this.history.push({
          role: 'assistant',
          content: m.content,
          ...(m.toolCalls?.length
            ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) }
            : {}),
        });
      } else {
        this.history.push({ role: 'tool', content: m.content ?? '', tool_call_id: m.toolCallId ?? '', name: m.name });
      }
    }
  }
}

export interface FixtureTurnOptions {
  adapter: HostAdapter;
  model: LanguageModel;
  promptCacheBreakpoint?: ProviderOptions;
  turnId?: string;
  /** The tab that sends the turn; a new one is opened when none is given. */
  tab?: FixtureTab;
  /** What the turn carries beyond the fixture turn's defaults: its message, context, an approval. */
  payload?: Partial<Pick<AgentTurnPayload, 'content' | 'context' | 'approval'>>;
  /** Earlier turns of the conversation, and where this one's messages go. */
  conversation?: FixtureConversation;
  tools?: RegisteredTool[];
  /** The API the product's backend tools call. */
  apiSurface?: AgentApiSurface;
  toolPolicy?: ToolPolicy;
  /**
   * The given tab joins the turn's room only this long after the turn is
   * handed to the worker, as a browser does: it learns the room from the
   * send-message answer, while the worker may already be running the turn.
   */
  tabJoinsAfterMs?: number;
  /** Called with each UI action request the worker sends, once the realtime server has taken it. */
  onUIDispatch?: (requestId: string) => void;
}

/** The realtime server's UI action channel, as the worker builds it, telling the test of each request sent. */
function observedChannel(product: FixtureProduct, onDispatch: ((requestId: string) => void) | undefined) {
  const channel = createHttpUIActionChannel({ url: product.realtimeUrl, apiKey: INTERNAL_KEY });
  if (!onDispatch) return channel;
  return {
    ...channel,
    dispatch: async (...args: Parameters<typeof channel.dispatch>) => {
      const receipt = await channel.dispatch(...args);
      onDispatch(args[1].requestId);
      return receipt;
    },
  };
}

export async function runFixtureTurn(product: FixtureProduct, options: FixtureTurnOptions): Promise<FixtureTurnRun> {
  const turnId = options.turnId ?? `${FIXTURE_TURN.turnId}-${options.adapter}`;
  const payload: AgentTurnPayload = { ...FIXTURE_TURN, turnId, socketRoom: `chat:turn:${turnId}`, ...options.payload };
  let tab: FixtureTab;
  const lateJoin = options.tab && options.tabJoinsAfterMs !== undefined;
  if (options.tab) {
    tab = options.tab;
    if (!lateJoin) await tab.joinTurn(payload.socketRoom);
  } else {
    tab = await product.openTab('session-ana', payload.socketRoom);
  }
  // The tab is on the page the turn says it was sent from.
  const sentFrom = (payload.context as { currentPath?: unknown } | null | undefined)?.currentPath;
  if (typeof sentFrom === 'string') tab.show(sentFrom);
  const conversation = options.conversation;
  const history = conversation ? [...conversation.history] : [];
  conversation?.addUser(payload.content);

  const persisted: FixtureTurnRun['persisted'] = [];
  const startedWithModel: string[] = [];
  const config: AgentRuntimeConfig<object> = {
    model: options.model,
    promptCacheBreakpoint: options.promptCacheBreakpoint,
    realtime: { url: product.realtimeUrl, apiKey: INTERNAL_KEY },
    systemPrompt: () => FIXTURE_SYSTEM_PROMPT,
    tools: options.tools ?? [],
    toolPolicy: options.toolPolicy,
    ...(options.apiSurface ? { apiSurface: options.apiSurface } : {}),
    uiActions: { resultTimeoutMs: 10_000, channel: observedChannel(product, options.onUIDispatch) },
    getDb: async () => ({}),
    getHistory: async () => history,
    persistMessages: async ({ turnId: id, conversationId, messages }) => {
      persisted.push({ turnId: id, conversationId, messages });
      conversation?.persist(messages);
    },
    recordTurnStart: async ({ model }) => {
      startedWithModel.push(model);
    },
    logger: quiet,
  };

  const joinLate = () =>
    lateJoin ? new Promise<void>((resolve, reject) => setTimeout(() => tab.joinTurn(payload.socketRoom).then(resolve, reject), options.tabJoinsAfterMs)) : Promise.resolve();

  let outcome: TurnOutcome;
  if (options.adapter === 'lambda') {
    const handler = createLambdaAgentHandler(config);
    let thrown: unknown = null;
    const running = handler({ Records: [{ body: JSON.stringify(payload) }] } as unknown as SQSEvent).catch((err: unknown) => {
      thrown = err;
    });
    await joinLate();
    await running;
    outcome = thrown
      ? { status: 'failed', turnId, error: { code: 'THROWN', message: String(thrown), recoverable: false }, cause: thrown }
      : { status: 'completed', turnId, rounds: -1 };
  } else {
    let resolveOutcome!: (o: TurnOutcome) => void;
    const ended = new Promise<TurnOutcome>((resolve) => (resolveOutcome = resolve));
    const worker = await startContainerAgentWorker({ ...config, port: 0, workerApiKey: WORKER_KEY, onTurnEnd: resolveOutcome });
    try {
      const res = await fetch(`http://127.0.0.1:${worker.port}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': WORKER_KEY },
        body: JSON.stringify(payload),
      });
      if (res.status !== 202) throw new Error(`container refused the turn: HTTP ${res.status} ${await res.text()}`);
      await joinLate();
      outcome = await ended;
    } finally {
      await worker.close();
    }
  }

  // The last event of a turn: once it is here, everything before it is too.
  if (outcome.status === 'completed') await tab.waitForTurn(AGENT_SOCKET_EVENTS.TURN_COMPLETE, turnId);
  return { tab, outcome, persisted, startedWithModel };
}

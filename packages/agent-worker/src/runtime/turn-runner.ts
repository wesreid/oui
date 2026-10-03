/**
 * The agent runtime's core: one turn, from payload to persisted messages.
 *
 * Both host adapters wrap it — the Lambda + SQS handler and the container
 * server — so a turn runs the same way wherever it is hosted. The adapter only
 * decides how a turn arrives and what a failure means to its transport.
 */
import { APICallError, RetryError } from 'ai';
import { AGENT_SOCKET_EVENTS } from '@ouispec/agent-core';
import { runAgentTurn } from '../orchestrator.js';
import { createHttpEmitAdapter } from '../emit/http-adapter.js';
import { createHttpUIActionChannel } from '../ui/channel.js';
import { createHttpApprovalStoreClient } from '../approvals/client.js';
import { withoutClientUI } from '../ui/snapshot.js';
import { createToolRegistry } from '../tools/types.js';
import { buildAgentSystemPrompt } from '../prompt/index.js';
import { describeModel } from '../model.js';
import type { AgentTurnInput } from '../types.js';
import type { AgentRuntimeConfig, AgentTurnPayload } from './types.js';
import { assertAgentRuntimeConfig } from './config.js';

export interface CategorizedError {
  code: string;
  message: string;
  recoverable: boolean;
}

export type TurnOutcome =
  | { status: 'completed'; turnId: string; rounds: number }
  | { status: 'failed'; turnId: string; error: CategorizedError; cause: unknown };

export interface AgentTurnRunner {
  /** Runs one turn to its end. Never throws for a turn's own failure: it reports it. */
  run(payload: AgentTurnPayload): Promise<TurnOutcome>;
  /** The model, as logs name it. */
  readonly model: string;
  /** The host's logger, or the default one. */
  readonly logger: RuntimeLogger;
}

type RuntimeLogger = NonNullable<AgentRuntimeConfig['logger']>;

const DEFAULT_LOGGER: RuntimeLogger = {
  info: (msg, data) => console.log(JSON.stringify({ level: 'info', msg, ...data })),
  warn: (msg, data) => console.warn(JSON.stringify({ level: 'warn', msg, ...data })),
  error: (msg, data) => console.error(JSON.stringify({ level: 'error', msg, ...data })),
  debug: (msg, data) => {
    if (process.env.LOG_LEVEL === 'debug') console.log(JSON.stringify({ level: 'debug', msg, ...data }));
  },
};

const PAYLOAD_FIELDS = ['turnId', 'conversationId', 'userId', 'accountId', 'socketRoom', 'content'] as const;

/** Why a payload is not a turn, or null when it is one. */
export function payloadRefusal(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return 'the turn payload must be an object';
  const p = payload as Record<string, unknown>;
  const missing = PAYLOAD_FIELDS.filter((f) => typeof p[f] !== 'string' || (f !== 'content' && !p[f]));
  if (missing.length > 0) return `the turn payload is missing ${missing.join(', ')}`;
  if (p.context !== undefined && p.context !== null && typeof p.context !== 'object') return 'context must be an object';
  if (p.userToken !== undefined && typeof p.userToken !== 'string') return 'userToken must be a string';
  if (p.approval !== undefined) {
    const a = p.approval as Record<string, unknown> | null;
    if (!a || typeof a !== 'object' || typeof a.approvalId !== 'string' || !a.approvalId) return 'approval needs an approvalId';
    if (a.decision === 'approve') {
      if (typeof a.token !== 'string' || !a.token) return 'an approval to redeem needs its token';
    } else if (a.decision !== 'decline') {
      return "approval.decision must be 'approve' or 'decline'";
    }
  }
  return null;
}

export function createAgentTurnRunner<TDb>(config: AgentRuntimeConfig<TDb>): AgentTurnRunner {
  assertAgentRuntimeConfig(config);
  const logger = config.logger ?? DEFAULT_LOGGER;
  const model = describeModel(config.model);

  const maxRounds = config.maxRounds ?? 12;
  const maxTokens = config.maxTokens ?? 4096;
  // Left undefined when not set, so the orchestrator's default applies; null (send none) is passed through.
  const temperature = config.temperature;
  const toolTimeoutMs = config.toolTimeoutMs ?? 30_000;
  const turnDeadlineMs = config.turnDeadlineMs ?? 840_000;
  const retries = config.retries ?? 3;

  const emit = createHttpEmitAdapter({ url: config.realtime.url, apiKey: config.realtime.apiKey });
  // UI actions reach the client through the same realtime server, and its
  // answers come back through it (ADR-0209).
  const uiChannel =
    config.uiActions?.channel ?? createHttpUIActionChannel({ url: config.realtime.url, apiKey: config.realtime.apiKey });

  // Approvals are kept by the same realtime server (ADR-0228 §2.4).
  const approvals =
    config.approvals?.store ?? createHttpApprovalStoreClient({ url: config.realtime.url, apiKey: config.realtime.apiKey });

  const resolveTools = async (ctx: { userId: string; accountId: string; turnId: string }) =>
    createToolRegistry(typeof config.tools === 'function' ? await config.tools(ctx) : config.tools);

  logger.info('[agent-sdk] Runtime ready', { model, maxRounds, maxTokens, turnDeadlineMs });

  return {
    model,
    logger,
    async run(payload) {
      const { turnId, conversationId, userId, accountId, socketRoom, content, context, userToken, approval } = payload;
      logger.info('[agent-sdk] Processing turn', { turnId, conversationId, userId });

      let db: TDb;
      try {
        db = await config.getDb();
      } catch (error) {
        // No handle, so nothing can be recorded; the client is still told.
        return fail(payload, error);
      }

      if (config.recordTurnStart) {
        try {
          await config.recordTurnStart({ turnId, conversationId, userId, accountId, model, db });
        } catch (err) {
          logger.warn('[agent-sdk] recordTurnStart failed', { error: messageOf(err) });
        }
      }

      try {
        const history = await config.getHistory(conversationId, db);

        // What the client's UI sent for the worker is not the host's prompt
        // text: its snapshot becomes the turn's UI tools, and its knowledge is
        // rendered after the host's prompt (orchestrator).
        const promptContext = { userId, accountId, context: withoutClientUI(context) };
        const systemPrompt = config.systemPrompt
          ? config.systemPrompt(promptContext)
          : buildAgentSystemPrompt(config.persona!, promptContext);

        const turnInput: AgentTurnInput = {
          turnId,
          conversationId,
          userId,
          accountId,
          socketRoom,
          content,
          context,
          history,
          userToken,
          ...(approval ? { approval } : {}),
        };

        const tools = await resolveTools({ userId, accountId, turnId });
        const result = await runAgentTurn(
          {
            tools,
            emit,
            apiSurface: config.apiSurfaceFactory ? config.apiSurfaceFactory({ userId, accountId, userToken }) : config.apiSurface,
            systemPrompt,
            model: config.model,
            promptCacheBreakpoint: config.promptCacheBreakpoint,
            maxToolRounds: maxRounds,
            maxTokens,
            temperature,
            toolTimeoutMs,
            turnDeadlineMs,
            retries,
            turnPolicy: config.turnPolicy,
            toolPolicy: config.toolPolicy,
            approvals,
            ui: {
              channel: uiChannel,
              resultTimeoutMs: config.uiActions?.resultTimeoutMs,
              maxObservationChars: config.uiActions?.maxObservationChars,
              maxIndexChars: config.uiActions?.maxIndexChars,
            },
          },
          turnInput,
        );

        logger.info('[agent-sdk] Turn completed', {
          turnId,
          rounds: result.rounds,
          maxRoundsReached: result.maxRoundsReached,
          usage: result.usage,
        });

        if (config.recordTurnComplete) {
          try {
            await config.recordTurnComplete({ turnId, conversationId, rounds: result.rounds, usage: result.usage, db });
          } catch (err) {
            logger.warn('[agent-sdk] recordTurnComplete failed', { error: messageOf(err) });
          }
        }

        try {
          await config.persistMessages({ turnId, conversationId, messages: result.newMessages, usage: result.usage, db });
        } catch (err) {
          logger.error('[agent-sdk] persistMessages failed', { turnId, error: messageOf(err) });
        }
        return { status: 'completed', turnId, rounds: result.rounds };
      } catch (error) {
        return fail(payload, error, async (categorized) => {
          if (!config.recordTurnFailure) return;
          try {
            await config.recordTurnFailure({ turnId, conversationId, error: categorized, db });
          } catch (err) {
            logger.warn('[agent-sdk] recordTurnFailure failed', { error: messageOf(err) });
          }
        });
      }
    },
  };

  /** Reports a failed turn to the client first, so the UI stops streaming, then to the host. */
  async function fail(
    payload: AgentTurnPayload,
    error: unknown,
    record?: (categorized: CategorizedError) => Promise<void>,
  ): Promise<TurnOutcome> {
    const { turnId, socketRoom } = payload;
    const categorized = categorizeError(error);
    logger.error('[agent-sdk] Turn failed', { turnId, ...categorized });
    try {
      await emit.emit(socketRoom, AGENT_SOCKET_EVENTS.TURN_ERROR, {
        turnId,
        error: { code: categorized.code, message: categorized.message },
        timestamp: Date.now(),
      });
    } catch (emitErr) {
      logger.warn('[agent-sdk] Failed to emit turn_error to client', { turnId, error: messageOf(emitErr) });
    }
    await record?.(categorized);
    return { status: 'failed', turnId, error: categorized, cause: error };
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Sorts a failure into what the client is told, and whether trying again could help. */
export function categorizeError(err: unknown): CategorizedError {
  const cause = RetryError.isInstance(err) ? err.lastError : err;
  const msg = messageOf(err);
  const status = APICallError.isInstance(cause) ? cause.statusCode : undefined;

  if (status === 429 || /throttl|rate limit|too many requests/i.test(msg)) {
    return { code: 'RATE_LIMIT', message: 'The model provider is rate-limiting requests', recoverable: true };
  }
  if (status === 503 || status === 529 || /service ?unavailable|overloaded/i.test(msg)) {
    return { code: 'SERVICE_UNAVAILABLE', message: 'The model provider is unavailable', recoverable: true };
  }
  if (/ModelTimeout|model timeout/i.test(msg)) {
    return { code: 'MODEL_TIMEOUT', message: 'The model timed out', recoverable: true };
  }
  if (/timed out|deadline/i.test(msg)) {
    return { code: 'TURN_TIMEOUT', message: msg, recoverable: false };
  }
  return { code: 'WORKER_ERROR', message: msg, recoverable: false };
}

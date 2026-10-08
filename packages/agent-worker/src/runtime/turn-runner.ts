/**
 * The agent runtime's core: one turn, from payload to persisted messages.
 *
 * Both host adapters wrap it — the Lambda + SQS handler and the container
 * server — so a turn runs the same way wherever it is hosted. The adapter only
 * decides how a turn arrives and what a failure means to its transport.
 */
import { APICallError, RetryError } from 'ai';
import { AGENT_SOCKET_EVENTS, APPROVAL_CHANNELS, isAttachmentId, type TurnStoppedReason, type TurnStoppedMarker } from '@ouispec/agent-core';
import { runAgentTurn } from '../orchestrator.js';
import { createHttpEmitAdapter } from '../emit/http-adapter.js';
import { createHttpUIActionChannel } from '../ui/channel.js';
import { createHttpApprovalStoreClient } from '../approvals/client.js';
import { createHttpTurnStopClient, watchTurnStop } from '../stop/turn-stop.js';
import { withoutClientUI } from '../ui/snapshot.js';
import { createToolRegistry } from '../tools/types.js';
import { buildAgentSystemPrompt } from '../prompt/index.js';
import { describeModel } from '../model.js';
import type { AgentTurnInput, AgentTurnResult, TurnMessage } from '../types.js';
import type { AgentRuntimeConfig, AgentTurnPayload } from './types.js';
import { assertAgentRuntimeConfig } from './config.js';

export interface CategorizedError {
  code: string;
  message: string;
  recoverable: boolean;
}

/**
 * The failure code of a turn that ran out of time and whose stop path could
 * not store what it had produced (ADR-0252 §6.4): a host records it as
 * `deadline_exceeded`, not as stopped.
 */
export const TURN_DEADLINE_EXCEEDED = 'TURN_DEADLINE_EXCEEDED';

export type TurnOutcome =
  | { status: 'completed'; turnId: string; rounds: number }
  /** The turn was stopped (ADR-0252): what it had produced is stored, and the client was told. */
  | {
      status: 'stopped';
      turnId: string;
      rounds: number;
      stopReason: TurnStoppedReason;
      /** `false` when what the turn had produced could not be stored: a deadline stop is then recorded as `TURN_DEADLINE_EXCEEDED`. */
      stored?: false;
    }
  /** The host's turn record said the turn must not run (a redelivery of a turn that already ended): nothing was done. */
  | { status: 'refused'; turnId: string; reason: string }
  | { status: 'failed'; turnId: string; error: CategorizedError; cause: unknown };

export interface AgentTurnRunner {
  /**
   * Runs one turn to its end. Never throws for a turn's own failure: it reports it.
   * `remainingMs` is how long the process has left, when the host knows.
   */
  run(payload: AgentTurnPayload, host?: { remainingMs?: () => number }): Promise<TurnOutcome>;
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
  if (p.channel !== undefined && !(APPROVAL_CHANNELS as readonly unknown[]).includes(p.channel)) {
    return `channel must be one of ${APPROVAL_CHANNELS.join(', ')}`;
  }
  if (p.supersedes !== undefined && !(Array.isArray(p.supersedes) && p.supersedes.every((id) => typeof id === 'string' && id))) {
    return 'supersedes must be a list of turn ids';
  }
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

/**
 * The system prompt the host's configuration gives a turn: its persona through
 * the SDK's prompt framework, or its own builder. One reading for the runner
 * and for anything that must know what the model is told (an eval's
 * recording, ADR-0260 §3.5).
 */
export function hostSystemPrompt(
  config: Pick<AgentRuntimeConfig<unknown>, 'persona' | 'systemPrompt'>,
  promptContext: { userId: string; accountId: string; context?: Record<string, unknown> | null },
): string {
  return config.systemPrompt ? config.systemPrompt(promptContext) : buildAgentSystemPrompt(config.persona!, promptContext);
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

  const emit = config.realtime.emit ?? createHttpEmitAdapter({ url: config.realtime.url, apiKey: config.realtime.apiKey });
  // UI actions reach the client through the same realtime server, and its
  // answers come back through it (ADR-0209).
  const uiChannel =
    config.uiActions?.channel ?? createHttpUIActionChannel({ url: config.realtime.url, apiKey: config.realtime.apiKey });

  // Approvals are kept by the same realtime server (ADR-0228 §2.4).
  const approvals =
    config.approvals?.store ?? createHttpApprovalStoreClient({ url: config.realtime.url, apiKey: config.realtime.apiKey });

  // A stop is kept by the same realtime server (ADR-0252 §2.1).
  /** Said once for the life of the process, not once a turn. */
  let stopsUnsupported = false;
  const stops =
    config.stops?.client ??
    createHttpTurnStopClient({
      url: config.realtime.url,
      apiKey: config.realtime.apiKey,
      onError: (error, attempt) => logger.warn('[agent-sdk] Could not ask whether the turn was stopped; asking again', { attempt, error: messageOf(error) }),
      onUnsupported: () => {
        if (stopsUnsupported) return;
        stopsUnsupported = true;
        logger.warn('[agent-sdk] The realtime server keeps no turn stops (it answered 404): turns cannot be stopped until it is updated');
      },
    });

  const resolveTools = async (ctx: { userId: string; accountId: string; turnId: string }) =>
    createToolRegistry(typeof config.tools === 'function' ? await config.tools(ctx) : config.tools);

  logger.info('[agent-sdk] Runtime ready', { model, maxRounds, maxTokens, turnDeadlineMs });

  return {
    model,
    logger,
    async run(payload, host = {}) {
      const { turnId, conversationId, userId, accountId, socketRoom, content, context, userToken, approval, channel } = payload;
      const supersedes = Array.isArray(payload.supersedes) ? payload.supersedes.filter((id) => typeof id === 'string' && id) : [];
      // The message's files, by reference: anything that is not one is left out.
      // Each file once.
      const attachments = Array.isArray(payload.attachments)
        ? [
            ...new Map(
              payload.attachments
                .filter((ref) => !!ref && typeof ref === 'object' && isAttachmentId(ref.id) && typeof ref.name === 'string')
                .map((ref) => [ref.id, ref] as const),
            ).values(),
          ]
        : [];
      logger.info('[agent-sdk] Processing turn', { turnId, conversationId, userId, ...(supersedes.length ? { supersedes } : {}) });

      let db: TDb;
      try {
        db = await config.getDb();
      } catch (error) {
        // No handle, so nothing can be recorded; the client is still told.
        return fail(payload, error);
      }

      if (config.recordTurnStart) {
        try {
          const claim = await config.recordTurnStart({ turnId, conversationId, userId, accountId, model, db });
          if (claim && claim.run === false) {
            // The host's record says this turn already ended or was given up on: a queue's
            // redelivery. It does nothing, and says nothing to a client that has moved on.
            logger.warn('[agent-sdk] Turn refused by its record; nothing was run', { turnId, reason: claim.reason });
            return { status: 'refused', turnId, reason: claim.reason };
          }
        } catch (err) {
          logger.warn('[agent-sdk] recordTurnStart failed', { error: messageOf(err) });
        }
      }

      // Open before history is read: a stop asked for while the turn waited in the
      // queue, or waits now for the turns it supersedes, is the first thing it hears.
      // A person on the staff taking the conversation over stops it too (ADR-0260 §2.3).
      const stopWatch = watchTurnStop(stops, turnId, userId, conversationId);
      const waiting = new AbortController();
      stopWatch.onStop(() => waiting.abort());

      try {
        let history: Awaited<ReturnType<typeof config.getHistory>>;
        try {
          history = await config.getHistory(conversationId, db, { turnId, supersedes, signal: waiting.signal });
        } catch (err) {
          // Stopped while it waited: it reads nothing, and stores only that it was stopped.
          if (!stopWatch.current()) throw err;
          history = [];
        }

        // What the client's UI sent for the worker is not the host's prompt
        // text: its snapshot becomes the turn's UI tools, and its knowledge is
        // rendered after the host's prompt (orchestrator), and how the message
        // was entered is said on the message (prompt/spoken-input.ts).
        const promptContext = { userId, accountId, context: withoutClientUI(context) };
        const systemPrompt = hostSystemPrompt(config as AgentRuntimeConfig<unknown>, promptContext);

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
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(channel ? { channel } : {}),
          stopWatch,
          ...(host.remainingMs ? { remainingMs: host.remainingMs } : {}),
        };

        const tools = await resolveTools({ userId, accountId, turnId });
        // The turn's messages are stored before the client is told it is complete
        // (`beforeTurnComplete`), so the person's next message, however soon, reads them.
        let persisted = false;
        /** Whether the host's store took the messages: a claimed expiry is confirmed only then. */
        let stored = false;
        /** Whether the host's store failed (threw), as opposed to finding the turn given up on. */
        let storeFailed = false;
        const persist = async (turn: { newMessages: TurnMessage[]; usage: AgentTurnResult['usage']; stopped?: TurnStoppedMarker }) => {
          persisted = true;
          try {
            const answer = await config.persistMessages({
              turnId,
              conversationId,
              messages: turn.newMessages,
              usage: turn.usage,
              ...(turn.stopped ? { stopped: turn.stopped } : {}),
              db,
            });
            // The host found the turn given up on by a newer one, and stored nothing.
            if (answer && answer.stored === false) {
              logger.warn('[agent-sdk] The turn was given up on before it stored; nothing was stored', { turnId });
              return;
            }
            stored = true;
          } catch (err) {
            storeFailed = true;
            logger.error('[agent-sdk] persistMessages failed', { turnId, error: messageOf(err) });
          }
        };
        const result = await runAgentTurn(
          {
            tools,
            emit,
            beforeTurnComplete: persist,
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
            stopGraceMs: config.stops?.graceMs,
            ui: {
              channel: uiChannel,
              resultTimeoutMs: config.uiActions?.resultTimeoutMs,
              jobWaitMs: config.uiActions?.jobWaitMs,
              maxObservationChars: config.uiActions?.maxObservationChars,
              maxIndexChars: config.uiActions?.maxIndexChars,
            },
            ...(config.attachments ? { attachments: config.attachments } : {}),
          },
          turnInput,
        );

        logger.info(result.stopped ? '[agent-sdk] Turn stopped' : '[agent-sdk] Turn completed', {
          turnId,
          ...(result.stopped ? { stopReason: result.stopped.reason } : {}),
          rounds: result.rounds,
          maxRoundsReached: result.maxRoundsReached,
          usage: result.usage,
        });

        // A turn that ran out of time and could not store what it had is not a stopped turn:
        // nothing of it was kept. It is recorded as having run out of time (ADR-0252 §6.4).
        if (result.stopped?.reason === 'deadline' && (result.stored === false || storeFailed)) {
          const categorized: CategorizedError = {
            code: TURN_DEADLINE_EXCEEDED,
            message: 'The turn ran out of time, and what it had done could not be stored.',
            recoverable: false,
          };
          logger.error('[agent-sdk] Turn ran out of time and its store failed', { turnId, rounds: result.rounds });
          if (config.recordTurnFailure) {
            try {
              await config.recordTurnFailure({ turnId, conversationId, error: categorized, db });
            } catch (err) {
              logger.warn('[agent-sdk] recordTurnFailure failed', { error: messageOf(err) });
            }
          }
          return { status: 'stopped', turnId, rounds: result.rounds, stopReason: 'deadline', stored: false };
        }

        if (config.recordTurnComplete) {
          try {
            await config.recordTurnComplete({
              turnId,
              conversationId,
              rounds: result.rounds,
              usage: result.usage,
              ...(result.stopped ? { stopReason: result.stopped.reason } : {}),
              ...(result.attachments ? { attachments: result.attachments } : {}),
              db,
            });
          } catch (err) {
            logger.warn('[agent-sdk] recordTurnComplete failed', { error: messageOf(err) });
          }
        }

        // A turn that ended without announcing itself complete still has its messages stored.
        if (!persisted) await persist(result);
        // Expired approvals this turn claimed are in the conversation now: the claims no longer
        // lapse. Not stored (or not confirmed), a claim lapses and a later turn stores it again.
        if (stored && approvals.confirmExpirySettled) {
          for (const approvalId of result.settledApprovals ?? []) {
            try {
              await approvals.confirmExpirySettled(approvalId, { userId, conversationId });
            } catch (err) {
              logger.warn('[agent-sdk] Could not confirm an expired approval as stored', { turnId, approvalId, error: messageOf(err) });
            }
          }
        }
        return result.stopped
          ? { status: 'stopped', turnId, rounds: result.rounds, stopReason: result.stopped.reason }
          : { status: 'completed', turnId, rounds: result.rounds };
      } catch (error) {
        return fail(payload, error, async (categorized) => {
          if (!config.recordTurnFailure) return;
          try {
            await config.recordTurnFailure({ turnId, conversationId, error: categorized, db });
          } catch (err) {
            logger.warn('[agent-sdk] recordTurnFailure failed', { error: messageOf(err) });
          }
        });
      } finally {
        stopWatch.close();
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

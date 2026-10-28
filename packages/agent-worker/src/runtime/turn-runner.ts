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
import { createHttpTurnStopClient, watchTurnStop, withLocalStop } from '../stop/turn-stop.js';
import { teeEmitAdapter, type TurnEventObserver } from '../emit/tee.js';
import { filterEmitAdapter } from '../emit/filter.js';
import { turnInfoOf, type AgentTurnChannel, type AgentTurnInfo } from './turn-info.js';
import type { RealtimeEmitAdapter } from '../emit/types.js';
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
 * not store what it had produced: a host records it as
 * `deadline_exceeded`, not as stopped.
 */
export const TURN_DEADLINE_EXCEEDED = 'TURN_DEADLINE_EXCEEDED';

export type TurnOutcome =
  | { status: 'completed'; turnId: string; rounds: number }
  /** The turn was stopped: what it had produced is stored, and the client was told. */
  | {
      status: 'stopped';
      turnId: string;
      rounds: number;
      stopReason: TurnStoppedReason;
      /** `false` when what the turn had produced could not be stored: a deadline stop is then recorded as `TURN_DEADLINE_EXCEEDED`. */
      stored?: false;
    }
  /**
   * The turn did not run, and nothing was done: the host's turn record said it
   * must not (`record`: a redelivery of a turn that already ended), or the
   * host's `beforeTurn` refused it (`beforeTurn`).
   */
  | { status: 'refused'; turnId: string; reason: string; refusedBy: 'record' | 'beforeTurn' }
  | { status: 'failed'; turnId: string; error: CategorizedError; cause: unknown };

/** What the host adapter running a turn tells the runner, beyond the turn itself. */
export interface TurnHost {
  /** How long the process has left, when the host knows. */
  remainingMs?: () => number;
  /**
   * Called with every event the turn emits to its room, synchronously and
   * before it is sent there: the host sees the turn's events as its room does.
   * What it throws is logged, and the turn goes on.
   */
  observe?: TurnEventObserver;
  /**
   * Aborting it stops the turn on the same path as a stop request: what the
   * turn had produced is stored, then announced. The stop's reason is the
   * abort's reason when that is `user_stop` or `superseded`, else `superseded`.
   * A stop request the realtime server holds is still heard.
   */
  stopSignal?: AbortSignal;
  /**
   * How the turn reached the runtime, as the host's hooks are told
   * (`beforeTurn`, `filterEvent`, the turn policy, the approval hooks). The
   * adapters set their own (`lambda`, `container`, `live-call`); a host that
   * calls `run` itself may name its own (`sms`, `chat`). Default `direct`.
   */
  channel?: AgentTurnChannel;
}

export interface AgentTurnRunner {
  /**
   * Runs one turn to its end. Never throws for a turn's own failure: it reports it.
   */
  run(payload: AgentTurnPayload, host?: TurnHost): Promise<TurnOutcome>;
  /**
   * Answers the turn with `text` instead of the model: a reply the host has
   * already (a greeting from a template). It is a turn like any other to the
   * host and the room: recorded, its text streamed to the room, stored as the
   * turn's one assistant message, then announced complete. A conversation a
   * person on the staff holds is not answered: the outcome is `stopped`,
   * `taken_over`, and nothing but that is stored. Never throws for the turn's
   * own failure.
   */
  reply(payload: AgentTurnPayload, text: string, host?: Pick<TurnHost, 'observe' | 'channel'>): Promise<TurnOutcome>;
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
/** What a turn is followed by (its record, its room, every client): `beforeTurn` cannot change them. */
const IDENTITY_FIELDS = ['turnId', 'conversationId', 'userId', 'accountId', 'socketRoom'] as const;

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
  // Left undefined when not set, so the orchestrator's default applies (DEFAULT_MAX_TOKENS).
  const maxTokens = config.maxTokens;
  // Left undefined when not set, so the orchestrator's default applies; null (send none) is passed through.
  const temperature = config.temperature;
  const toolTimeoutMs = config.toolTimeoutMs ?? 30_000;
  const turnDeadlineMs = config.turnDeadlineMs ?? 840_000;
  const retries = config.retries ?? 3;

  const roomEmit = config.realtime.emit ?? createHttpEmitAdapter({ url: config.realtime.url, apiKey: config.realtime.apiKey });
  /**
   * The turn's emits: through the host's filter first when it has one, then to
   * the host observing the turn, then to the room. What the filter drops
   * reaches neither.
   */
  const turnEmit = (turn: AgentTurnInfo, observe: TurnEventObserver | undefined): RealtimeEmitAdapter => {
    const observed = observe
      ? teeEmitAdapter(roomEmit, observe, (error, event) =>
          logger.warn('[agent-sdk] The host could not observe a turn event; it was still sent to the room', { turnId: turn.id, event, error: messageOf(error) }),
        )
      : roomEmit;
    const filter = config.filterEvent;
    if (!filter) return observed;
    return filterEmitAdapter(
      observed,
      (event, data) => filter(event, data, turn),
      (error, event) => logger.error('[agent-sdk] The host’s event filter failed; the event was not sent', { turnId: turn.id, event, error: messageOf(error) }),
    );
  };

  /**
   * The turn as the host's `beforeTurn` admits it: the payload to run, or the
   * outcome of a turn it refused or failed on. The turn's identity is not the
   * hook's to change: its record, its room and every client follow it by those.
   */
  async function admit(
    payload: AgentTurnPayload,
    host: Pick<TurnHost, 'observe' | 'channel'>,
  ): Promise<{ payload: AgentTurnPayload; turn: AgentTurnInfo } | { outcome: TurnOutcome }> {
    const asSent = turnInfoOf(payload, host.channel, payload.channel);
    if (!config.beforeTurn) return { payload, turn: asSent };
    let admitted: AgentTurnPayload | null;
    try {
      admitted = await config.beforeTurn(payload, asSent);
    } catch (error) {
      return { outcome: await fail(payload, turnEmit(asSent, host.observe), error) };
    }
    if (admitted === null) {
      logger.info('[agent-sdk] Turn refused by the host’s beforeTurn; nothing was run', { turnId: payload.turnId, channel: asSent.channel });
      return { outcome: { status: 'refused', turnId: payload.turnId, reason: 'refused by beforeTurn', refusedBy: 'beforeTurn' } };
    }
    const changed = IDENTITY_FIELDS.filter((f) => admitted?.[f] !== payload[f]);
    const invalid = payloadRefusal(admitted) ?? (changed.length > 0 ? `it changed the turn's ${changed.join(', ')}` : null);
    if (invalid) {
      return { outcome: await fail(payload, turnEmit(asSent, host.observe), new Error(`[agent-sdk] beforeTurn returned a turn that cannot run: ${invalid}`)) };
    }
    return { payload: admitted, turn: turnInfoOf(admitted, host.channel, admitted.channel) };
  }
  // UI actions reach the client through the same realtime server, and its
  // answers come back through it.
  const uiChannel =
    config.uiActions?.channel ?? createHttpUIActionChannel({ url: config.realtime.url, apiKey: config.realtime.apiKey });

  // Approvals are kept by the same realtime server.
  const approvals =
    config.approvals?.store ?? createHttpApprovalStoreClient({ url: config.realtime.url, apiKey: config.realtime.apiKey });

  // A stop is kept by the same realtime server.
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
    async run(sent, host = {}) {
      const admission = await admit(sent, host);
      if ('outcome' in admission) return admission.outcome;
      const { payload, turn } = admission;
      const { turnId, conversationId, userId, accountId, socketRoom, content, context, userToken, approval } = payload;
      const emit = turnEmit(turn, host.observe);
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
        return fail(payload, emit, error);
      }

      const refused = await claimTurn(payload, db);
      if (refused) return refused;

      // Open before history is read: a stop asked for while the turn waited in the
      // queue, or waits now for the turns it supersedes, is the first thing it hears.
      // A person on the staff taking the conversation over stops it too.
      const stopWatch = watchTurnStop(host.stopSignal ? withLocalStop(stops, host.stopSignal) : stops, turnId, userId, conversationId);
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
          history: Array.isArray(history) ? history : history.messages,
          ...(!Array.isArray(history) && history.stepContext ? { stepContext: history.stepContext } : {}),
          userToken,
          ...(approval ? { approval } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(payload.channel ? { approvalChannel: payload.channel } : {}),
          stopWatch,
          ...(host.remainingMs ? { remainingMs: host.remainingMs } : {}),
          channel: turn.channel,
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
            ...(config.modelProviderOptions ? { modelProviderOptions: config.modelProviderOptions } : {}),
            maxToolRounds: maxRounds,
            maxTokens,
            temperature,
            ...(config.forcedToolChoice === false ? { forcedToolChoice: false } : {}),
            toolTimeoutMs,
            turnDeadlineMs,
            ...(config.handBackReserveMs !== undefined ? { handBackReserveMs: config.handBackReserveMs } : {}),
            retries,
            turnPolicy: config.turnPolicy,
            toolPolicy: config.toolPolicy,
            approvals,
            ...(config.approvals?.preview || config.approvals?.validateBeforeApproval
              ? { approvalHooks: { preview: config.approvals.preview, validateBeforeApproval: config.approvals.validateBeforeApproval } }
              : {}),
            stopGraceMs: config.stops?.graceMs,
            ui: {
              channel: uiChannel,
              resultTimeoutMs: config.uiActions?.resultTimeoutMs,
              jobWaitMs: config.uiActions?.jobWaitMs,
              maxObservationChars: config.uiActions?.maxObservationChars,
              maxAnswerDataChars: config.uiActions?.maxAnswerDataChars,
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
        // nothing of it was kept. It is recorded as having run out of time.
        if (result.stopped?.reason === 'deadline' && (result.stored === false || storeFailed)) {
          const categorized: CategorizedError = {
            code: TURN_DEADLINE_EXCEEDED,
            message: 'The turn ran out of time, and what it had done could not be stored.',
            recoverable: false,
          };
          logger.error('[agent-sdk] Turn ran out of time and its store failed', { turnId, rounds: result.rounds });
          await recordFailure(payload, categorized, db);
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
        return fail(payload, emit, error, (categorized) => recordFailure(payload, categorized, db));
      } finally {
        stopWatch.close();
      }
    },

    async reply(sent, text, host = {}) {
      const admission = await admit(sent, host);
      if ('outcome' in admission) return admission.outcome;
      const { payload, turn } = admission;
      const { turnId, conversationId, userId, socketRoom } = payload;
      const emit = turnEmit(turn, host.observe);
      logger.info('[agent-sdk] Answering turn with the host’s text', { turnId, conversationId, userId });

      let db: TDb;
      try {
        db = await config.getDb();
      } catch (error) {
        return fail(payload, emit, error);
      }
      const refused = await claimTurn(payload, db);
      if (refused) return refused;

      try {
        const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
        // A conversation a person on the staff holds is theirs to answer: the host's text is not said, and nothing is
        // stored but that the turn was taken over, as for a model's turn that arrives while it is held.
        const watch = watchTurnStop(stops, turnId, userId, conversationId);
        await watch.checked();
        const held = watch.current();
        watch.close();
        if (held?.reason === 'taken_over') {
          const stopped: TurnStoppedMarker = { reason: 'taken_over', at: held.at };
          try {
            await config.persistMessages({ turnId, conversationId, messages: [], usage, stopped, db });
          } catch (err) {
            logger.error('[agent-sdk] persistMessages failed', { turnId, error: messageOf(err) });
          }
          await emit.emit(socketRoom, AGENT_SOCKET_EVENTS.TURN_COMPLETE, { turnId, rounds: 0, usage, stopReason: 'taken_over', timestamp: Date.now() });
          logger.info('[agent-sdk] Turn not answered: a person on the staff holds the conversation', { turnId, conversationId });
          return { status: 'stopped', turnId, rounds: 0, stopReason: 'taken_over' };
        }
        // One round, the turn's last word, as a model's reply that called no tool streams.
        await emit.emit(socketRoom, AGENT_SOCKET_EVENTS.TOKEN, { turnId, text, step: 0, timestamp: Date.now() });
        await emit.emit(socketRoom, AGENT_SOCKET_EVENTS.ROUND_END, { turnId, step: 0, calledTools: false, final: true, timestamp: Date.now() });
        // Stored before the client is told it is complete, as a model's turn is.
        try {
          await config.persistMessages({ turnId, conversationId, messages: [{ role: 'assistant', content: text }], usage, db });
        } catch (err) {
          logger.error('[agent-sdk] persistMessages failed', { turnId, error: messageOf(err) });
        }
        await emit.emit(socketRoom, AGENT_SOCKET_EVENTS.TURN_COMPLETE, {
          turnId,
          rounds: 0,
          usage,
          endReason: 'complete',
          timestamp: Date.now(),
        });
        if (config.recordTurnComplete) {
          try {
            await config.recordTurnComplete({ turnId, conversationId, rounds: 0, usage, db });
          } catch (err) {
            logger.warn('[agent-sdk] recordTurnComplete failed', { error: messageOf(err) });
          }
        }
        logger.info('[agent-sdk] Turn completed', { turnId, rounds: 0, scripted: true });
        return { status: 'completed', turnId, rounds: 0 };
      } catch (error) {
        return fail(payload, emit, error, (categorized) => recordFailure(payload, categorized, db));
      }
    },
  };

  /**
   * The host's claim on the turn (`recordTurnStart`): the outcome of a turn its
   * record refuses, or null to run it.
   */
  async function claimTurn(payload: AgentTurnPayload, db: TDb): Promise<TurnOutcome | null> {
    if (!config.recordTurnStart) return null;
    const { turnId, conversationId, userId, accountId } = payload;
    try {
      const claim = await config.recordTurnStart({ turnId, conversationId, userId, accountId, model, db });
      if (claim && claim.run === false) {
        // The host's record says this turn already ended or was given up on: a queue's
        // redelivery. It does nothing, and says nothing to a client that has moved on.
        logger.warn('[agent-sdk] Turn refused by its record; nothing was run', { turnId, reason: claim.reason });
        return { status: 'refused', turnId, reason: claim.reason, refusedBy: 'record' };
      }
    } catch (err) {
      logger.warn('[agent-sdk] recordTurnStart failed', { error: messageOf(err) });
    }
    return null;
  }

  async function recordFailure(payload: AgentTurnPayload, categorized: CategorizedError, db: TDb): Promise<void> {
    if (!config.recordTurnFailure) return;
    try {
      await config.recordTurnFailure({ turnId: payload.turnId, conversationId: payload.conversationId, error: categorized, db });
    } catch (err) {
      logger.warn('[agent-sdk] recordTurnFailure failed', { error: messageOf(err) });
    }
  }

  /** Reports a failed turn to the client first, so the UI stops streaming, then to the host. */
  async function fail(
    payload: AgentTurnPayload,
    emit: RealtimeEmitAdapter,
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

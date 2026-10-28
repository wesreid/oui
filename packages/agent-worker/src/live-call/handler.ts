/**
 * The live-call turn handler: one route a product mounts so that the
 * service running a live call reaches the product's own agent.
 *
 * Each request is one turn (protocol.ts). The handler checks the bearer
 * credential, asks the host which conversation, user and realtime room the
 * call's `clientRef` is, and runs the turn on the same runtime as every other
 * turn (runtime/turn-runner.ts). So the turn still streams to the
 * conversation's room, and every page joined to it receives the reply and
 * every UI action, as for a typed message. The handler sees the turn's events
 * as the room does (emit/tee.ts) and writes the reply's text, an approval's
 * readback and the turn's end to the response as server-sent events: one
 * stream of events, two destinations, no second model call.
 *
 * A closed connection is the call service's barge-in: the person spoke over
 * the reply. The turn is stopped as a superseding message stops it, and the
 * next request names it in `supersedes`.
 *
 * A conversation a person on the staff has taken over is theirs to answer: a
 * turn that arrives while it is held runs no model call, says nothing and
 * ends `done { stopReason: 'taken_over' }`; one running when it is taken over
 * stops there, with the same end. The call service quiets the character on it
 * until the conversation is handed back.
 *
 * The person's page can send its UI into the call: the call service then
 * carries its latest on every turn (`client.ui`), and the handler puts it on
 * the turn's context under the names a typed turn from that page uses (`oui`,
 * `uiKnowledge`, `currentPath`). The turn's UI tools are then the page's, as on
 * a typed turn, and its UI actions reach that page through the room. What the
 * host's `context` sets itself is kept.
 *
 * A call is a voice: an approval is read back (the host's `spokenReadback`
 * when it wrote one) and the person's next words confirm it, as on any voice
 * channel. A UI action's too: its card is also on the person's
 * screen, and when the host decides a spoken yes, the realtime server pushes
 * the page the grant it runs the action on.
 *
 * What the caller hears is the host's to choose (`speak`): every round of the
 * reply as the model writes it (`all`, the default), or only the round the turn
 * ends with (`final-round`), so nothing the model wrote before a tool call is
 * spoken, save a holding line of the host's own while a tool runs.
 *
 *   POST <path>   200 text/event-stream    the turn
 *                 400 not a turn · 401 wrong credential · 404 unknown clientRef
 *                 405 not POST · 409 turn already running · 413 too large
 *                 415 not JSON · 500 the host's resolver failed · 503 at capacity or closing
 */
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AGENT_SOCKET_EVENTS,
  MESSAGE_INPUT_CONTEXT_KEY,
  REPLY_OUTPUT_CONTEXT_KEY,
  type ApprovalChannel,
  type ApprovalContinuation,
  type ApprovalRequiredEvent,
} from '@ouispec/agent-core';
import { payloadRefusal, type AgentTurnRunner, type TurnOutcome } from '../runtime/turn-runner.js';
import { CLIENT_SNAPSHOT_KEY } from '../ui/snapshot.js';
import { CLIENT_KNOWLEDGE_KEY } from '../ui/knowledge.js';
import { USER_INPUT_TOOLS } from '../orchestrator.js';
import { createTurnSlots, type TurnSlots } from '../runtime/turn-slots.js';
import type { AgentTurnPayload } from '../runtime/types.js';
import type { TurnEventObserver } from '../emit/tee.js';
import { DEFAULT_KEEP_ALIVE_MS, openLiveCallEventStream, type LiveCallEventStream } from './event-stream.js';
import { liveCallError, liveCallOpeningMessage, readLiveCallTurnRequest, type LiveCallStreamEvents, type LiveCallTurnRequest } from './protocol.js';

/** Who and where a live-call turn is, in the product: what the host resolves a call's `clientRef` to. */
export interface LiveCallTurnTarget {
  /** The product's conversation: the call is one more way to reach it. */
  conversationId: string;
  /** The user the turn acts as: the conversation's principal. */
  userId: string;
  accountId: string;
  /** The conversation's realtime room: the turn streams there, and its UI actions reach every page joined to it. */
  socketRoom: string;
  /** Passed to the turn's tools as the payload's `userToken`. */
  userToken?: string;
  /**
   * What the model reads as the person's message, in place of `request.text`
   * (or, for an `opening`, of `liveCallOpeningMessage(request)`): the words
   * with a card number or an account number redacted. Store the same copy.
   * The runtime's `beforeTurn`, which every channel passes through, can do
   * this too.
   */
  content?: string;
  /**
   * The turn's context, as the product would send it for a typed message on
   * the conversation's page: its OUI snapshot, its knowledge, its page
   * context. `input` and `output` are the request's, and are set by the handler.
   * When the call carries the person's page (`request.client.ui`), its `oui`,
   * `uiKnowledge` and `currentPath` are added under those names, except where
   * this context already sets them.
   */
  context?: Record<string, unknown> | null;
  /**
   * The decision on an approval the agent read back, when the host takes this
   * message as the answer to it: the host classified the person's words, and
   * decided as the user (`ApprovalStoreClient.decide` with the target's
   * `channel`). With `approve`, its `token`: the turn redeems it and runs
   * exactly the stored call.
   */
  approval?: ApprovalContinuation;
  /**
   * The conversation channel the call is, for approvals: `voice` (the
   * default: a call in the product's page) or `phone` (a call through a
   * carrier). Either way a call that needs approval is read back and the
   * person's next words confirm it; decide on it with this channel.
   */
  channel?: LiveCallApprovalChannel;
}

/** The approval channels a live call can be: it is always spoken. */
export const LIVE_CALL_APPROVAL_CHANNELS = ['voice', 'phone'] as const satisfies readonly ApprovalChannel[];

export type LiveCallApprovalChannel = (typeof LIVE_CALL_APPROVAL_CHANNELS)[number];

/** What the host's callbacks are told beside the request. */
export interface LiveCallTurnCallContext {
  /** Aborts when the call service closes the connection: the person spoke again. */
  signal: AbortSignal;
}

/** The live-call route's own settings, wherever it is mounted. */
export interface LiveCallTurnOptions {
  /**
   * The credential the call service sends as `Authorization: Bearer …`, from
   * the product's secret store. Several are accepted while one is rotated.
   * Required.
   */
  credential: string | readonly string[];
  /**
   * Resolves the call's `clientRef` to the turn's conversation, user and room,
   * or null when the product has no such conversation (answered `404`).
   * Required.
   *
   * This is where the product does what its API does for a message from its
   * own chat: store the person's message (`request.text`, entered as
   * `request.input`, or the redacted copy you return as `content`) in the
   * conversation, or for an `opening` turn `liveCallOpeningMessage(request)`;
   * claim the turn record; and, when a readback
   * is waiting, decide on it from what the person said. What it throws is
   * answered `500`, and nothing runs.
   */
  resolveTurn: (
    request: LiveCallTurnRequest,
    call: LiveCallTurnCallContext,
  ) => LiveCallTurnTarget | null | Promise<LiveCallTurnTarget | null>;
  /**
   * A greeting for an `opening` turn from the product's template, instead of
   * the model's: the turn's reply is this text, streamed and stored as the
   * model's would be. Null, undefined or blank lets the model greet. What it
   * throws fails the turn (`error` event); the model does not greet instead.
   */
  opening?: (
    request: LiveCallTurnRequest,
    target: LiveCallTurnTarget,
    call: LiveCallTurnCallContext,
  ) => string | null | undefined | Promise<string | null | undefined>;
  /** How long the response may be silent before a `: keep-alive` comment. Default 5 s, well inside the call service's 15 s. */
  keepAliveMs?: number;
  /**
   * What of the reply is spoken. `all` (the default): every round, as the
   * model writes it, the text before a tool call included. `final-round`:
   * only the round the turn ends with. A round's text is held until the round
   * ends (`agent:round_end`) and sent only when no round follows it, so
   * nothing the model wrote before a tool call is spoken; the reply then
   * starts when its last round is written, not as its first words are.
   */
  speak?: LiveCallSpeech;
  /**
   * With `speak: 'final-round'`: a line of your own spoken once, as the
   * turn's first tool starts, so the caller does not wait in silence ("One
   * moment while I check."). A function is given the request (its
   * `input.language`) and the target, once per turn; null, undefined or blank
   * says nothing. What it throws fails the turn. Not used with `all`, where the
   * model's own words before a tool call are spoken.
   */
  holdingLine?:
    | string
    | ((request: LiveCallTurnRequest, target: LiveCallTurnTarget) => string | null | undefined | Promise<string | null | undefined>);
}

/** What of a live-call turn's reply is spoken (`LiveCallTurnOptions.speak`). */
export const LIVE_CALL_SPEECH = ['all', 'final-round'] as const;

export type LiveCallSpeech = (typeof LIVE_CALL_SPEECH)[number];

/** `createLiveCallTurnHandler`'s configuration: the route's settings and the runtime that runs its turns. */
export interface LiveCallTurnHandlerConfig extends LiveCallTurnOptions {
  /** The runtime (`createAgentTurnRunner`): the same one that runs the product's other turns. Required. */
  runner: AgentTurnRunner;
  /** Turns run at once; more are answered `503`. Default 8. */
  maxConcurrentTurns?: number;
  /** Largest request body, in bytes. Default 128 KiB: a turn with the page's UI context at its 64 KiB bound fits. */
  maxBodyBytes?: number;
  /** Called with each turn's outcome, after it ends. */
  onTurnEnd?: (outcome: TurnOutcome) => void;
}

/** A Node request handler: mount it on a `POST` route of the product's own server. */
export interface LiveCallTurnHandler {
  (req: IncomingMessage, res: ServerResponse): void;
  /** Turns running now. */
  running(): number;
  /** Takes no more turns, and resolves once every running one has ended. */
  close(): Promise<void>;
}

/** What the route needs from its host: the runtime and the process's turn slots. */
interface LiveCallRouteHost {
  runner: AgentTurnRunner;
  slots: TurnSlots;
  maxBodyBytes: number;
  onTurnEnd?: (outcome: TurnOutcome) => void;
}

/** Room for the largest turn: its text, its directions, and the page's UI (`LIVE_CALL_LIMITS.clientUiBytes`). */
const DEFAULT_MAX_BODY_BYTES = 128 * 1024;

/**
 * Creates the live-call turn handler.
 *
 * @example
 * ```ts
 * const runner = createAgentTurnRunner(runtimeConfig);
 * const liveCall = createLiveCallTurnHandler({
 *   runner,
 *   credential: env.LIVE_CALL_BRAIN_CREDENTIAL,
 *   resolveTurn: async (request) => {
 *     const conversation = await db.conversation.findUnique({ where: { callRef: request.clientRef } });
 *     if (!conversation) return null;
 *     await db.message.create({ data: { conversationId: conversation.id, role: 'user', content: request.text, input: request.input } });
 *     return { conversationId: conversation.id, userId: conversation.userId, accountId: conversation.accountId, socketRoom: `conversation:${conversation.id}` };
 *   },
 * });
 * app.post('/agent/live-call/turns', liveCall);
 * process.on('SIGTERM', () => liveCall.close());
 * ```
 */
export function createLiveCallTurnHandler(config: LiveCallTurnHandlerConfig): LiveCallTurnHandler {
  if (!config?.runner || typeof config.runner.run !== 'function' || typeof config.runner.reply !== 'function') {
    throw new Error('[agent-sdk] Missing required configuration: runner (createAgentTurnRunner(config))');
  }
  const slots = createTurnSlots(config.maxConcurrentTurns ?? 8);
  const handle = liveCallRoute(config, {
    runner: config.runner,
    slots,
    maxBodyBytes: config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    onTurnEnd: config.onTurnEnd,
  });
  return Object.assign((req: IncomingMessage, res: ServerResponse) => handle(req, res), {
    running: () => slots.running(),
    close: () => slots.drain(),
  });
}

/**
 * The route, for a host that already runs turns (the container adapter): it
 * shares that host's runtime and slots.
 */
export function liveCallRoute(options: LiveCallTurnOptions, host: LiveCallRouteHost): (req: IncomingMessage, res: ServerResponse) => void {
  const credentials = (typeof options?.credential === 'string' ? [options.credential] : [...(options?.credential ?? [])]).filter(
    (c) => typeof c === 'string' && c.length > 0,
  );
  const missing = [
    credentials.length === 0 && 'credential (the bearer credential the call service sends)',
    typeof options?.resolveTurn !== 'function' && 'resolveTurn (the call’s clientRef → its conversation, user and room)',
  ].filter(Boolean);
  if (missing.length > 0) throw new Error(`[agent-sdk] Missing required configuration for the live-call route: ${missing.join('; ')}`);
  const keepAliveMs = options.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS;
  if (!(Number.isFinite(keepAliveMs) && keepAliveMs > 0)) throw new Error(`[agent-sdk] keepAliveMs must be a positive number of ms, not ${keepAliveMs}`);
  const speak = options.speak ?? 'all';
  if (!(LIVE_CALL_SPEECH as readonly string[]).includes(speak)) {
    throw new Error(`[agent-sdk] speak must be one of ${LIVE_CALL_SPEECH.join(', ')}, not ${JSON.stringify(speak)}`);
  }
  if (options.holdingLine !== undefined && speak !== 'final-round') {
    throw new Error("[agent-sdk] holdingLine is spoken only with speak: 'final-round'; with 'all' the model's own words before a tool call are spoken");
  }
  if (options.holdingLine !== undefined && typeof options.holdingLine !== 'string' && typeof options.holdingLine !== 'function') {
    throw new Error('[agent-sdk] holdingLine must be a string or a function');
  }

  const { runner, slots, maxBodyBytes } = host;
  const logger = runner.logger;
  // Compared as digests: equal length whatever was presented, so the comparison takes the same time.
  const expected = credentials.map(digest);
  const isCredential = (header: string | undefined) => {
    const presented = /^Bearer[ ]+(\S+)\s*$/i.exec(header ?? '')?.[1];
    if (!presented) return false;
    const given = digest(presented);
    // Every credential is compared, matched or not.
    return expected.map((e) => crypto.timingSafeEqual(given, e)).includes(true);
  };

  /** The hang-up of each running live-call turn, by turn id: a newer turn that supersedes one stops it here at once. */
  const hangUps = new Map<string, AbortController>();

  return (req, res) => {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      refuse(res, 405, 'METHOD_NOT_ALLOWED', 'Use POST');
      return;
    }
    if (!isCredential(req.headers.authorization)) {
      res.setHeader('www-authenticate', 'Bearer');
      refuse(res, 401, 'UNAUTHORIZED', 'Invalid or missing credential');
      return;
    }
    const type = req.headers['content-type'];
    if (type && !/^application\/json\s*(;|$)/i.test(type)) {
      refuse(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'The body must be application/json');
      return;
    }

    void readJsonBody(req, maxBodyBytes).then((body) => {
      if (res.writableEnded) return;
      if (body.status !== 'ok') {
        if (body.status === 'too_large') refuse(res, 413, 'BODY_TOO_LARGE', `The body is larger than ${maxBodyBytes} bytes`);
        else refuse(res, 400, 'INVALID_REQUEST', 'The body is not JSON');
        return;
      }
      const reading = readLiveCallTurnRequest(body.value);
      if (!reading.ok) {
        refuse(res, 400, 'INVALID_REQUEST', reading.error);
        return;
      }
      const request = reading.request;
      // The turns this one replaces stop now, if they still run here: their connections closed, or are closing.
      for (const id of request.supersedes) hangUps.get(id)?.abort('superseded');

      const refusal = slots.take(request.turnId, () => serve(request, res));
      if (refusal) refuse(res, refusal.status, refusal.status === 409 ? 'TURN_RUNNING' : 'UNAVAILABLE', refusal.error);
    });
  };

  async function serve(request: LiveCallTurnRequest, res: ServerResponse): Promise<void> {
    const { turnId } = request;
    const hangUp = new AbortController();
    // The caller closed the connection before the turn's answer ended: it stops the turn.
    const onClose = () => {
      if (!res.writableEnded) hangUp.abort('superseded');
    };
    res.once('close', onClose);
    hangUps.set(turnId, hangUp);
    const call: LiveCallTurnCallContext = { signal: hangUp.signal };

    try {
      let target: LiveCallTurnTarget | null;
      try {
        target = await options.resolveTurn(request, call);
      } catch (error) {
        logger.error('[agent-sdk] The live-call turn could not be resolved; nothing was run', {
          turnId,
          sessionId: request.sessionId,
          error: messageOf(error),
        });
        refuse(res, 500, 'RESOLVE_FAILED', 'The turn could not be resolved');
        return;
      }
      if (!target) {
        refuse(res, 404, 'UNKNOWN_CLIENT_REF', 'No conversation for this clientRef');
        return;
      }

      const payload = turnPayload(request, target);
      const invalid =
        target.content !== undefined && typeof target.content !== 'string'
          ? 'content must be a string'
          : target.channel !== undefined && !(LIVE_CALL_APPROVAL_CHANNELS as readonly unknown[]).includes(target.channel)
            ? `channel must be one of ${LIVE_CALL_APPROVAL_CHANNELS.join(', ')}`
            : payloadRefusal(payload);
      if (invalid) {
        logger.error('[agent-sdk] resolveTurn answered a turn that cannot run; nothing was run', { turnId, error: invalid });
        refuse(res, 500, 'RESOLVE_FAILED', 'The turn could not be resolved');
        return;
      }

      const stream = openLiveCallEventStream(res, keepAliveMs);
      const relay = relayTurn(turnId, stream, speak);
      logger.info('[agent-sdk] Live-call turn', {
        turnId,
        sessionId: request.sessionId,
        kind: request.kind,
        conversationId: target.conversationId,
        ...(request.supersedes.length ? { supersedes: request.supersedes } : {}),
      });

      let outcome: TurnOutcome;
      try {
        const greeting = request.kind === 'opening' && options.opening ? (await options.opening(request, target, call))?.trim() : null;
        const holding = typeof options.holdingLine === 'function' ? await options.holdingLine(request, target) : options.holdingLine;
        if (typeof holding === 'string' && holding.trim()) relay.holdWith(holding.trim());
        // A caller already gone gets no greeting: the turn stops before it starts, and stores only that.
        outcome = greeting && !hangUp.signal.aborted
          ? await runner.reply(payload, greeting, { observe: relay.observe, channel: LIVE_CALL_CHANNEL })
          : await runner.run(payload, { observe: relay.observe, stopSignal: hangUp.signal, channel: LIVE_CALL_CHANNEL });
      } catch (error) {
        // A turn's own failure is an outcome; this is the host's opening template, or the runtime around the turn.
        logger.error('[agent-sdk] The live-call turn could not run', { turnId, error: messageOf(error) });
        outcome = { status: 'failed', turnId, error: { code: 'WORKER_ERROR', message: messageOf(error), recoverable: false }, cause: error };
      }
      try {
        host.onTurnEnd?.(outcome);
      } catch (error) {
        logger.warn('[agent-sdk] onTurnEnd threw', { turnId, error: messageOf(error) });
      }

      if (outcome.status === 'failed') stream.send('error', liveCallError(outcome.error.code));
      else if (outcome.status === 'refused') stream.send('error', liveCallError(outcome.refusedBy === 'beforeTurn' ? 'TURN_DECLINED' : 'TURN_REFUSED'));
      else if (outcome.status === 'stopped' && outcome.stored === false) stream.send('error', liveCallError('TURN_DEADLINE_EXCEEDED'));
      else stream.send('done', relay.ended() ?? (outcome.status === 'stopped' ? { stopReason: outcome.stopReason } : {}));
      stream.end();
    } finally {
      res.off('close', onClose);
      if (hangUps.get(turnId) === hangUp) hangUps.delete(turnId);
    }
  }
}

/** The turn as the runtime takes it: the host's target, and what the request says. */
function turnPayload(request: LiveCallTurnRequest, target: LiveCallTurnTarget): AgentTurnPayload {
  const context: Record<string, unknown> = { ...(target.context ?? {}) };
  // How the message was entered and how the reply reaches the person are the request's to say.
  delete context[MESSAGE_INPUT_CONTEXT_KEY];
  delete context[REPLY_OUTPUT_CONTEXT_KEY];
  if (request.input) context[MESSAGE_INPUT_CONTEXT_KEY] = request.input;
  if (request.output) context[REPLY_OUTPUT_CONTEXT_KEY] = request.output;
  // The person's page, as its typed turns carry it: the host's own context wins.
  const ui = request.client?.ui;
  for (const [key, value] of [
    [CLIENT_SNAPSHOT_KEY, ui?.oui],
    [CLIENT_KNOWLEDGE_KEY, ui?.uiKnowledge],
    [PAGE_PATH_CONTEXT_KEY, ui?.currentPath],
  ] as const) {
    if (value !== undefined && !(key in context)) context[key] = value;
  }
  return {
    turnId: request.turnId,
    conversationId: target.conversationId,
    userId: target.userId,
    accountId: target.accountId,
    socketRoom: target.socketRoom,
    content: target.content ?? (request.kind === 'opening' ? liveCallOpeningMessage(request) : request.text),
    context,
    // A call is spoken: an approval is read back, and the person's next words confirm it.
    channel: target.channel ?? 'voice',
    ...(target.userToken ? { userToken: target.userToken } : {}),
    ...(target.approval ? { approval: target.approval } : {}),
    ...(request.supersedes.length > 0 ? { supersedes: request.supersedes } : {}),
  };
}

/** Where the person is in the page, on a typed turn's context (`AgentMessageContext.currentPath`). */
const PAGE_PATH_CONTEXT_KEY = 'currentPath';

/** The channel the live-call handler's turns run on, as the host's hooks are told. */
export const LIVE_CALL_CHANNEL = 'live-call';

/**
 * The turn's events, as the response carries them: its text as `text`, an
 * approval's readback as `readback`, and how it ended, for `done`.
 *
 * With `speak: 'all'` each piece of text is sent as it comes. With
 * `final-round` a round's text is held until the round ends, and sent only
 * when the round is final; the host's holding line, if any, is sent once as
 * the turn's first tool starts, in place of what the model said before it.
 *
 * The readback is sent when the turn has ended, after every piece of its
 * text: it is spoken after what the model said before the call. It is the
 * preview's `spokenReadback` when the host wrote one, else its `readback`. It
 * is sent only when the turn read it back (its readback pieces, which are not
 * sent as `text`). A turn that was stopped instead withdrew its approval, so
 * its readback is never sent.
 */
function relayTurn(
  turnId: string,
  stream: LiveCallEventStream,
  speak: LiveCallSpeech,
): { observe: TurnEventObserver; holdWith(line: string): void; ended(): { stopReason?: string } | null } {
  let ended: { stopReason?: string } | null = null;
  let readback: LiveCallStreamEvents['readback'] | null = null;
  /** The holding line, until it is said: once a turn. */
  let holdingLine: string | null = null;
  /** Whether any text has been sent: what follows is set off from it. */
  let sent = false;
  /** With `final-round`: the text of the round being written, until it ends. */
  let held: { step: number; text: string } | null = null;
  /** Whether the turn read its approval back: only then is the person's next utterance the answer to it. */
  let readBack = false;
  const send = (text: string) => {
    stream.send('text', { text });
    sent = true;
  };
  const ofTurn = (data: unknown): data is Record<string, unknown> =>
    !!data && typeof data === 'object' && (data as { turnId?: unknown }).turnId === turnId;
  return {
    holdWith(line) {
      holdingLine = line;
    },
    observe(event, data) {
      if (!ofTurn(data)) return;
      switch (event) {
        case AGENT_SOCKET_EVENTS.TOKEN: {
          const text = data.text;
          if (typeof text !== 'string' || !text) return;
          // The readback goes as its own event, after the turn: never said twice.
          if (data.readback === true) {
            readBack = true;
            return;
          }
          if (speak === 'all') {
            send(text);
            return;
          }
          const step = typeof data.step === 'number' ? data.step : (held?.step ?? 0);
          // A round that never announced its end is not the one being written now: it is not spoken.
          if (held && held.step !== step) held = null;
          held = { step, text: (held?.text ?? '') + text };
          return;
        }
        case AGENT_SOCKET_EVENTS.ROUND_END: {
          if (speak === 'all') return;
          const round = held && held.step === data.step ? held.text : '';
          held = null;
          if (data.final !== true) return;
          // The round the turn ends with; what was said before it (a holding line) is set off from it.
          const text = sent ? `\n\n${round.trimStart()}` : round.trimStart();
          if (round.trim()) send(text);
          return;
        }
        case AGENT_SOCKET_EVENTS.TOOL_CALL_STARTED: {
          // A tool that asks the person something (a choice) is the turn's end, not a wait.
          const name = data.name;
          if (holdingLine && !(typeof name === 'string' && (USER_INPUT_TOOLS as readonly string[]).includes(name))) {
            send(sent ? `\n\n${holdingLine}` : holdingLine);
            holdingLine = null;
          }
          return;
        }
        case AGENT_SOCKET_EVENTS.APPROVAL_REQUIRED: {
          const approval = data as unknown as ApprovalRequiredEvent;
          readback = {
            approvalId: approval.approvalId,
            text: approval.preview.spokenReadback ?? approval.preview.readback,
            expiresAt: new Date(approval.expiresAt).toISOString(),
          };
          return;
        }
        case AGENT_SOCKET_EVENTS.TURN_COMPLETE: {
          if (readback && readBack && data.stopReason === undefined) stream.send('readback', readback);
          const reason = data.stopReason ?? data.endReason;
          ended = typeof reason === 'string' ? { stopReason: reason } : {};
          return;
        }
      }
    },
    ended: () => ended,
  };
}

type BodyReading = { status: 'ok'; value: unknown } | { status: 'too_large' } | { status: 'not_json' };

/**
 * The request's JSON body. A body a framework has already parsed (Express's
 * `json()`) is taken as it is.
 */
function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<BodyReading> {
  const parsed = (req as IncomingMessage & { body?: unknown }).body;
  if (req.readableEnded && parsed !== undefined) {
    if (typeof parsed === 'string' || Buffer.isBuffer(parsed)) return Promise.resolve(parseJson(String(parsed), maxBytes));
    return Promise.resolve({ status: 'ok', value: parsed });
  }
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (reading: BodyReading) => {
      if (done) return;
      done = true;
      resolve(reading);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      // Past the limit, the rest is read and dropped, so the refusal can still be answered.
      if (size > maxBytes) {
        finish({ status: 'too_large' });
        return;
      }
      if (!done) chunks.push(chunk);
    });
    req.on('end', () => finish(parseJson(Buffer.concat(chunks).toString('utf8'), maxBytes)));
    req.on('error', () => finish({ status: 'not_json' }));
  });
}

function parseJson(text: string, maxBytes: number): BodyReading {
  if (Buffer.byteLength(text) > maxBytes) return { status: 'too_large' };
  try {
    return { status: 'ok', value: JSON.parse(text) };
  } catch {
    return { status: 'not_json' };
  }
}

/** A refusal before the stream opens: a status and `{ error: { code, message } }`. Nothing once the caller has gone. */
function refuse(res: ServerResponse, status: number, code: string, message: string): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { code, message } }));
}

function digest(value: string): Buffer {
  return crypto.createHash('sha256').update(value).digest();
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

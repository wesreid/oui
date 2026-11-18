/**
 * The live-call turn: what the service running a call sends for each turn,
 * and the event stream the agent answers with.
 *
 * The call service hears the person, transcribes them, and speaks the reply in
 * the character's voice. The agent is the product's: it holds the
 * conversation, its tools, its UI actions and its approvals. Each turn is one
 * request:
 *
 *   POST <the product's route>
 *   Authorization: Bearer <credential>
 *   Content-Type: application/json
 *   Accept: text/event-stream
 *
 *   { sessionId, clientRef, turnId, kind, text, input?, output?, supersedes?, disclosureLine?, client?: { ui?, vision?, capture?, handoff? } }
 *
 * `input` is `{ mode: 'voice', language? }` for what the person said and
 * `{ mode: 'text' }` for what they typed during the call. `output` is
 * `{ mode: 'voice', voiceDirections? }` when a voice reads the reply out, with
 * the tags that voice can be directed with. `disclosureLine`, on an `opening`
 * turn, is what the call service has just said to the person before the
 * agent's greeting (that they are talking with an AI assistant), as spoken.
 * `client.ui`, when the person's page sent its UI into the call, is that page
 * as its typed turns carry it: `{ buildId?, currentPath?, oui?, uiKnowledge? }`.
 *
 * `client.vision`, when the character may see the caller, is
 *
 *   { seeing, remarks, canLook, absent: 'camera_off' | 'turned_off' | null,
 *     look: { url, token, expiresAt } | null, observation: '<one sentence>' | null }
 *
 * No turn carries a picture. `seeing`: the character may see
 * the caller; `remarks`: it may bring up what it sees unprompted. With
 * `canLook`, the model is given the `look` tool, which asks the call service's
 * `look.url` a question about the caller's camera with `look.token` and is
 * answered in words; it is told to look only when the conversation calls for
 * it. Without, it is told it cannot see the caller, and why (`absent`). The
 * token, a look's question and answer, and the observation are never logged
 * or emitted.
 *
 * A `glance` turn is the call service's look between turns: nobody has spoken
 * for a while, and its own look noticed something worth a remark. `text` is
 * empty, `client.vision.remarks` is on and `client.vision.observation` says
 * what was noticed. The model phrases one short remark on it (and may look for
 * more), or says nothing: an empty answer is `done` with no `text`, and the
 * call stays silent. `observation` is read on a glance only.
 *
 * `client.capture`, on every turn of a session whose client defined capture
 * plans, is
 *
 *   { plans: [{ key, title, offerWhen }], control: { url, token, expiresAt },
 *     active: { captureId, plan, status, step: { id, label, index, of } | null } | null,
 *     update: '<words>' | null }
 *
 * With plans and a control route, the model has `capture_start`,
 * `capture_status` and `capture_stop` (capture/capture-tools.ts), which call
 * the route with the token. Everything it learns of a capture is words: no
 * turn or tool carries a photo. A `capture` turn is the call service passing
 * on what happened in a capture: `text` is empty, `client.capture.update`
 * says what happened, and the model reads `liveCallCaptureMessage(update)`
 * where the person's words would be. It narrates it in a short line, or says
 * nothing. The call service sends `client.capture` and `capture` turns only to
 * a brain whose endpoint declares `acceptsCapture`: a worker before them
 * refuses a turn kind it does not know. The token and the update's words are
 * never logged.
 *
 * `client.handoff`, on every turn of a session whose call can move to the
 * caller's other device, is
 *
 *   { control: { url, token, expiresAt },
 *     device: { formFactor: 'phone' | 'tablet' | 'desktop' | 'unknown', switches } | null,
 *     offer: { handoffId, purpose, expiresAt } | null,
 *     update: '<words>' | null }
 *
 * With a control route, the model has `call_handoff({ purpose })`
 * (handoff/handoff-tool.ts), which calls the route with the token: a QR code
 * appears on the caller's screen, and the model never gets the code or the
 * link. A `device` turn is the call service passing on what happened to the
 * caller's devices (an offer, a switch, a device brought back, revoked or
 * lost, a code that expired): `text` is empty, `client.handoff.update` says
 * what happened, and the model reads `liveCallDeviceMessage(update)` where the
 * person's words would be. It answers with one short sentence, or with
 * nothing. Capture updates that arrived with it ride the same turn, in
 * `client.capture.update`. The call service sends `client.handoff` and
 * `device` turns only to a brain whose endpoint declares `acceptsHandoff`: a
 * worker before them refuses a turn kind it does not know. The token and the
 * update's words are never logged.
 *
 * and the answer is `200 text/event-stream`:
 *
 *   event: text       data: { "text": "…" }                               the reply, piece by piece
 *   event: readback   data: { "approvalId", "text", "expiresAt" }         an approval's readback, verbatim
 *   event: done       data: { "stopReason"?: "…" }                        the turn is over
 *   event: error      data: { "code": "…", "message": "…" }               the turn failed
 *
 * with `: keep-alive` comments while nothing else is sent.
 */
import { readMessageInput, readReplyOutput, type MessageInput, type ReplyOutput } from '@ouispec/agent-core';
import { VISION_LIMITS, readTurnVision, type TurnVision } from '../prompt/vision.js';
import { CAPTURE_LIMITS, readTurnCapture, type TurnCapture } from '../prompt/capture.js';
import { HANDOFF_LIMITS, readTurnHandoff, type TurnHandoff } from '../prompt/handoff.js';
import { escapeTagText } from '../prompt/escape.js';

/**
 * `message`: the person said `text`. `opening`: the call has just connected;
 * nothing has been said, and the agent greets. `glance`: nobody has spoken for
 * a while and the caller's picture changed; the agent remarks on it, or says
 * nothing. `capture`: something happened in a photo capture
 * (`client.capture.update`); the agent says it in a short line, or says
 * nothing. `device`: something happened to the caller's devices
 * (`client.handoff.update`); the agent says it in one short
 * sentence, or says nothing.
 */
export const LIVE_CALL_TURN_KINDS = ['message', 'opening', 'glance', 'capture', 'device'] as const;

export type LiveCallTurnKind = (typeof LIVE_CALL_TURN_KINDS)[number];

/**
 * The person's page, as it sent its UI into the call: the same context a typed
 * turn from that page carries, by the same names. The handler puts `oui`,
 * `uiKnowledge` and `currentPath` on the turn's context, so the turn's UI tools
 * are the page's, as on a typed turn.
 */
export interface LiveCallClientUi {
  /** The OUI build the page runs: its manifest's `buildId`. */
  buildId?: string;
  /** Where the person is in the page, as a typed turn's `currentPath`. */
  currentPath?: string;
  /** The page's OUI snapshot, as a typed turn's `context.oui` (`CLIENT_SNAPSHOT_KEY`). */
  oui?: Record<string, unknown>;
  /** The page's knowledge for the turn, as a typed turn's `context.uiKnowledge` (`CLIENT_KNOWLEDGE_KEY`). */
  uiKnowledge?: Record<string, unknown>;
}

/** What the call service says of the person's own side of the call. */
export interface LiveCallClient {
  /** Their page's latest UI, when it sent one into the call. */
  ui: LiveCallClientUi | null;
  /**
   * Whether and how the character may look at their camera, when the call
   * service said (`client.vision`); null when it said nothing (vision is off
   * for the session, the brain does not take it, or the call service predates
   * it). Set as the turn payload's `vision`.
   */
  vision: TurnVision | null;
  /**
   * The session's photo captures, when its client defined capture plans
   * (`client.capture`): the plans, the route and token the capture tools call,
   * the capture running now, and what happened in it since the brain last
   * heard. Null when the call service said nothing of captures. Set as the
   * turn payload's `capture`.
   */
  capture: TurnCapture | null;
  /**
   * The call moving between the caller's devices, when it can
   * (`client.handoff`): the route and token `call_handoff` calls,
   * the device the call is live on, an open offer, and what happened to the
   * devices since the brain last heard. Null when the call service said
   * nothing of hand-offs. Set as the turn payload's `handoff`.
   */
  handoff: TurnHandoff | null;
}

/** A live-call turn request, as read: every field checked, `input` and `output` kept only as far as they are known. */
export interface LiveCallTurnRequest {
  /** The call service's session. */
  sessionId: string;
  /** The product's own conversation reference, set when the call was created: the host resolves its conversation, user and room from it. */
  clientRef: string;
  /** Unique per turn; the turn runs under this id. */
  turnId: string;
  kind: LiveCallTurnKind;
  /** What the person said, as transcribed. Empty for `opening`, `glance`, `capture` and `device`. */
  text: string;
  /**
   * How `text` was entered: `{ mode: 'voice', language? }` for what the person
   * said. Null for a message they typed during the call (`{ mode: 'text' }` on
   * the wire), for `opening`, `glance`, `capture` and `device`, and when not said: a typed message is read as
   * typed, with no spoken-input line.
   */
  input: MessageInput | null;
  /**
   * How the reply reaches the person: `{ mode: 'voice' }` when a voice reads
   * it out, with `voiceDirections` when that voice can be directed by inline
   * tags (the model is told it may use them).
   */
  output: ReplyOutput | null;
  /** Turns this one replaces: the call service closed their streams because the person spoke again. */
  supersedes: string[];
  /**
   * On an `opening` turn: what the call service has already said to the person
   * before the agent greets them (its disclosure that they are talking with
   * an AI assistant), as spoken. The model is told it was said, so its greeting
   * follows on from it instead of repeating it. Null when none was sent, and on
   * a `message` turn, where it is not read.
   */
  disclosureLine: string | null;
  /**
   * The person's own side of the call: their page's latest UI, when the page
   * sent it into the call (`client.ui`), and whether the character may look
   * at their camera (`client.vision`). Null when the call service said nothing of either, as
   * for a call with no page (a phone call). A `glance` always has
   * `client.vision` with `remarks` on and an `observation`; a `capture`
   * always has `client.capture` with an `update`; a `device` always has
   * `client.handoff` with an `update`.
   */
  client: LiveCallClient | null;
}

/** The events of a live-call turn's response stream. */
export interface LiveCallStreamEvents {
  /** A piece of the reply's text. Pieces are concatenated in order. */
  text: { text: string };
  /**
   * The turn stopped at a call that needs the person's approval: `text` is its
   * readback, built from the action's declaration, to be spoken verbatim after
   * any text already sent. The person's next utterance comes as an ordinary
   * `message`; the host decides whether it approves.
   */
  readback: { approvalId: string; text: string; expiresAt: string };
  /**
   * The turn is over. `stopReason` is how it ended: `complete`,
   * `awaiting_approval`, `present_options`, `time_limit`, `output_limit` or
   * `step_count` for a turn that ended by itself; `user_stop`, `superseded`,
   * `deadline` or `taken_over` (and any later stop reason) for one that was
   * stopped. `taken_over`: a person on the staff holds the conversation, and
   * the agent does not answer it until they hand it back; a turn that arrives
   * while it is held says nothing, and the character stays quiet.
   */
  done: { stopReason?: string };
  /** The turn failed. `message` is a fixed line for the code; the cause is in the host's logs, never on the wire. */
  error: { code: string; message: string };
}

export type LiveCallStreamEventName = keyof LiveCallStreamEvents;

/**
 * The person's message for an `opening` turn: an instruction to greet, which
 * the model reads where the person's words would be. A host that stores the
 * person's messages stores this one for the opening turn, so the conversation
 * keeps the turn the greeting answers.
 */
export const LIVE_CALL_OPENING_MESSAGE =
  '<call_opening>A live call with the user has just connected, and they have not said anything yet. ' +
  'Greet them in a sentence or two, and ask what they would like help with. This is not a message from the user.</call_opening>';

/**
 * The person's message for an `opening` turn, as the model reads it: an
 * instruction to greet, and, when the call service sent one, the disclosure
 * it has just spoken, so the greeting follows on from it rather than repeating
 * it. Without a disclosure it is `LIVE_CALL_OPENING_MESSAGE`. A host that
 * stores the person's messages stores this for the opening turn.
 */
export function liveCallOpeningMessage(request: Pick<LiveCallTurnRequest, 'disclosureLine'>): string {
  const disclosure = request.disclosureLine?.trim();
  if (!disclosure) return LIVE_CALL_OPENING_MESSAGE;
  return (
    '<call_opening>A live call with the user has just connected, and they have not said anything yet. ' +
    `The call has already told them, in its own voice: "${disclosure}" ` +
    'Greet them in a sentence or two, following on from that without repeating it, and ask what they would like help with. ' +
    'This is not a message from the user.</call_opening>'
  );
}

/**
 * The person's message for a `glance` turn, as the model reads it: an
 * instruction to phrase one short remark on what a look at the camera just
 * noticed (the turn's `observation`, in its vision note), or to say nothing,
 * so the call stays silent. A host that stores the person's messages stores
 * this for the glance turn, as it stores the opening's: the observation is
 * never in it.
 */
export const LIVE_CALL_GLANCE_MESSAGE =
  '<call_glance>Nobody has spoken for a few seconds, and a look at the user’s camera noticed something; what it noticed is in the vision note. ' +
  'This is not a message from the user. ' +
  'If it is worth one brief, friendly remark (they hold something up, put something on, someone else appears), say that remark, in one short sentence; ' +
  'you may look first if you need to see more. ' +
  'Otherwise answer with nothing at all, not a word or a mark, and the call stays silent. ' +
  'Never repeat a remark you have already made in this call.</call_glance>';

/**
 * The person's message for a `capture` turn, as the model reads it: what
 * happened in the photo capture, in Closure's words (`client.capture.update`),
 * and an instruction to say it to the caller in a short line, or to say
 * nothing, so the call stays silent. A host that stores the person's messages
 * stores this for the capture turn (`liveCallTurnMessage(request)` gives it),
 * so the conversation keeps what happened in the capture as a readable row.
 */
export function liveCallCaptureMessage(update: string): string {
  return (
    `<call_capture><capture_update>${escapeTagText(update.trim())}</capture_update> ` +
    'This is an update from the photo capture on the user’s screen, in Closure’s words: not a message from the user, and never something you saw. ' +
    'Say it to them in one or two short, natural sentences in their language, as their guide through the photos, and never read out a code. ' +
    'When it ends with an offer ("Offer: …"), the photos did not all get taken: say what is missing without pushing, and make that offer. ' +
    'If nothing in it is worth saying, answer with nothing at all, not a word or a mark, and the call stays silent.</call_capture>'
  );
}

/**
 * The person's message for a `device` turn, as the model reads it: what
 * happened to the caller's devices, in Closure's words
 * (`client.handoff.update`), and an instruction to answer
 * it with one short sentence, or with nothing, so the call stays silent. A
 * host that stores the person's messages stores this for the device turn
 * (`liveCallTurnMessage(request)` gives it), so the conversation keeps which
 * device the call moved to as a readable row.
 */
export function liveCallDeviceMessage(update: string): string {
  return (
    `<call_device><device_update>${escapeTagText(update.trim())}</device_update> ` +
    'This is an update about the user’s devices on this call, in Closure’s words: not a message from the user, and never something you saw. ' +
    'Answer it with one short, natural sentence in their language, and never read out a code or a link. ' +
    'If nothing in it is worth saying, answer with nothing at all, not a word or a mark, and the call stays silent.</call_device>'
  );
}

/**
 * The `input` mode of a message the person typed during the call. It is read
 * as typed: the turn's context carries no `input`, as for a message typed in
 * the product's own chat.
 */
export const LIVE_CALL_TYPED_INPUT_MODE = 'text';

/** Limits on a request. */
export const LIVE_CALL_LIMITS = {
  /** The longest `sessionId`, `turnId`, or turn id in `supersedes`. */
  idChars: 128,
  /** The longest `clientRef`. */
  clientRefChars: 512,
  /** The longest `text`. */
  textChars: 8_000,
  /** The most turn ids in `supersedes`. */
  supersedes: 32,
  /** The longest `disclosureLine`. */
  disclosureLineChars: 1_000,
  /** The most `client.ui` may weigh, as UTF-8 JSON: the bound the page and the call service hold it to. */
  clientUiBytes: 64 * 1024,
  /** The longest `client.vision.observation` (`VISION_LIMITS.observationChars`). */
  visionObservationChars: VISION_LIMITS.observationChars,
  /** The longest `client.capture.update` (`CAPTURE_LIMITS.updateChars`). */
  captureUpdateChars: CAPTURE_LIMITS.updateChars,
  /** The longest `client.handoff.update` (`HANDOFF_LIMITS.updateChars`). */
  handoffUpdateChars: HANDOFF_LIMITS.updateChars,
} as const;

/** An id: letters, digits and `.` `_` `:` `-`, starting with a letter or digit. */
const ID = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,${LIVE_CALL_LIMITS.idChars - 1}}$`);
/** Any control character. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A request read, or why it is not one. */
export type LiveCallRequestReading = { ok: true; request: LiveCallTurnRequest } | { ok: false; error: string };

/** Reads a live-call turn request's body. Every refusal names the field. */
export function readLiveCallTurnRequest(body: unknown): LiveCallRequestReading {
  const refuse = (error: string): LiveCallRequestReading => ({ ok: false, error });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return refuse('the body must be a JSON object');
  const b = body as Record<string, unknown>;

  for (const field of ['sessionId', 'turnId'] as const) {
    if (typeof b[field] !== 'string' || !ID.test(b[field] as string)) {
      return refuse(`${field} must be an id of 1–${LIVE_CALL_LIMITS.idChars} letters, digits, '.', '_', ':' or '-'`);
    }
  }
  const clientRef = b.clientRef;
  if (typeof clientRef !== 'string' || !clientRef.trim() || clientRef.length > LIVE_CALL_LIMITS.clientRefChars || CONTROL.test(clientRef)) {
    return refuse(`clientRef must be a string of 1–${LIVE_CALL_LIMITS.clientRefChars} characters with no control characters`);
  }
  if (typeof b.kind !== 'string' || !(LIVE_CALL_TURN_KINDS as readonly string[]).includes(b.kind)) {
    return refuse(`kind must be one of ${LIVE_CALL_TURN_KINDS.join(', ')}`);
  }
  const kind = b.kind as LiveCallTurnKind;
  const text = b.text === undefined && kind !== 'message' ? '' : b.text;
  if (typeof text !== 'string') return refuse('text must be a string');
  if (text.length > LIVE_CALL_LIMITS.textChars) return refuse(`text is longer than ${LIVE_CALL_LIMITS.textChars} characters`);
  if (kind === 'message' && !text.trim()) return refuse('a message turn needs the text the person said');
  if (kind !== 'message' && text.trim()) return refuse(`${kind === 'opening' ? 'an opening' : `a ${kind}`} turn carries no text`);

  for (const field of ['input', 'output'] as const) {
    const value = b[field];
    if (value !== undefined && value !== null && (typeof value !== 'object' || Array.isArray(value))) return refuse(`${field} must be an object`);
  }

  const supersedes = b.supersedes ?? [];
  if (!Array.isArray(supersedes) || !supersedes.every((id) => typeof id === 'string' && ID.test(id))) {
    return refuse('supersedes must be a list of turn ids');
  }
  if (supersedes.length > LIVE_CALL_LIMITS.supersedes) return refuse(`supersedes names more than ${LIVE_CALL_LIMITS.supersedes} turns`);

  const disclosureLine = b.disclosureLine ?? null;
  if (
    disclosureLine !== null &&
    (typeof disclosureLine !== 'string' || disclosureLine.length > LIVE_CALL_LIMITS.disclosureLineChars || CONTROL.test(disclosureLine))
  ) {
    return refuse(`disclosureLine must be a string of at most ${LIVE_CALL_LIMITS.disclosureLineChars} characters with no control characters`);
  }

  const read = readClient(b.client);
  if (typeof read === 'string') return refuse(read);
  if (kind === 'glance') {
    // A glance offers a remark on what was noticed: without leave to remark, or with nothing noticed, there is nothing to run.
    if (!read?.vision?.remarks) return refuse('a glance turn needs client.vision.remarks on');
    if (!read.vision.observation) return refuse('a glance turn needs client.vision.observation');
  }
  // A capture turn passes on what happened in a capture: with nothing to pass on, there is nothing to run.
  if (kind === 'capture' && !read?.capture?.update) return refuse('a capture turn needs client.capture.update');
  // A device turn passes on what happened to the caller's devices: with nothing to pass on, there is nothing to run.
  if (kind === 'device' && !read?.handoff?.update) return refuse('a device turn needs client.handoff.update');
  // What a look noticed belongs to its glance alone.
  const client = read?.vision?.observation && kind !== 'glance' ? { ...read, vision: { ...read.vision, observation: null } } : read;

  return {
    ok: true,
    request: {
      sessionId: b.sessionId as string,
      clientRef,
      turnId: b.turnId as string,
      kind,
      text: kind === 'message' ? text : '',
      // Nothing was said on an opening, a glance, a capture or a device turn, so nothing was entered; a typed message is read as typed.
      input: kind !== 'message' || isTyped(b.input) ? null : readMessageInput(b.input),
      output: readReplyOutput(b.output),
      supersedes: [...new Set(supersedes as string[])].filter((id) => id !== b.turnId),
      // Said before the greeting: an opening turn's alone.
      disclosureLine: kind === 'opening' && disclosureLine?.trim() ? disclosureLine.trim() : null,
      client,
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The request's `client`, or why it is not one. Fields it does not know are
 * left out, so a newer call service is read past; a known field of the wrong
 * type is refused, naming it. A refusal never repeats a look's, a capture's
 * or a hand-off's token.
 */
function readClient(value: unknown): LiveCallClient | null | string {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) return 'client must be an object';
  const vision = readTurnVision(value.vision, 'client.vision');
  if (typeof vision === 'string') return vision;
  const capture = readTurnCapture(value.capture, 'client.capture');
  if (typeof capture === 'string') return capture;
  const handoff = readTurnHandoff(value.handoff, 'client.handoff');
  if (typeof handoff === 'string') return handoff;
  const ui = readClientUi(value.ui);
  if (typeof ui === 'string') return ui;
  return { ui, vision, capture, handoff };
}

/** The request's `client.ui`, or why it is not one. */
function readClientUi(raw: unknown): LiveCallClientUi | null | string {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) return 'client.ui must be an object';
  const bytes = Buffer.byteLength(JSON.stringify(raw));
  if (bytes > LIVE_CALL_LIMITS.clientUiBytes) return `client.ui is ${bytes} bytes, more than ${LIVE_CALL_LIMITS.clientUiBytes}`;
  const ui: LiveCallClientUi = {};
  for (const field of ['buildId', 'currentPath'] as const) {
    const v = raw[field];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string' || CONTROL.test(v)) return `client.ui.${field} must be a string with no control characters`;
    ui[field] = v;
  }
  for (const field of ['oui', 'uiKnowledge'] as const) {
    const v = raw[field];
    if (v === undefined || v === null) continue;
    if (!isPlainObject(v)) return `client.ui.${field} must be an object`;
    ui[field] = v;
  }
  return ui;
}

/** Whether `input` says the message was typed during the call. */
function isTyped(input: unknown): boolean {
  return !!input && typeof input === 'object' && (input as { mode?: unknown }).mode === LIVE_CALL_TYPED_INPUT_MODE;
}

/**
 * What a failed turn's `error` event says, by code. Fixed lines: the call
 * service records the code and speaks its own apology, and the cause (a
 * provider's error text, a stack) stays in the host's logs.
 */
export const LIVE_CALL_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  RATE_LIMIT: 'The model provider is rate-limiting requests.',
  SERVICE_UNAVAILABLE: 'The model provider is unavailable.',
  MODEL_TIMEOUT: 'The model timed out.',
  TURN_TIMEOUT: 'The turn timed out.',
  TURN_DEADLINE_EXCEEDED: 'The turn ran out of time.',
  TURN_REFUSED: 'The turn was refused by its record: it already ended or was given up on.',
  TURN_DECLINED: 'The product declined to run the turn.',
  WORKER_ERROR: 'The turn failed.',
};

/** The `error` event for a failure code. */
export function liveCallError(code: string): LiveCallStreamEvents['error'] {
  return { code, message: LIVE_CALL_ERROR_MESSAGES[code] ?? LIVE_CALL_ERROR_MESSAGES.WORKER_ERROR };
}

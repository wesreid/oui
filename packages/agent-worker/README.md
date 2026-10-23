# @ouispec/agent-worker

The agent runtime. One core runs a turn: the model, the tool loop, UI actions answered by the user's own tab, streaming, retries and deadlines. Two host adapters run that core: Lambda + SQS, and a long-running container. A third entry point, the live-call handler, lets a service that runs a voice call reach the same agent ("Live calls").

## What the host supplies

A missing value fails when the adapter is created, and the error names it. Nothing falls back to an environment variable or an empty string.

| Seam | Config | Notes |
|---|---|---|
| Model | `model` | Any `ai` library model: `bedrock(...)`, `openai(...)`, `anthropic(...)`, or a gateway id. The worker imports no provider itself. |
| Prompt cache | `promptCacheBreakpoint`, optional | Provider options that mark a cache breakpoint. `PROMPT_CACHE_BREAKPOINTS.bedrock` and `.anthropic` are provided. Omit it for a provider that caches on its own. |
| Realtime server | `realtime: { url, apiKey }` | The `agent-sdk-realtime` server and its internal key. Turn events go to `POST {url}/api/emit`, and UI action answers are collected from `GET {url}/internal/oui/action-results/:id`. |
| Persona | `persona` or `systemPrompt`, exactly one | The assistant's identity comes only from here. The shipped rules name no product. |
| Tools | `tools` | A list, or a per-turn resolver. Pass `[]` when the only tools are the tab's UI actions. |
| Persistence | `getDb`, `getHistory`, `persistMessages` | `getDb`'s handle is passed to every callback. `recordTurnStart`, `recordTurnComplete` and `recordTurnFailure` are optional. See "Stopping a turn" for what each is told of a stopped or superseding turn. |

Optional tuning, with its defaults:
- `maxRounds`: 12
- `maxTokens`: 32,000 per model response, thinking included. A step cut off there before it says or calls anything runs once more, told to plan less; if that is cut off too, the person is told and the turn ends with `stopReason: 'output_limit'`.
- `temperature`: 0.3
- `modelProviderOptions`: none. Provider options sent with every model call of every turn, e.g. a summary of the model's thinking (`{ amazonBedrock: { additionalModelRequestFields: { thinking: { type: 'adaptive', display: 'summarized' } } } }`). Keep them the same for every turn: a thinking setting that changes between calls invalidates the prompt cache. Whatever it is set to, each thinking block's start and end go to the turn's room (`agent:reasoning_started`, `agent:reasoning_ended`), and a summary the model returns streams between them (`agent:reasoning_delta`). None of it is stored with the conversation.
- `forcedToolChoice`: true. Set `false` for a model that refuses a forced tool choice (Claude Sonnet 5.5 answers 400 to one): a step the turn policy forces to a tool is given only that tool and told to call it.
- `toolTimeoutMs`: 30 s
- `turnDeadlineMs`: 14 min (keep it below your host's own limit)
- `handBackReserveMs`: 30 s, at most a quarter of `turnDeadlineMs`. Before each step the worker checks that a step as long as the turn's longest so far, plus this reserve, still fits before the deadline. When it does not, that step is the turn's last: the model is told to say what is done and what is left and to offer to continue (with `present_options` when the host gives it, in words otherwise), the host's turn policy is not asked about it, and the turn ends with `stopReason: 'time_limit'`. The deadline itself still stops a step that runs longer than any before it.
- `retries`: 3

A host that fits its stored history loads `@ouispec/agent-worker/history` (`answerWithoutState`): a module with no runtime imports, which also answers a CommonJS resolver.

Policy hooks: `turnPolicy`, `toolPolicy`, `uiActions`, `approvals`, `stops`, `logger`.

## What a UI client sends with a turn

Four keys on the turn's `context` are for the worker itself, and your persona or `systemPrompt` callback never sees them:

| Key | What the tab puts there | What the worker does with it |
|---|---|---|
| `oui` | Its surface snapshot: `ouiRuntime.snapshot()` | Builds the turn's UI tools from it, and from nothing else |
| `uiKnowledge` | Its generated knowledge for the page the user is on: `resolveKnowledge(generatedKnowledge, path)` from `@ouispec/bindings` | Renders it after your prompt: each entry under "Platform Knowledge", then each recipe under "Active Workflows" |
| `input` | How the person entered the message, when they did not type it: `{ mode: 'voice', language }` for one they spoke, with the language the recogniser detected. `@ouispec/agent-react` sets it from `sendMessage(text, { input })` | Adds one line after the conversation: the message was spoken and machine-transcribed, so it may contain recognition errors; the language; and to ask rather than guess when a likely mis-hearing makes the request ambiguous. An unknown mode is read as typed, and a language that is not a BCP 47 tag of at most 16 characters is left out (`readMessageInput` in `@ouispec/agent-core`). A typed message, and the turn an approval card's click starts, get nothing |
| `output` | How the reply reaches the person, when it is not shown as text: `{ mode: 'voice' }` when a voice reads it out. The live-call handler sets it from the call's request | Adds one line after the conversation: the reply will be heard, not read, so short plain sentences; no markdown, lists, headings, links, code or emoji; numbers, prices, dates and times written as they are said; anything the person should look at shown through the page's actions rather than read out; and a few words before a slow lookup. An unknown mode is read as a shown reply, which gets nothing (`readReplyOutput` in `@ouispec/agent-core`). It applies on every turn of a call, the turn that continues an approval included |

`timeZone` (the user's IANA zone, which `@ouispec/agent-react` sends with every turn) is read by the worker too: the date and time on the user's clock are added to the turn's user message.

What is true only for this turn (the clock, how the message was entered, how the reply is delivered) goes after the conversation, never in the system prompt or on a message. The system prompt, the tools and every message are the cached prefix, and stay byte for byte the same whatever the turn says, so a conversation's chat turns and call turns read the same prefix. Store `input` with the user's message if your chat shows how a message was entered (`AgentStoredMessage.input`); the history the worker reads needs no copy of it.

Every other key is the page's context, which a persona prompt shows as the current UI state. A malformed `oui` or `uiKnowledge` fails the turn, naming the bad field. The worker logs `UI surfaces for this turn` with the surface ids and the knowledge's entry and workflow counts.

## Approvals

An irreversible action runs only on an approval the user gave, bound to the exact call. A call needs approval when:

- its declared `effect` is a `transaction` (an order, a payment, a send, a publish), which no policy can waive;
- its declaration says `destructive: true` (a UI action's `confirm`, or a host tool's `destructive`);
- or your `toolPolicy` returns `require_approval`. The policy's context carries the tool's `effect` and `destructive`, so it can decide on what the call does rather than on its name.

A `deny` always wins, over an approval too, and an approved call still runs as the user.

What happens:

1. The first such call in a turn stops the turn. The worker stores it in the realtime server's approval store and emits `agent:approval_required` with the preview. The preview's words come from the declaration: the tool's `title`, its `consequence` or description, and its input schema's property titles. The model is told only that the call is waiting, and never sees a token. Any other call in the same response is not run.
2. The user decides on the approval card.
3. The next turn carries `approval: { approvalId, decision: 'approve', token }` or `{ approvalId, decision: 'decline' }` on its payload, outside the message text. The worker redeems the token and runs exactly the stored call. A UI action's request then carries `approval: { approvalId, argsHash }` for the browser's own check. The call and its result are persisted, and the model is told what happened in an `<approval>` block. A replayed, expired or foreign token runs nothing, and neither does a decline; the model is told why.

In a browser, the turn after the decision comes from `ApprovalCard` (`@ouispec/agent-react`). Your `sendMessage` callback receives `approval` beside an empty `content`. Pass it unchanged to the worker as the turn payload's `approval`: `{ approvalId, decision: 'approve', token }` or `{ approvalId, decision: 'decline' }`. A UI action declares its effect on its OUI surface (`effect: 'transaction'`, or `confirm: true` for a destructive one). The tab's OUI runtime runs it only on the grant from the user's own click, which `grantApproval` in the client config hands it.

On a call there is no card. The live-call handler sends the preview's `readback`, verbatim, after the turn's text, and the person answers in words. Their next utterance comes as an ordinary message, and your `resolveTurn` decides whether it approves: classify the words, then decide as the user on a conversation channel with the approval store client (`createHttpApprovalStoreClient(...).decide(approvalId, { userId, decision, channel: 'voice' })`). An `approve` answers with the token; return `approval: { approvalId, decision: 'approve', token }` on the turn's target, and the turn runs exactly the stored call, once. Anything else (a no, a correction, a new request) leaves the approval to expire, or decline it with `decision: 'decline'`. A UI action that needs approval still runs only on the grant from the tab's own card click: the tab's OUI runtime refuses one approved by voice, so on a call put irreversible acts in host or API tools, or let the page show the card.

Declare a host tool's approval needs on the tool itself: `effect`, `destructive`, `title`, `consequence`, and `argsSensitive: false` when its arguments may be logged. Without an approval store, such a call is refused and never runs. The runtime uses the realtime server's store unless you pass `approvals.store`.

## Stopping a turn

A turn can be stopped by the person, or superseded by their next message. The request is kept by the realtime server (`@ouispec/agent-realtime`, "Stopping a turn"), and the turn asks for it there for as long as it runs. Nothing needs configuring: the runtime uses the realtime server you already gave it. `stops.graceMs` (default 2 s) is how long an answer already on its way is still waited for.

The turn asks its first question before it starts, so a stop asked for while it waited in a queue is heard first: the model is not called, and the turn stores only that it was stopped. Asking never holds a turn up or fails it: if the server cannot be asked, the turn runs and the question is asked again.

What a stopped turn does:

1. Everything that was waiting ends: the model's stream, a UI action's answer, a job's outcome.
2. Each call keeps exactly one result. A call that finished keeps its result. A UI action that was out takes one last look for its answer, so an action that did run is stored as run and is not done again; with no answer it is stored as sent with its outcome unknown, and the page is treated as unseen. A request no tab took, and an action that had not been sent, are stored as not run. A job the action started is not cancelled.
3. `persistMessages` is called with what the turn had produced, and `stopped: { reason, at }`. The last assistant message carries the same marker (`TurnMessage.stopped`). Store it with the message and hand it back in history (`TurnHistoryMessage.stopped`): the model is then told, after that message's text, that the turn was stopped there. A turn that produced nothing still stores one assistant message, whose text is that line.
4. Only then is the client told: `agent:turn_complete` with `stopReason` `user_stop`, `superseded` or `deadline`. `recordTurnComplete` receives the same `stopReason`, and the runner's outcome is `stopped`, not `failed`.

A stop that arrives once the turn has begun its own end is not one: the turn completes as it would have.

A turn that runs short of time normally ends before its deadline, with a last step that says what is done (`handBackReserveMs` above). A turn that reaches its deadline anyway (`turnDeadlineMs`) ends on the same path, with `stopReason: 'deadline'`: what it did before it ran out of time is kept, marked, and the next turn is told. If its store fails or does not finish in time, nothing of it was kept: the runner records it with `recordTurnFailure` as `TURN_DEADLINE_EXCEEDED`, and its outcome carries `stored: false`. A store that timed out may still finish after that, so record the failure only over a turn that is still running (a conditional update from `running`).

For a message sent while a turn is running (a barge-in), your API stops the running turn (`POST /internal/turns/:turnId/stop` with `superseded`), withdraws a waiting approval (`settle` with `expire`), and puts the ids of the turns it stopped on the new turn's payload as `supersedes`. The hooks then let you order the two:

| Hook | What it is told, and what it may answer |
|---|---|
| `getHistory(conversationId, db, turn)` | `turn.supersedes` names the turns to wait for before reading: read once each is stored, or once you have given up on it. `turn.signal` aborts if this turn is itself stopped while it waits. |
| `persistMessages(...)` | May answer `{ stored: false }` when you found the turn already given up on by a newer one and stored nothing. The turn is still announced, and nothing that depends on its messages being stored is done. |
| `recordTurnStart(...)` | May answer `{ run: false, reason }` when your record of the turn shows it already ended or was given up on, which is what a queue's redelivery of an old turn finds. The turn then does nothing: no model call, no UI action, no event. The runner's outcome is `refused`. |

Every UI action request names its turn (`turnId`). Give the tab's OUI runtime `accept: acceptCurrentTurn(agent.acceptedTurnId)` (`oui-spec`, `@ouispec/agent-react`), and a request a stopped or superseded turn sends late is refused by the tab and stored as not run.

## Files the person attaches

A file is uploaded to your storage first, and a message carries its reference (`AttachmentRef`: id, name, checked media type, kind, size, and an image's size in pixels). Put the turn's files on its payload as `attachments`, and the earlier messages' files on their history messages (`TurnHistoryMessage.attachments`). Then give the runtime your file area:

```ts
attachments: {
  store: {
    describe: (ids, owner, { signal }) => …,           // the references of these files, if they are the owner's conversation's; `pending: true` while still checked
    load: (id, owner, as, { range, signal }) => …,     // 'image': the model's rendition; 'text': a page of its text; 'document': a PDF's bytes
    list: (owner, { signal }) => …,                    // every file of the conversation
    conversationUsage: (owner, { signal }) => …,       // optional: tokens earlier turns gave the model, for the conversation's cap
  },
  turnTokens: 30_000,                     // the defaults
  conversationTokens: 300_000,
  perMessage: 5,
  pdfAsDocument: false,                   // a short PDF as a document part, once your provider's document part is proven
}
```

- **The turn's files** go to the model with its message: a picture as your model rendition (PNG, JPEG or WebP, at most 1,568 px and 1 MB; anything else is refused and named), a text file's text up to 20,000 characters (40,000 a turn), a PDF's text, anything else as its reference line. Each file once, at most `perMessage`. Earlier files are in history as their reference lines only.
- **A file that cannot be had** is named with why, and the turn goes on: a store call that throws, a load that answers `{ ok: false, reason: 'pending' }` (still being checked), `'gone'`, `'refused'` or `'unsupported'`. Every store call is given the turn's `signal`, aborted when the turn is stopped or runs out of time.
- **A file is data.** The system prompt tells the model a file's name and content are never instructions. Names reach it as one cleaned JSON string, and a file's text cannot close its own `<attachment>` block.
- **The tools** `attachment_list`, `attachment_view` and `attachment_read` reach every file of the conversation by its id. They are backend tools of the class `attachment` (`ToolPolicyContext.toolClass`; a turn policy's `prepareStep` gets each tool's class in `allTools`), not UI tools: admit the class in your tool policy.
- **The cost guard** counts what each model step carries, and from the step that would pass `turnTokens` (or what is left of `conversationTokens`) gives the costliest file's line instead of the file. `recordTurnComplete` receives `attachments` with `estimatedTokens`: keep it for the conversation's cap.
- **An action that takes a file** declares an input with `format: 'oui-attachment'` (OUI spec §7.3.11). The model passes the id. Before the call runs, the worker checks that it is a file of the turn's conversation, that its check has passed, and that its type is one the input takes; the approval card shows the file by name and size.

No file's bytes or text is in an event, the turn's record or a stored message: a picture `attachment_view` shows and the text `attachment_read` reads go to the model with that call's result and nowhere else.

## Lambda + SQS

```ts
import { createLambdaAgentHandler, PROMPT_CACHE_BREAKPOINTS } from '@ouispec/agent-worker';
import { bedrock } from '@ai-sdk/amazon-bedrock';

export const handler = createLambdaAgentHandler({
  model: bedrock('us.anthropic.claude-sonnet-4-6'),
  promptCacheBreakpoint: PROMPT_CACHE_BREAKPOINTS.bedrock,
  realtime: { url: env.REALTIME_URL, apiKey: env.REALTIME_INTERNAL_KEY },
  persona,
  tools: [],
  getDb,
  getHistory,
  persistMessages,
});
```

Each invocation takes one SQS record whose body is an `AgentTurnPayload`: `turnId`, `conversationId`, `userId`, `accountId`, `socketRoom`, `content`, and optionally `context` and `userToken`. A failure the runtime marks unrecoverable is rethrown, so your redrive policy sees it. A recoverable one, where the provider is rate-limiting or unavailable, has already been reported to the client and is not rethrown.

## Container

```ts
import { startContainerAgentWorker } from '@ouispec/agent-worker';
import { openai } from '@ai-sdk/openai';

const worker = await startContainerAgentWorker({
  model: openai('gpt-4.1'),
  realtime: { url: env.REALTIME_URL, apiKey: env.REALTIME_INTERNAL_KEY },
  systemPrompt: () => persona,
  tools: [],
  getDb,
  getHistory,
  persistMessages,
  port: 8080,
  workerApiKey: env.WORKER_KEY,
});
process.on('SIGTERM', () => worker.close()); // closing waits for running turns
```

Your API sends turns to the worker's HTTP endpoints:

| Request | Responses |
|---|---|
| `POST /turns` with an `AgentTurnPayload` and `x-api-key` | `202` once accepted. `400` if the body is not a turn, `401` for a wrong key, `409` if that turn is already running, `503` at capacity (`maxConcurrentTurns`, default 8) or while shutting down. |
| `POST /live-call/turns` with a live-call turn and `Authorization: Bearer` | Only with `liveCall` configured (below, and "Live calls"). `200 text/event-stream`. |
| `GET /health` | The worker's status, running turns, capacity and model. |

`onTurnEnd` receives each turn's outcome.

`liveCall: { credential, resolveTurn, opening?, keepAliveMs?, path? }` serves the live-call route on the same server, runtime and slots: `maxConcurrentTurns` bounds both routes together, a turn id runs once whichever route it came by, and `close` waits for both. Its requests carry the call service's credential, never `workerApiKey`. `path` defaults to `/live-call/turns`.

## Live calls

A service that runs a voice call (it hears the person, transcribes them, and speaks the reply in a character's voice) can be answered by your own agent: its persona, tools, UI actions, approvals and records. Each turn of the call is one HTTP request to a route you mount, and the reply streams back as server-sent events. The turn runs on the same runtime as every other turn, so it still streams to the conversation's realtime room: every page joined to that conversation receives the reply and every UI action, as for a typed message, and the call page can show what the agent is talking about.

```ts
import { createAgentTurnRunner, createLiveCallTurnHandler, LIVE_CALL_OPENING_MESSAGE } from '@ouispec/agent-worker';

const runner = createAgentTurnRunner(runtimeConfig);   // the same config as your other turns
const liveCall = createLiveCallTurnHandler({
  runner,
  credential: env.LIVE_CALL_CREDENTIAL,                // or [current, next] while rotating
  resolveTurn: async (request, { signal }) => {
    const conversation = await findConversationByCallRef(request.clientRef);
    if (!conversation) return null;                    // answered 404
    await storeUserMessage(conversation.id, request.kind === 'opening' ? LIVE_CALL_OPENING_MESSAGE : request.text, request.input);
    return {
      conversationId: conversation.id,
      userId: conversation.userId,
      accountId: conversation.accountId,
      socketRoom: `conversation:${conversation.id}`,
      context: conversation.pageContext,               // the call page's OUI snapshot and knowledge, as for a typed turn
    };
  },
  opening: (request, target) => greetingTemplateFor(target.accountId),  // optional; null lets the model greet
});
app.post('/agent/live-call/turns', liveCall);          // any Node server: (req, res)
process.on('SIGTERM', () => liveCall.close());        // waits for running turns
```

`createLiveCallTurnHandler(config)` returns a Node `(req, res)` handler with `running()` and `close()`. A body that Express's `json()` already parsed is taken as it is.

| Config | |
|---|---|
| `runner` | Required. `createAgentTurnRunner(...)`: the runtime that runs your other turns. |
| `credential` | Required. The bearer credential the call service sends, from your secret store; a list while one is rotated. Compared in constant time. |
| `resolveTurn(request, { signal })` | Required. The call's `clientRef` → the turn's `conversationId`, `userId`, `accountId` and `socketRoom`, with optional `context`, `userToken` and `approval`; null when you have no such conversation. Do here what your API does for a chat message: store the person's message (for an `opening`, `LIVE_CALL_OPENING_MESSAGE`), claim the turn, and decide on a waiting readback ("Approvals"). `signal` aborts if the caller hangs up meanwhile. |
| `opening(request, target, { signal })` | Optional. A greeting from your template for an `opening` turn: streamed, sent to the room and stored as the turn's one assistant message (`runner.reply`), with no model call. Null, undefined or blank lets the model greet. A throw fails the turn. |
| `keepAliveMs` | Default 5 s: a `: keep-alive` comment after this long with nothing written. |
| `maxConcurrentTurns` | Default 8; more are answered `503`. |
| `maxBodyBytes` | Default 64 KiB. |
| `onTurnEnd(outcome)` | Each turn's outcome, after it ends. |

**The request.** `POST`, `Content-Type: application/json`, `Authorization: Bearer <credential>`:

| Field | |
|---|---|
| `sessionId` | The call service's session. |
| `clientRef` | Your conversation reference, given to the call service when the call was created. |
| `turnId` | Unique per turn; the turn runs under it. |
| `kind` | `message`: the person said `text`. `opening`: the call has just connected, `text` is empty, and the agent greets: the model reads `LIVE_CALL_OPENING_MESSAGE` where the person's words would be. |
| `text` | What the person said, as transcribed; at most 8,000 characters. |
| `input` | `{ mode: 'voice', language? }`: set as the turn's `context.input`. Dropped on an `opening`. |
| `output` | `{ mode: 'voice' }`: set as the turn's `context.output`, so the model writes for the ear ("What a UI client sends with a turn"). |
| `supersedes` | Turns this one replaces. Each still running in this process is stopped at once, and the turn's `getHistory` is given them to wait for, as for any superseding message. |

`readLiveCallTurnRequest` reads a body as the handler does, and `LIVE_CALL_LIMITS` holds its limits.

**The response.** `200 text/event-stream`, flushed event by event:

| Event | Data | |
|---|---|---|
| `text` | `{ text }` | The reply as the model writes it; concatenate the pieces. Rounds the model writes between tool calls are separated by a blank line, as in the room. |
| `readback` | `{ approvalId, text, expiresAt }` | The turn stopped at a call that needs approval. `text` is the preview's `readback`, verbatim, built from the action's declaration; `expiresAt` is ISO 8601. Sent once the turn has ended by itself, after all of its text. A turn that was stopped withdrew its approval, and sends none. |
| `done` | `{ stopReason? }` | The turn is over: `complete`, `awaiting_approval`, `present_options`, `time_limit`, `output_limit` or `step_count` when it ended by itself; `user_stop`, `superseded` or `deadline` when it was stopped. |
| `error` | `{ code, message }` | The turn failed: `RATE_LIMIT`, `SERVICE_UNAVAILABLE`, `MODEL_TIMEOUT`, `TURN_TIMEOUT`, `TURN_DEADLINE_EXCEEDED`, `TURN_REFUSED` or `WORKER_ERROR`. `message` is a fixed line for the code; the cause stays in your logs. |

The stream is written from the turn's own events as the room receives them (`TurnHost.observe`): the same text, from the same model call. Before the stream opens, a refusal is a status and `{ error: { code, message } }`: `400 INVALID_REQUEST` naming the field, `401 UNAUTHORIZED`, `404 UNKNOWN_CLIENT_REF`, `405`, `409 TURN_RUNNING`, `413 BODY_TOO_LARGE`, `415`, `500 RESOLVE_FAILED` (your `resolveTurn` threw, or returned a target that is not a turn; nothing ran) and `503 UNAVAILABLE`.

**Barge-in.** When the person speaks over the reply, the call service closes the connection. The turn is stopped as a superseding message stops it (`stopReason: 'superseded'`): what it had produced is stored with the mark and announced to the room, and the next request names it in `supersedes`. A stop asked for through the realtime server (the person's Stop on a page) is heard too, and that stream ends with `done`.

Keep the turn's deadline (`turnDeadlineMs`) and the model to a call's pace: a voice turn waits on its first `text` event, so run it on the container adapter, never behind a queue.

## Conversation history in the browser

`agent-sdk-react` restores a tab's conversation after a reload, and lists or switches conversations, when your API provides two endpoints behind `AgentClientConfig`. Both must be filtered by the signed-in user:

- `listConversations`: the user's conversations, most recent first.
- `getConversation`: one of them, with its messages.

## API tools from an OpenAPI document

`loadOpenApiTools` turns the product's own OpenAPI 3 document into tools for backend, MCP and external agents. There is no second manifest format. It is also exported at `@ouispec/agent-worker/openapi`.

```ts
import { loadOpenApiTools } from '@ouispec/agent-worker/openapi';

const tools = loadOpenApiTools(document, {
  baseUrl: 'https://api.example.com',
  audience: 'agents',                        // or 'pa': only operations flagged pa: true
  actAs: (ctx) => signedAssertionFor(ctx.userId, ctx.accountId), // headers; required, no default
});
```

An operation opts in per operation, with `x-agent`:

| Key | Meaning |
|---|---|
| `expose: true` | The operation is a tool. Without it, it is not offered. |
| `effect` | What calling it changes: `view` (a read), `file`, `mutate`, `job` or `transaction`, or the effect's object form. `selection`, `navigate`, `open` and `edit` are a page's effects and are refused. |
| `destructive: true` | On a write: it removes or replaces something the person made. |
| `consequence` | A sentence saying what happens. It goes in the description, and in an approval's preview. |
| `pa: true` | The product's own assistant may call it. Allowed only on a read. |

Each tool:
- is named by the operation's `operationId`, and described by its `summary` and `description`;
- takes its parameters and JSON body as input, with `$ref`s inlined, 3.0 `nullable` read as `null`, and `readOnly` fields left out. A closed object body's fields sit beside the parameters; any other body is the `body` property. The input refuses undeclared properties, and the worker validates every call against it;
- carries `effect` and `destructive` for approvals to key on, and its operation's standard `security` requirement as the permissions it needs;
- calls the API with the headers `actAs` returns, so the API treats the call as that caller. A permission the caller lacks comes back as the route's own refusal. The tool returns it as its error, with the status and body, and the model reads it;
- runs a `transaction` only with the person's approval of that exact call: the worker's approval card supplies it, and its title and consequence come from the operation's `summary` and `x-agent.consequence`. Without one, as over MCP, it returns `APPROVAL_REQUIRED` and sends nothing.

Refused at load, naming the operation: `pa` on anything but a read, a missing or invalid `operationId`, a missing `effect`, an unknown `x-agent` key, `destructive` on a read, a read on `PUT`, `PATCH` or `DELETE`, no security requirement (use `[]` for a public operation), an undeclared security scheme, a non-JSON body, a self-referencing or external `$ref`, and a path whose template and parameters disagree.

**Async operations.** An operation that starts a job names the declared completion it ends with, in `x-async-binding`:

```yaml
x-agent: { expose: true, effect: job }
x-async-binding: { event: report:ready, timeout: 2m }   # optional: failure, correlation, idField
```

- `event` must be a declared completion in the product's event declarations, which are passed as `events`. Its failure and the event's id field (`correlation`) default to what the declarations pair with it.
- The tool reads the job id from the response field named by the event's correlation. When the route returns it under another name, `idField` names that field.
- The wait defaults to the `job` effect's `timeoutMs`, else 60 s.
- An undeclared or non-completion event is refused at load. So are a binding on an operation whose effect isn't `job` or `transaction`, and a binding when no `events` are given.
- With a `waiter` (e.g. `createHttpEventWaiter`), the tool waits for the job to settle and returns `status: 'complete'` with the declared result. A failure fails the call with its declared reason. If the job hasn't settled in time, the call returns `status: 'dispatched'` with the reason. Without a waiter it returns the dispatch.
- The binding's `room`, `payload` and `lifecycleEvents` are documentation: the declarations are the authority.

Header parameters are never model input: `actAs` supplies them, and a call fails if it leaves out one the operation requires.

`@ouispec/agent-worker/testing` ships a fixture product's API for tests: an OpenAPI document, its event declarations (`DESK_EVENTS`), and a server that enforces its own auth and permissions. Its report export is a job, and `onReportQueued` lets a test end it with a declared event.

## The socket in the browser

`agent-sdk-react` connects to the realtime server through `realtime.createSocket`. The default is a Socket.IO client. Any `SocketLike` works: it must emit `connect` on every (re)connection and `disconnect` when it drops. That same socket carries the tab's OUI transport.

## Testing

- `pnpm test` includes the fixture turn. It runs on both adapters and on two providers, replaying recorded responses through each provider's real `ai` package, against the SDK realtime server on Redis.
- `pnpm record:fixture-turn` re-records the Bedrock responses from a live model.
- `pnpm eval:live` runs the live operating-rules eval.
- Both of those live commands need Bedrock credentials in the environment.

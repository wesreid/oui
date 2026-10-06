# @ouispec/agent-worker

The agent runtime. One core runs a turn: the model, the tool loop, UI actions answered by the user's own tab (ADR-0209), streaming, retries and deadlines. Two host adapters run that core: Lambda + SQS, and a long-running container (ADR-0227 §2.1).

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
- `maxTokens`: 4096
- `temperature`: 0.3
- `toolTimeoutMs`: 30 s
- `turnDeadlineMs`: 14 min (keep it below your host's own limit)
- `retries`: 3

Policy hooks: `turnPolicy`, `toolPolicy`, `uiActions`, `approvals`, `stops`, `logger`.

## What a UI client sends with a turn

Two keys on the turn's `context` are for the worker itself, and your persona or `systemPrompt` callback never sees them:

| Key | What the tab puts there | What the worker does with it |
|---|---|---|
| `oui` | Its surface snapshot: `ouiRuntime.snapshot()` (ADR-0209) | Builds the turn's UI tools from it, and from nothing else |
| `uiKnowledge` | Its generated knowledge for the page the user is on: `resolveKnowledge(generatedKnowledge, path)` from `@ouispec/bindings` | Renders it after your prompt: each entry under "Platform Knowledge", then each recipe under "Active Workflows" |

Every other key is the page's context, which a persona prompt shows as the current UI state. A malformed `oui` or `uiKnowledge` fails the turn, naming the bad field. The worker logs `UI surfaces for this turn` with the surface ids and the knowledge's entry and workflow counts.

## Approvals (ADR-0228)

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

A turn that reaches its deadline (`turnDeadlineMs`) ends on the same path, with `stopReason: 'deadline'`: what it did before it ran out of time is kept, marked, and the next turn is told. If its store fails or does not finish in time, nothing of it was kept: the runner records it with `recordTurnFailure` as `TURN_DEADLINE_EXCEEDED`, and its outcome carries `stored: false`. A store that timed out may still finish after that, so record the failure only over a turn that is still running (a conditional update from `running`).

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
| `GET /health` | The worker's status, running turns, capacity and model. |

`onTurnEnd` receives each turn's outcome.

## Conversation history in the browser

`agent-sdk-react` restores a tab's conversation after a reload, and lists or switches conversations, when your API provides two endpoints behind `AgentClientConfig`. Both must be filtered by the signed-in user:

- `listConversations`: the user's conversations, most recent first.
- `getConversation`: one of them, with its messages.

## API tools from an OpenAPI document

`loadOpenApiTools` turns the product's own OpenAPI 3 document into tools for backend, MCP and external agents (ADR-0181 §2). There is no second manifest format. It is also exported at `@ouispec/agent-worker/openapi`.

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
| `effect` | What calling it changes (ADR-0226 §2.6): `view` (a read), `file`, `mutate`, `job` or `transaction`, or the effect's object form. `selection`, `navigate`, `open` and `edit` are a page's effects and are refused. |
| `destructive: true` | On a write: it removes or replaces something the person made. |
| `consequence` | A sentence saying what happens. It goes in the description, and in an approval's preview. |
| `pa: true` | The product's own assistant may call it. Allowed only on a read (ADR-0227 §2.1). |

Each tool:
- is named by the operation's `operationId`, and described by its `summary` and `description`;
- takes its parameters and JSON body as input, with `$ref`s inlined, 3.0 `nullable` read as `null`, and `readOnly` fields left out. A closed object body's fields sit beside the parameters; any other body is the `body` property. The input refuses undeclared properties, and the worker validates every call against it;
- carries `effect` and `destructive` for approvals to key on, and its operation's standard `security` requirement as the permissions it needs;
- calls the API with the headers `actAs` returns, so the API treats the call as that caller. A permission the caller lacks comes back as the route's own refusal. The tool returns it as its error, with the status and body, and the model reads it;
- runs a `transaction` only with the person's approval of that exact call (ADR-0228): the worker's approval card supplies it, and its title and consequence come from the operation's `summary` and `x-agent.consequence`. Without one, as over MCP, it returns `APPROVAL_REQUIRED` and sends nothing.

Refused at load, naming the operation: `pa` on anything but a read, a missing or invalid `operationId`, a missing `effect`, an unknown `x-agent` key, `destructive` on a read, a read on `PUT`, `PATCH` or `DELETE`, no security requirement (use `[]` for a public operation), an undeclared security scheme, a non-JSON body, a self-referencing or external `$ref`, and a path whose template and parameters disagree.

**Async operations (W9).** An operation that starts a job names the declared completion it ends with, in `x-async-binding`:

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

# @ouispec/agent-worker

The agent runtime. One core runs a turn: the model, the tool loop, UI actions answered by the user's own tab, streaming, retries and deadlines. Two host adapters run that core: Lambda + SQS, and a long-running container. A third entry point, the live-call handler, lets a service that runs a voice call reach the same agent ("Live calls").

## What the host supplies

A missing value fails when the adapter is created, and the error names it. Nothing falls back to an environment variable or an empty string.

| Seam | Config | Notes |
|---|---|---|
| Model | `model` | Any `ai` library model: `bedrock(...)`, `openai(...)`, `anthropic(...)`, or a gateway id. The worker imports no provider itself. |
| Prompt cache | `promptCacheBreakpoint`, optional | Provider options that mark a cache breakpoint. `PROMPT_CACHE_BREAKPOINTS.bedrock` and `.anthropic` are provided. Omit it for a provider that caches on its own. |
| Realtime server | `realtime: { url, apiKey }` | The `agent-sdk-realtime` server and its internal key. Turn events go to `POST {url}/api/emit`, and UI action answers are collected from `GET {url}/internal/oui/action-results/:id`. The key is a string, or a getter that reads it from your secret store (see "The realtime key from a secret store"). |
| Persona | `persona` or `systemPrompt`, exactly one | The assistant's identity comes only from here. The shipped rules name no product. |
| Tools | `tools` | A list, or a per-turn resolver. Pass `[]` when the only tools are the tab's UI actions. |
| Persistence | `getDb`, `getHistory`, `persistMessages` | `getDb`'s handle is passed to every callback. `recordTurnStart`, `recordTurnComplete` and `recordTurnFailure` are optional. See "Stopping a turn" for what each is told of a stopped or superseding turn. `persistMessages` is given the digest of the page the turn's message was sent from (`pageAtStart`): store it on that message and hand it back with it ("What history keeps of the pages"). |

Optional tuning, with its defaults:
- `maxRounds`: 12
- `maxTokens`: 32,000 per model response, thinking included. A step cut off there before it says or calls anything runs once more, told to plan less; if that is cut off too, the person is told and the turn ends with `stopReason: 'output_limit'`.
- `temperature`: 0.3
- `modelProviderOptions`: none. Provider options sent with every model call of every turn, e.g. a summary of the model's thinking (`{ amazonBedrock: { additionalModelRequestFields: { thinking: { type: 'adaptive', display: 'summarized' } } } }`). Keep them the same for every turn: a thinking setting that changes between calls invalidates the prompt cache. Whatever it is set to, each thinking block's start and end go to the turn's room (`agent:reasoning_started`, `agent:reasoning_ended`), and a summary the model returns streams between them (`agent:reasoning_delta`). None of it is stored with the conversation.
- `forcedToolChoice`: true. Set `false` for a model that refuses a forced tool choice (Claude Sonnet 5.5 answers 400 to one): a step the turn policy forces to a tool is given only that tool and told to call it.
- `requireReplyBeforeChoice`: false. Set `true` when the panel shows the reply as the answer and a choice card as the question that follows it. A `present_options` call made before the turn has written a word is then sent back once (`REPLY_BEFORE_CHOICE_ERROR`: write the reply, then offer the choice again). A second empty choice goes through with what its card says first (`context`) said as the turn's reply, so a turn never ends with neither a reply nor its choice, and never loops. Whatever it is set to, a choice, confirmation or decision ends the turn only when its call ran: one refused, invalid or sent back hands the step back to the model. A tool policy is told what the turn has written so far (`ToolPolicyContext.replyText`), and a turn policy each step's `text`.
- `toolTimeoutMs`: 30 s
- `turnDeadlineMs`: 14 min (keep it below your host's own limit)
- `handBackReserveMs`: 30 s, at most a quarter of `turnDeadlineMs`. Before each step the worker checks that a step as long as the turn's longest so far, plus this reserve, still fits before the deadline. When it does not, that step is the turn's last: the model is told to say what is done and what is left and to offer to continue (with `present_options` when the host gives it, in words otherwise), the host's turn policy is not asked about it, and the turn ends with `stopReason: 'time_limit'`. A policy's optional `timeHandBack({ turn, canOfferChoices })` can hold that last step to its own note and tool choice instead (a short status in words, `toolChoice: 'none'`, for a person who asked the agent to carry on without stopping, so the client continues the work); returning undefined keeps the offer to continue. The deadline itself still stops a step that runs longer than any before it.
- `retries`: 3

### The realtime key from a secret store

`realtime.apiKey` can be a getter instead of a string, so the key never sits in your function's configuration or your deploy template, and a rotated key reaches a running worker without a restart:

```ts
realtime: {
  url: env.REALTIME_URL,
  apiKey: () => readSecretField('closure/dev/internal-service-keys', 'REALTIME_API_KEY'),
  apiKeyMaxAgeMs: 30_000, // the default
},
```

- The getter (`() => string | Promise<string>`) is called on the first request, not at start-up, and its answer is kept for `apiKeyMaxAgeMs`. Every client the runtime builds (the turn's events, UI actions and their answers, approvals, the stop watch) shares that one cache.
- When the realtime server refuses the key (401 or 403), the getter is called again at once; if it answers a different key, the request is sent once more with it. A request the server refused did nothing, so this is safe for every route.
- A getter that throws, or answers an empty string, while a key is held leaves that key in use (logged as a warning, never with the key) and is called again on the next request. With no key held yet, the request fails.
- A string works exactly as before and is never re-read.

The clients you build yourself (`createHttpConversationClient`, `createHttpApprovalStoreClient`, `createHttpEventWaiter`, `createHttpUIActionChannel`, `createHttpTurnStopClient`, `createHttpEmitAdapter`) take the same three forms for `apiKey`: a string, a getter, or a `RealtimeKeySource` from `createRealtimeKeySource(getter, { maxAgeMs })` to share one cache between several of them.

### How replies are written

A persona's `overrides.communicationStyle` sets the tone and the format of its replies: a preset, or a preset and a format.

```ts
const persona: AgentPersonaConfig = {
  name: 'Ava',
  identity: 'You are Ava, the dealership’s assistant.',
  overrides: { communicationStyle: { preset: 'concise', format: 'plain' } },
};
```

| Field | Values | Default |
|---|---|---|
| `preset` | `conversational` (friendly, collaborative), `concise` (short, direct), `formal` (professional, structured) | `conversational` |
| `format` | `markdown`: rich markdown (bold, headings, bullet lists, tables), for a panel that renders it. `plain`: plain text, for a channel that shows the reply exactly as written, such as a web chat that renders no markdown or a text message | `markdown` |

`communicationStyle: 'concise'` is the concise preset in markdown, as it always was, and a persona that names no style gets the conversational preset in markdown: the prompt is unchanged for every persona that does not ask for `plain`.

With `format: 'plain'`, the markdown lines are replaced. The model is told to write short, natural sentences; to use no markdown syntax of any kind (no bold or italics, headings, bullet or numbered lists, tables, code, block quotes, rules or link syntax); to say several items in a sentence and compare things in words; to say what matters in tool data in sentences; and that this holds whatever the formatting of the prompt or its examples. The concise preset's "bullet points over paragraphs" becomes one or two short sentences, and the formal preset's "numbered lists and clear headings" becomes a few short paragraphs in a clear order. The few-shot examples and workflows are labelled without bold (`User:`, `Assistant:`, `Trigger:`). No other part of the prompt the SDK writes, and no description of the SDK's own tools, asks for markdown; what your persona's own text says (its identity, instructions, knowledge and examples) is yours to keep plain.

The format is part of the system prompt, so it stays the same on every turn of a runtime, as the prompt cache needs: a channel that needs plain text (SMS, a dealer's web chat) gets a runtime whose persona asks for it, rather than a format that changes turn by turn. A live call's turn is also told, in the turn's context, that its reply will be spoken ("What a UI client sends with a turn", `output`); in plain text the two agree, and the system prompt is the same on the call as in the chat. A preset or format the worker does not know, in the object form, fails when the adapter is created, naming it. A `systemPrompt` callback writes its own prompt, so the option does not apply to it. `resolveCommunicationStyle`, `COMMUNICATION_STYLES` and `COMMUNICATION_FORMATS` are exported for a host that reads the setting itself.

### How much the agent says while it works

A persona's `overrides.narration` says who decides how much the agent writes before a tool call, between steps and after a step that fails.

| Value | The rules say | When to use it |
|---|---|---|
| `brief` (default) | At most one brief line before a tool call, one short sentence of narration, no text between tool rounds, and a pivot past a failure without narrating it | Every persona that names no narration: its prompt is unchanged, byte for byte |
| `host` | What holds at any amount: only words for the user, never reasoning, never a result a tool has not returned, never the same answer twice. One section says the amount is "the instruction on how much you say while you work", which the host sends with a turn; a turn sent without one is held to the host's `narrationDefault`, or, with none, to one brief line. The host rules add a handful of characters to the brief prompt | A host that lets the person choose how much the agent explains, such as a setting from "explain as you go" to "results only" |

```ts
const persona: AgentPersonaConfig = {
  name: 'Ava',
  identity: 'You are Ava, the dealership’s assistant.',
  overrides: {
    narration: 'host',
    // The default level, stated once in the cached system prompt: a turn at it sends no instruction.
    narrationDefault: '- Before each distinct step, say in one or two sentences what you will do and why.\n- After a failed step, say what happened and what you will try next.',
  },
};

// getHistory: an instruction in the turn's context only at another level, which replaces the default.
getHistory: async (conversationId, db, turn) => ({
  messages: await load(conversationId),
  stepContext: level === 'results' ? '## How much you say while you work: results only\n- Write nothing while you work; give the result once, at the end.' : null,
}),
```

`narrationDefault` is the text of the default level, one bullet per line and no heading: the rules say a turn's instruction replaces it, and hold a turn that comes without one to it in place of the one brief line. A host whose people mostly keep the default sends nothing with those turns, and its default sits in the cached prefix rather than in every turn's context. Keep it to what the level asks while the work goes on; a line that asks the agent to check its own work makes it read the page again after every step that succeeded. A default without `narration: 'host'`, or an empty one, fails when the adapter is created, and `resolveNarrationDefault` reads it as the worker does.

The setting is part of the system prompt and the instruction is part of the turn's context ("How a turn is assembled"), so the system prompt is the same at every level and a change of level keeps the cached conversation. A persona that names no narration is sent the same prompt, byte for byte, as before either option existed. A value the worker does not know fails when the adapter is created, naming it. `resolveNarration` and `NARRATION_SETTINGS` are exported for a host that reads the setting itself, and `getBaseRules`, `getCommunicationRules` and `getToolStrategyRules` take it as their last argument.

A host that fits its stored history loads `@ouispec/agent-worker/history` (`answerWithoutState`, and `withPageAtStart` for a message's page note): a module with no runtime imports, which also answers a CommonJS resolver.

Policy hooks: `turnPolicy`, `toolPolicy`, `uiActions`, `approvals`, `stops`, `logger`, and the hooks every turn passes through, `beforeTurn` and `filterEvent` ("Hooks on every turn").

## What a UI client sends with a turn

Four keys on the turn's `context` are for the worker itself, and your persona or `systemPrompt` callback never sees them:

| Key | What the tab puts there | What the worker does with it |
|---|---|---|
| `oui` | Its surface snapshot: `ouiRuntime.snapshot()` | Builds the turn's UI tools from it, and from nothing else. When the snapshot names a lookup (`lookup: ["find", "guide"]`, oui-spec §7.3.10: the tab gave `connectBindings` its `knowledge`), it also offers `ui_find`, which searches every action of the whole app through the tab, and `ui_guide`'s `page`, which reads another page's knowledge without going there |
| `uiKnowledge` | Its generated knowledge for the page the user is on: `resolveKnowledge(generatedKnowledge, path)` from `@ouispec/bindings` (with `{ allows }` in a build that serves several brands, so the map names only the pages the person may see) | Renders it after your prompt: the app's map (`map`) first, as its own section under "The App", within `APP_MAP_PROMPT_CHARS` (10,000), then each entry under "Platform Knowledge", then each recipe under "Active Workflows". The map is the same on every page of a build, so it is read from the prompt cache. With `ui.knowledgePlacement: 'index'` (below), only the map is in the system prompt |
| `input` | How the person entered the message, when they did not type it: `{ mode: 'voice', language }` for one they spoke, with the language the recogniser detected. `@ouispec/agent-react` sets it from `sendMessage(text, { input })` | Adds one line to the turn's context ("How a turn is assembled"): the message was spoken and machine-transcribed, so it may contain recognition errors; the language; and to ask rather than guess when a likely mis-hearing makes the request ambiguous. An unknown mode is read as typed, and a language that is not a BCP 47 tag of at most 16 characters is left out (`readMessageInput` in `@ouispec/agent-core`). A typed message, and the turn an approval card's click starts, get nothing |
| `output` | How the reply reaches the person, when it is not shown as text: `{ mode: 'voice' }` when a voice reads it out, with `voiceDirections: { engine, tags, guidance }` when that voice can be directed by inline tags. The live-call handler sets it from the call's request | Adds one line to the turn's context: the reply will be heard, not read, so short plain sentences; no markdown, lists, headings, links, code or emoji; numbers, prices, dates and times written as they are said; anything the person should look at shown through the page's actions rather than read out; and a few words before a slow lookup. With `voiceDirections`, the same line offers the engine's tags, written exactly as given, says they are performed rather than read out and that no other tags are used, and ends with the service's `guidance`. An unknown mode is read as a shown reply, which gets nothing, and malformed directions (an empty tag list, a tag or engine with a control character, guidance over 2,000 characters; `VOICE_DIRECTIONS_LIMITS`) are left out while the reply is still spoken (`readReplyOutput` in `@ouispec/agent-core`). It applies on every turn of a call, the turn that continues an approval included |

`timeZone` (the user's IANA zone, which `@ouispec/agent-react` sends with every turn) is read by the worker too: the date and time on the user's clock open the turn's context.

What is true only for this turn (the clock, how the message was entered, how the reply is delivered) is the turn's context: it goes with the turn's message, never in the system prompt or in a stored message ("How a turn is assembled"). The system prompt, the tools and every stored message stay byte for byte the same whatever the turn says, so a conversation's chat turns and call turns read the same prefix. Store `input` with the user's message if your chat shows how a message was entered (`AgentStoredMessage.input`); the history the worker reads needs no copy of it.

Every other key is the page's context, which a persona prompt shows as the current UI state ("CURRENT UI CONTEXT", as JSON). A persona whose context is not a page renders it itself: `persona.renderContext(ctx)` returns the section to end the system prompt with, or null (or blank) for none, and is given the context without the four keys above. It renders into the system prompt, the start of the cached prefix, so render nothing that changes from turn to turn unless the conversation's context did. A malformed `oui` or `uiKnowledge` fails the turn, naming the bad field. The worker logs `UI surfaces for this turn` with the surface ids and the knowledge's entry and workflow counts.

## How a turn is assembled

Each step of a turn (each call to the model: the first, and one after every round of tool calls) sends, in this order:

1. **The system prompt**, with a cache breakpoint, then the page's index (`<page_index>`) when the client has a page, with its own. A surface whose action ids share a start (`vector_studio_` on every action of a 189-action studio) says it once, in its heading (`sharedPrefixNote`), and its lines give the rest of each id; `ui_act`, `ui_describe` and an action called as a tool take either the full id or a line's name (`resolveActionName`), and refuse a name that two surfaces' actions end in, listing their full ids. Everything read away from the headings (what an answer says the page now offers, errors, `ui_find`) names actions by their full ids. The same on every step that offers the same tools, and on every turn on the same page.
2. **The conversation** as the host stored it, ending with the turn's own message: the person's words, or the instruction that stands for them (a call's opening, glance, capture update or device update). A message the person sent from a page carries a short note on what that page showed (`<page_at_start>`, "What history keeps of the pages").
3. **The turn's context**, straight after the turn's message: what is true for the whole turn and for no other. In this order: the clock (`<now>`), how the message was entered (`<input>`), how the reply is delivered (`<output>`), whether the model can look at the caller (`<vision>`, a glance's observation included), the photo plans and the running capture (`<capture>`), the device the call is on and whether it can move (`<handoff>`), calls whose approval expired, and the host's `stepContext` (what `getHistory` returns beside the messages: an index of work notes, a dealer's notes on what the customer needs). Every step sends it in the same place, in the same words.
4. **The turn's rounds so far**: each round's text and tool calls, then their results. A cache breakpoint moves with the end of the conversation: on the turn's context on the first step, then on the newest result, so each step reads all of the step before it from the cache.
5. **What is true for this step only**, after that breakpoint, when there is any: the page's state (`<page_state>`: the page as the user's screen sent it, then as the newest answer that carried it left it), the page's knowledge by title with the `index` placement (`<page_knowledge>`, below), and the step's notes (`<step_note>`: the turn policy's `note`, a forced action, the turn's record after a call that failed, a step that has to plan less).

So nothing in the user's role follows a tool result except the page's state and the step's notes, each in its own tags, and a UI answer that gave its state up says where it is. The turn's context never does. Sent after a result, it reads as the person's newest message, and the model answers that instead: Claude Haiku 5.5 with thinking off told a caller "your message came through blank", or went back to an earlier question, and dropped what `look` had said, in 14 to 20 of 20 answers to "What am I wearing?" with the host's notes about "their newest message" and an appointment question still open. With the context beside the turn's message it answered from the look in 20 of 20, with and without a page beside the call (`evals/turn-context.live-eval.ts`). A framed `<turn_context>` block after the result, explained in the system prompt, did no better.

What is stored is only the person's message and the model's rounds, so the next turn sends the conversation as the host stored it, without this turn's context. It reads from the cache everything up to this turn's message, and writes this turn's calls and results to it once more, after which they are read like the rest.

`turnContextPlacement` (on the runtime config and `AgentWorkerConfig`) chooses where the turn's context goes:

| Value | Where | |
|---|---|---|
| `'with-message'` (default) | Straight after the turn's message, on every step | Safe for every model. The next turn writes this turn's tool calls and results to the cache once more. |
| `'after-conversation'` | After the conversation's end on every step, before the step's notes: where 0.30 and earlier sent it | The next turn reads all of this one from the cache. After a tool result, the context reads as the person's newest message. Choose it only for a model that `evals/turn-context.live-eval.ts` (`EVAL_MODEL_ID`) shows answering from its tool results with it. |

A placement the worker does not know fails when the adapter is created, naming the ones there are (`TURN_CONTEXT_PLACEMENTS`). Context that should reach the model on one step only goes in a turn policy's `note`, never in `stepContext`.

`knowledgePlacement` (`ui.knowledgePlacement` on `AgentWorkerConfig`, `uiActions.knowledgePlacement` on the runtime config) chooses where the page's knowledge goes (`uiKnowledge`'s entries and workflows; the app's map is in the system prompt either way):

| Value | Where | |
|---|---|---|
| `'prompt'` (default) | In the system prompt after the map, within `KNOWLEDGE_PROMPT_CHARS` (12,000): small entries whole, large ones cut at a line, workflows by name when they do not fit | As before this option, byte for byte. The system prompt changes with the page, so a turn sent from another page writes the prompt cache again from its first byte. |
| `'index'` | The system prompt carries the map only. After the conversation, beside the page's state, `<page_knowledge>` lists the page's entries and workflows by title (`knowledgeIndexText`), and the model reads each with `ui_guide` (`entry`, `workflow`, or `page` for another page) | The system prompt is the same on every page of a build (for a brand, with `allows`), so it is read from the cache. The page's knowledge costs nothing until the model reads a part of it. |

An unknown placement fails when the adapter is created (`KNOWLEDGE_PLACEMENTS`).

### What history keeps of the pages

A UI answer gives its page state up as it arrives: the stored answer, and the answer every later step and turn is sent, says `pageState: "…the page as it is now"` where its state was (`answerWithoutState`), and the page's newest state goes after the conversation. Before 0.38 nothing else of a page survived, so once the page had moved on a later turn could not say what an earlier page had shown, and the model took back answers that had been true. Since 0.38 history keeps a digest of each page, made once and never changed:

- **Each UI answer** carries `shown`, beside `state`: a digest of the page it showed. `answerWithoutState` takes out only `state`, so `shown` is stored and sent again in the same words, and an answer once sent still never changes. Work that ended after its turn (a resumed turn) and a stopped turn's answers keep it the same way.
- **Each turn** gives the digest of the page its message was sent from (the `context.oui` snapshot) as `pageAtStart`: on `AgentTurnResult`, to `beforeTurnComplete`, and to `persistMessages`. Write it on the turn's stored user message and hand it back in history as that message's `pageAtStart` (`TurnHistoryMessage`). The model reads it as a note after the message's text (`pageAtStartNote`: `<page_at_start>When this message was sent, the page showed: …</page_at_start>`), and the turn sends its own message with it on every step in the same words, so the conversation up to that message is read from the cache in the next turn. A history that drops it reads that message differently from the turn that sent it, which writes the message to the cache once more. A turn with no page, no message of the person's (an approval's continuation, a resumed turn) or no digest has none.

The default digest (`pageDigest`) is deterministic and at most 600 characters (`uiActions.maxStateDigestChars`, `DEFAULT_STATE_DIGEST_CHARS`): the surface acted on first, then the page's own surfaces, the shells last; for each surface its id, then each display's facts by label, and each list's count and its first rows' titles (`DIGEST_FIRST_ROWS`, 3). Problems, job statuses and field values are left to the page state.

```
page:lead — Lead (Name: Maria Alvarez; Source: Website; Vehicle: 2021 Rogue S); leads.open: 4 (Maria Alvarez, Tom Lee, Ana Diaz, …) | shell:app — nav.accounts: 2 (Main store, Second store)
```

A product chooses what it keeps with `uiActions.stateDigest` (`AgentWorkerConfig.ui.stateDigest`):

```ts
uiActions: {
  // The facts your persona quotes, or null to keep no digest of that page.
  stateDigest: (observations, { surfaceId, schemas, at }) => leadFacts(observations) ?? null,
  // A name for what it writes: change it whenever what it writes changes.
  stateDigestId: 'lead-facts-v1',
  maxStateDigestChars: 400,
},
```

It is called once for each answer (`at: 'answer'`, with the surface acted on) and once for the page a turn began on (`at: 'pageAtStart'`, `surfaceId: null`); what it returns is cut to the bound. A throw, or anything but text or null, keeps no digest and is logged. `stateDigest: false` keeps none at all, as before 0.38. A setting that is neither a function nor `false` fails when the adapter is created.

A function has no form a recording can be fingerprinted by, so `@ouispec/agent-evals` fingerprints it by `stateDigestId`: a recording made with another name is stale, and a function with no name is refused, naming the field, before any case runs. The worker itself never reads the name. With no function, fingerprints are what they were.

The digest is for the model's memory of what the person saw, not for pasting into a reply. Turning it on changes what is stored and sent: recorded evals (`@ouispec/agent-evals` cassettes) are recorded again, and the eval expectation `history` holds a later turn to a fact of an earlier page.

### What a step is told about tools

A turn policy can hold a step to some of the turn's tools (`activeTools`), to none (`toolChoice: 'none'`), or make it call one (a forced `toolChoice`). Everything the SDK tells that step names only the tools it offers: its rules in the system prompt (the tool strategy's choice rules name `present_options`, the UI rules name `ui_act`, `ui_describe` and `ui_read`), the page index's line on running actions, the files note (`attachment_*`), the client's knowledge (`ui_guide`), the search across the app (`ui_find`), the turn's context lines (`look`, `capture_*`, `call_handoff`) and the hand-back note. A rule that names a tool the step does not offer is left out, or said without the tool: a step held to a search is told it cannot look at the caller, start photos or move the call at this step, and is not told how to offer choices. Nova, 2026-11-19: a step held to one tool still read "offer it with present_options", called it beside that tool, and the turn ended with no reply.

The rules a persona's prompt carries (`buildAgentSystemPrompt`) are written once a turn with every tool; the worker takes the ones a step does not offer out of the host's prompt for that step (`systemPromptForTools`), so the host passes nothing. Your persona's own words are yours: an instruction that names a tool is sent as you wrote it on every step. Each piece of the SDK's prompt that names a tool is a `ToolRule` (`prompt/step-tools.ts`), and what a step offers is one value worked out once per step from the turn's tools and the policy's limits. A limited step already sends the provider fewer tools, and the tools come first in the cached prefix, so it costs no cache the limit had not already cost; steps that offer the same tools are told the same words.

A call the model makes all the same, to a tool its step does not offer or to one the turn never had (`AI_NoSuchToolError`), or with input that cannot be read, runs nothing. It goes into the turn's calls that did not run, so it asks the person nothing and ends no turn; the model reads as its result that the tool is not one it can use now (`{ success: false, notRun: true, unavailable: true, error }`, or `invalidInput: true` with the parse error), and answers in words in the same turn; the client is sent a refused call (`agent:tool_call_complete` with `success: false`), and the conversation stores the same result.

Every call's input is validated against the tool's schema before anything else. A list or an object that arrives as JSON text, where the schema takes a list or an object, is read as what it spells when that makes the input valid: a property (`"ids": "[\"a\"]"`), or a call's whole input (`ui_act` given `"input": "{\"item\":\"lyrics\",…}"`). A property whose schema takes a string is never read this way, and text that spells nothing valid is refused as it arrived. The call runs, its answer tells the model to send the value itself next time (`inputNote`), and the turn counts such calls in `coercedJsonString` (on `AgentTurnResult`, the `Turn usage` log and `recordTurnComplete`, only when there were any): each is a call the model would otherwise have made again.

Each model call's times are logged with its tokens: `Step completed` carries `firstTokenMs` (to the call's first token of any kind: reasoning, text or a tool call's input), `durationMs` and `sinceLastCallMs` (from the end of the call before it, or the turn's start, to this call's request: the tools and the worker's own work between them). `Turn usage` carries `timing`: `turnMs`, `firstTokenMs`, `firstTextMs` (when the person could first read text), `modelMs`, `betweenCallsMs` and each call's `callMs`. A model given by its id is not wrapped, so its times are null.

## Hooks on every turn

Every turn reaches the runtime one of four ways: the Lambda adapter, the container's `/turns`, the live-call handler, or your own code calling `runner.run`. Each hook below runs for all of them, and is told which turn it is called for (`AgentTurnInfo`):

| Field | |
|---|---|
| `id` | The turn's id. |
| `channel` | How it came: `lambda`, `container`, `live-call`, or what you pass as `runner.run(payload, { channel })` when you call it yourself (`sms`, `chat`); `direct` when you pass none. |
| `inputMode` | `voice` when the person's message was spoken and transcribed (its context's `input`), else `text`. |
| `language` | The language it was recognised in, a BCP 47 tag, when spoken and the recogniser said; else null. |
| `approvalChannel` | Where the person approves: `ui` (the card), or the conversation channel the payload names. |
| `context` | The context the client sent with the turn, as it came (null when none). Read your own keys from it, and validate them: it is the client's word. |
| `autoContinue` | `context.autoContinue` when the client started the turn itself to carry on the turns before it (1, 2, …), else 0. |

**`beforeTurn(payload, info)`**, on the runtime config, runs before anything else. Return the payload to run, changed or not: the person's words with a card number redacted before the model reads them (`content`), a reshaped context. Store the same redacted copy yourself. Return null to refuse the turn: nothing is read, run, stored or sent to the room, and the runner's outcome is `{ status: 'refused', refusedBy: 'beforeTurn' }` (a live call is answered `error` `TURN_DECLINED`); tell your own client why. The turn's `turnId`, `conversationId`, `userId`, `accountId` and `socketRoom` are not the hook's to change: a returned turn that changes one, or is not a turn, fails it, as a throw does (`agent:turn_error` to the turn's own room).

**`filterEvent(event, data, turn)`**, on the runtime config, decides what of each turn event leaves the runtime: return the payload to send (it is given a copy, so change it freely), or null to send nothing. It runs before the room, before a host that observes the turn, and so before the live-call handler speaks anything: one filter covers the page, the call and the room alike. Mask a phone number in a tool call's `input`, in a readback, or in the reply's text; drop `agent:reasoning_*`. It is synchronous, so events keep their order. It fails closed: a throw, or a return that is neither a payload nor null, drops that event and logs `The host’s event filter failed; the event was not sent`. A tool still runs with the arguments the model gave it: the filter governs what is sent, not what runs. The UI action requests the worker sends the user's own tab are not turn events, and do not pass through it.

**The turn policy** is told the turn too: `classifyTurn(content, history, turn)`, and `turn` on the context of `prepareStep` and `onTurnClassified`. Each call in `prepareStep`'s `steps` says whether its tool ran (`ran`), and when it did not, why (`notRun`: refused, invalid, denied, waiting for approval, or a tool the step did not offer). Decide on what ran: a step that asked for a tool and was refused has not used it.

### The rounds of a turn

The model writes a reply in rounds: text, tool calls, more text. Each `agent:token` names its round (`step`, from 0), and each round's end is sent once all of its text has been: `agent:round_end { turnId, step, calledTools, final, timestamp }`. `calledTools` says the round called tools; `final` says no round follows it, so its text is the turn's last word. A round that ended at an approval, at a choice for the person (`present_options`), at the hand-back for time, on answerless calls (below) or at the last step allowed is final though it called a tool; a round cut off at the output limit having said nothing never is. A round's tool calls (`agent:tool_call_started`) are sent after its text and before its end. A host reply (`runner.reply`) is one final round, and so is the line the person is told when every attempt at a step was cut off.

A consumer that shows or speaks only what the turn ends with, never what the model wrote before a tool call, holds each round's text until its `round_end` and keeps it when `final`. The live-call handler does this with `speak: 'final-round'` ("Live calls"). Text before a tool call is otherwise shown and spoken as it streams, and the shipped prompt tells the model so: at most one brief line for the person before a tool call, or nothing, and never its reasoning.

Update the realtime server with the worker: a server on an older `@ouispec/agent-events` refuses `agent:round_end` as undeclared, and the worker logs each refused emit.

### Tools whose answer the model does not need

Some host tools only record something, and answer only that it was written: a note the agent keeps for itself. Declare such a tool `answerless: true`. A round that writes reply text and whose only calls are to answerless tools, each of which ran and succeeded, is the turn's last: its text is the reply, its round is `final`, and the model is not called again to read the answers. Without the flag, the turn sends the answers back and the model writes once more, which on a turn that ends "reply, then note" is a whole model call that reads the conversation again.

```ts
{ name: 'note', effect: 'edit', answerless: true, description: '…', inputSchema: { … }, execute }
```

Everything else goes on as before: a round with no reply text, an answerless call that failed or did not run (refused, invalid input, waiting for approval), or any other tool called in the same round. The conversation is stored as always, the call followed by its result, so the next turn reads it as it would any other. The flag changes nothing the model is sent (the tool's description and schema are as declared, so the cached prefix is the same); tell the agent in your own rules to make such a call in the round that writes its reply. A turn that ended this way is `complete`; its result, its `Turn usage` log and `recordTurnComplete` carry `answerlessEnd: { tools }`, the answerless tools its last round called.

#### Trailer mode: the note written after the reply

A response ends at a tool call: no text can follow it. A model that makes an answerless call in a round of its own (Claude Sonnet 5.5 and Opus 5.5 write a note alone, whatever the rules say) has written no reply in that round, so the reply costs one more model call that reads the whole conversation again. Declare the tool `trailer: true` as well, and the model writes it into its response, after the reply, as text:

```ts
{ name: 'note', effect: 'edit', answerless: true, trailer: true, description: '…', inputSchema: { … }, execute }
```

```text
I made the chorus brighter and left the verse as it was.

<oui:note>{"kind":"decision","text":"Chorus brighter; verse unchanged."}</oui:note>
```

Text never ends a response, so the reply and the note arrive in one model call.

- **What the model is sent.** The tool's definition is left out of the request. Each round that offers it is taught it in its system prompt instead, by a rule generated from the tool's own description and schema (its fields, an example, the tags). Like the SDK's other tool rules, the rule is in the system prompt only on rounds that offer the tool: a round a turn policy holds to other tools (`activeTools`, a forced choice, `toolChoice: 'none'`) is not told it. It is the same on every round and every turn that offers the tool, so it stays in the cached prefix. On a spoken turn, the voice's "use no other tags" excepts the trailer.
- **What is read.** The worker reads each trailer out of the model's text as it streams, and the trailer becomes the tool's call, which runs, is validated and is refused like any other. Nothing of a trailer reaches the person: not the room's tokens, a voice, a round's end, the stored reply or an eval's `says`. Text is held back only while it could be the start of a tag, and from the opening tag to its closing one. Trailers may be written anywhere in the text, several in a response.
- **What is stored.** The same rows as a round that wrote its reply and called the tool: the reply as the round's text, the call (its id starts `oui_trailer_`, made from the round, its place and the request the round sent), and its result. A host stores and reports it as it does any call.
- **What is sent again.** Every later prompt, in the turn (each round's request) and in the next turns' history, writes the tool's calls back as the trailers the model was taught, as canonical JSON after the reply's text, and takes their results out. So no request ever names a tool it does not declare. A note that was not written is written back as `<oui:note-failed>why</oui:note-failed>`, and the rule tells the model to write it again. A definition is still sent where a provider needs one: when the trailer tools are a request's only tools and its prompt holds other tool calls (Bedrock drops every call and result from a request that declares no tool, and Anthropic refuses one), and for the one request that follows a response that wrote nothing but a trailer.
- **A trailer that cannot be read** (not JSON, not closed when the response ended, more than 5 in a response, or longer than 4,096 characters) writes nothing and shows nothing. The reply has already been shown, and may have been spoken, so the turn ends on it rather than writing it again: the call is stored with its error (`Invalid input for tool note: the note trailer could not be read (…), so no note was written. …`), which is what the next turn reads, and the turn's `Turn usage` log counts the trailers it read and could not read. The same holds for a trailer whose tool refused it or failed.
- **Which tools may be trailers.** Text the model copies from a page could hold a trailer, so only a tool that changes nothing anyone else depends on: answerless, with an object input schema, a name of letters, digits, `_` and `-` (up to 41), an effect no further than `edit`, never destructive and never needing approval. A host's tool policy that would ask for approval of a trailer refuses it. The model must be an `ai` provider model, not an id. Anything else is refused when the adapter is created, or when a resolver gives a turn its tools. Its successful answer is a JSON object with no `error`: that is how a stored result says the note was written.
- **What is reported.** `answerlessEnd` adds `trailer: true` and `trailers` (how many of the last round's calls arrived as trailers), and `failedTrailers` when any wrote nothing.

The same tool listed by `@ouispec/agent-mcp`, or by any host that lists `RegisteredTool`s, is the tool it is: only the agent's own model writes it as a trailer. A host that declares no trailer tool is sent, shown and stored exactly what it was before.

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

Declare a host tool's approval needs on the tool itself: `effect`, `destructive`, `title`, `consequence`, `argsSensitive: false` when its arguments may be logged, and `approvalAudience`, the origin of the API its approved calls go to (see "The receipt an approved call carries"). Without an approval store, such a call is refused and never runs. The runtime uses the realtime server's store unless you pass `approvals.store`.

### The receipt an approved call carries

When the realtime server has receipt keys, redeeming the token also returns a signed receipt, and the approved call carries it to the tool's own API, so that API can refuse any irreversible request no user approved:

- **A generated API tool** sends it as the `OUI-Approval-Receipt` header (`APPROVAL_RECEIPT_HEADER`), on the approved call only, never on another call of the turn. Its audience is the origin of the `baseUrl` it was loaded with, and the receipt names its `operationId`. A header of that name from your `actAs` is dropped.
- **A host tool** finds it on `ctx.approval.receipt`, beside `approvalId` and `argsHash`, and forwards it however its API expects; the header name is the recommended one. Its audience is its `approvalAudience` (an origin such as `https://bookings.example.com`), or, when it names none, the realtime server's `approvals.defaultAudience`. A tool whose `approvalAudience` is not an origin is not asked for approval: the call is refused and never runs.
- **A UI action** gets none: the browser checks its own grant, and a receipt never reaches a browser.

The receipt's audience is fixed when the approval is stored, with the call. It lasts 120 seconds. With a realtime server that has no receipt keys, `ctx.approval.receipt` is absent and nothing is sent. Update the realtime server before the worker: an older one refuses the pending approval's new fields (`audience`, `toolKind`, `operationId`, `accountId`), and no approval can be asked for.

The API verifies it with `verifyApprovalReceipt` from `@ouispec/agent-core`:

```ts
import { APPROVAL_RECEIPT_HEADER, argsHash, verifyApprovalReceipt } from '@ouispec/agent-core';

const checked = await verifyApprovalReceipt(req.get(APPROVAL_RECEIPT_HEADER) ?? '', {
  jwks: 'https://realtime.example.com/.well-known/oui-approval-jwks.json',
  // The tool's input as the worker sent it: every path, query and body parameter by its declared name.
  expectedArgsHash: await argsHash({ dealerId: req.params.dealerId, ...req.body }),
  audience: 'https://bookings.example.com',
});
if (!checked.ok) return res.status(403).json({ code: 'APPROVAL_RECEIPT', reason: checked.reason });
// Single use is yours: act on each checked.claims.jti at most once, and keep it for at least two minutes.
```

Two hooks give you a say before an approval is asked for. Both are told the turn (`turn`, `channel`), the user, account and conversation, and `locale`: the language the person's message was recognised in (on a call, the request's `input.language`), null for a typed message.

- **`approvals.validateBeforeApproval(tool, args, ctx)`** checks the call before it is read back: `{ ok: true }`, or `{ ok: false, error }` to refuse it. A refused call is not stored or shown; the model gets `error` as the call's result (`refusedBeforeApproval: true`) and can correct it, so a booking for a time you never offered is caught before the person approves it, not after. A throw refuses the call too.
- **`approvals.preview(tool, args, ctx)`** writes the approval's display copy in place of the one built from the declaration (`ctx.built`): `{ title, consequence?, arguments, readback, spokenReadback? }`. Redact a value there, and write it in the person's language with dates, times and numbers as words; `spokenReadback` is the readback as a voice should say it, digits grouped for speech, and a live call speaks it in place of `readback`. That copy is what the approval store keeps with the call, what `agent:approval_required` carries to the card, and what is read back. The call that runs is still exactly the model's: the store keeps its original arguments and `argsHash` is over them, so a decision redeems exactly the call the model made. A throw, or an answer that is not a preview within the store's limits (`APPROVAL_PREVIEW_LIMITS`), means the approval cannot be asked for, and the call is not run: the built preview, with the values you meant to remove, is never the fallback.

Of the calls in one response, only the first that needs approval is asked for. While its check and preview are written, a call that arrives waits for the outcome: if the first is refused, the next is checked as if it had come first.

**On a conversation channel** there is no card. Give the turn payload `channel: 'chat' | 'sms' | 'voice' | 'phone'` (default `ui`); a live call's turns are `voice`, or `phone` when your `resolveTurn` sets `channel: 'phone'`. The model is then told that calling the tool sends the customer a readback of exactly its arguments, and the readback, word for word (on a voice, your preview's `spokenReadback` when you wrote one), is the turn's last words: emitted as `agent:token` with `readback: true` and stored as an assistant message, so your channel's adapter sends or speaks it like the rest of the reply. A live call sends it once, as its `readback` event. When your classifier reads the customer's next message as confirming it, decide for them (`ApprovalStoreClient.decide`, or `POST /internal/approvals/:id/decide`, with the channel) and send the continuation turn with the token, as the card would. Your hooks see the channel as `AgentTurnInfo.approvalChannel`.

**An action on the person's page is approved by its card, and on `voice`, `phone` and `chat` by its readback too.** On those channels it is read back like any other call, with its card on the person's screen as well; the worker stores it with the turn's room (`socketRoom`). When you decide a confirming answer for the customer, the realtime server pushes a single-use grant to that room, one tab claims it, and that tab's OUI runtime runs the action when the continuation turn dispatches it: exactly once, and only for the stored arguments. A spoken or texted no declines it, and the card says so. **On SMS** there is no page beside the conversation that the person is looking at, so a UI action stays card-only there: the model is told the card is on their screen, nothing is read back, and the store refuses an SMS approve of it (`channel`). Roll out the realtime server before a worker of this version: an older server refuses the room on an approval.

## A person takes the conversation over

A person on your staff can take a conversation from the agent, answer the customer as themselves, and hand it back. The hold is kept by the realtime server; your API takes and releases it after its own permission check, with `createHttpConversationClient({ url, apiKey })` (`takeOver`, `handBack`, `announce`, `hold`).

- **The agent does not answer a held conversation.** The turn's stop watch asks for its conversation's hold too: a turn running when the conversation is taken over stops at a safe point, keeps what it had produced marked `taken_over`, and its tab is told `agent:turn_complete` with `stopReason: 'taken_over'`; a turn that arrives while it is held makes no model call and stores nothing (`persistMessages` is called with no messages and the `taken_over` marker, so you can settle its row). `runner.reply` does not answer a held conversation either.
- **On a live call** the handler answers a turn of a held conversation with `done { stopReason: 'taken_over' }` and no words, so the call service keeps the character quiet; a turn speaking when it is taken over ends the same way. Quiet the call service's own session too, and store what the person says in the call as `staff` messages.
- **Approvals waiting at the take-over are withdrawn** by the realtime server (`taken_over`); the next turn records each as withdrawn, and none runs or gets a receipt.
- **The staff's words are in the history.** Store a person's message with `role: 'staff'` and its `speaker` (`{ userId, displayName, role? }`), and the take-over and hand-back as `staff` entries with `takeover: 'taken_over' | 'handed_back'` and no content. `getHistory` returns them as `{ role: 'staff', content, speaker, takeover? }`; the model reads them as the business's side of the conversation, under the person's name, never as its own words or the customer's. After the hand-back the agent answers from the whole exchange.
- `historyOf(messages)` maps the messages a turn stored back to the history form, for a host that keeps them as given.

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

## Work that ends after its turn

A UI action that starts work (a job, an export) answers "started", and the call waits for its outcome only briefly (`uiActions.jobWaitMs`, 20 s). Work still going then is reported running; the model may wait for it with `ui_wait`. When it ends after the turn, the person's tab resumes the conversation by itself (`settledWork` in `@ouispec/agent-react`'s client config, wired to oui-spec's `runtime.onSettled`): your `sendMessage` callback receives `resume: { requestIds }` beside an empty `content`. Pass it unchanged to the worker as the turn payload's `resume`, and store no user message for it, as for an approval's continuation. `payloadRefusal` refuses `resume` with anything but 1 to 8 non-empty request ids of at most 200 characters, and `resume` together with `approval`.

The resumed turn takes each request only when the conversation's history holds the tool call with its id and that call's latest result still says it is running, so a client never reads another conversation's results and an outcome is never reported twice. It reads each final answer from the realtime server (kept 35 minutes after the work ended), gives it to the model as that call's result in the words `ui_wait` uses, in place of "still running", and stores it under the call's own id (the first of `newMessages`), so every later turn reads the outcome. In place of a message, the model is told that nobody wrote, why the turn started, and to tell the person what came of the work after checking the page. A final answer that can no longer be read is said so, and nothing is stored for it. When nothing is left to report, the turn completes at once without calling the model. The turn's logs, its usage line, its result (`AgentTurnResult.resumed`) and `recordTurnComplete` (`resumed`) say which requests it reported, could not read, and left out (`ResumedTurn`).

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

`liveCall: { credential, resolveTurn, opening?, speak?, holdingLine?, keepAliveMs?, path? }` serves the live-call route on the same server, runtime and slots: `maxConcurrentTurns` bounds both routes together, a turn id runs once whichever route it came by, and `close` waits for both. Its requests carry the call service's credential, never `workerApiKey`. `path` defaults to `/live-call/turns`.

## Live calls

A service that runs a voice call (it hears the person, transcribes them, and speaks the reply in a character's voice) can be answered by your own agent: its persona, tools, UI actions, approvals and records. Each turn of the call is one HTTP request to a route you mount, and the reply streams back as server-sent events. The turn runs on the same runtime as every other turn, so it still streams to the conversation's realtime room: every page joined to that conversation receives the reply and every UI action, as for a typed message, and the call page can show what the agent is talking about.

```ts
import { createAgentTurnRunner, createLiveCallTurnHandler, liveCallTurnMessage } from '@ouispec/agent-worker';

const runner = createAgentTurnRunner(runtimeConfig);   // the same config as your other turns
const liveCall = createLiveCallTurnHandler({
  runner,
  credential: env.LIVE_CALL_CREDENTIAL,                // or [current, next] while rotating
  resolveTurn: async (request, { signal }) => {
    const conversation = await findConversationByCallRef(request.clientRef);
    if (!conversation) return null;                    // answered 404
    // What the person said, redacted; for an opening, a glance, a capture or a device update, the instruction that stands for it.
    const said = request.kind === 'message' ? redactCardNumbers(request.text) : liveCallTurnMessage(request);
    await storeUserMessage(conversation.id, said, request.input);
    return {
      conversationId: conversation.id,
      userId: conversation.userId,
      accountId: conversation.accountId,
      socketRoom: `conversation:${conversation.id}`,
      context: conversation.pageContext,               // the call page's OUI snapshot and knowledge, as for a typed turn
      content: said,                                   // what the model reads: your redacted copy
    };
  },
  opening: (request, target) => greetingTemplateFor(target.accountId),  // optional; null lets the model greet
  speak: 'final-round',                                // optional; only the round the turn ends with is spoken
  holdingLine: (request) => (request.input?.language === 'es' ? 'Un momento.' : 'One moment.'),
});
app.post('/agent/live-call/turns', liveCall);          // any Node server: (req, res)
process.on('SIGTERM', () => liveCall.close());        // waits for running turns
```

`createLiveCallTurnHandler(config)` returns a Node `(req, res)` handler with `running()` and `close()`. A body that Express's `json()` already parsed is taken as it is.

| Config | |
|---|---|
| `runner` | Required. `createAgentTurnRunner(...)`: the runtime that runs your other turns. |
| `credential` | Required. The bearer credential the call service sends, from your secret store; a list while one is rotated. Compared in constant time. |
| `resolveTurn(request, { signal })` | Required. The call's `clientRef` → the turn's `conversationId`, `userId`, `accountId` and `socketRoom`, with optional `context`, `userToken`, `approval` and `content`; null when you have no such conversation. `content` is what the model reads in place of `request.text`: your redacted copy (the runtime's `beforeTurn` can do the same on every channel). Do here what your API does for a chat message: store the person's message (your redacted copy; for an `opening`, `liveCallOpeningMessage(request)`), claim the turn, and decide on a waiting readback ("Approvals"). `signal` aborts if the caller hangs up meanwhile. |
| `opening(request, target, { signal })` | Optional. A greeting from your template for an `opening` turn: streamed, sent to the room and stored as the turn's one assistant message (`runner.reply`), with no model call. Null, undefined or blank lets the model greet. A throw fails the turn. |
| `speak` | `all` (the default): every round of the reply is spoken as the model writes it, its words before a tool call included. `final-round`: only the round the turn ends with ("The rounds of a turn"): each round's text is held until it ends and sent only when it is final, so nothing written before a tool call is spoken. The reply then starts when its last round is written, not with its first words. |
| `holdingLine` | With `final-round` only: a line of yours spoken once, as the turn's first tool starts (not a choice the turn ends with), so the caller does not wait in silence. A string, or `(request, target)` returning one (localise from `request.input.language`); null or blank says nothing; a throw fails the turn. Set with `all`, the handler refuses to start: there the model's own words before a tool call are spoken. |
| `keepAliveMs` | Default 5 s: a `: keep-alive` comment after this long with nothing written. |
| `maxConcurrentTurns` | Default 8; more are answered `503`. |
| `maxBodyBytes` | Default 384 KiB (`LIVE_CALL_MAX_BODY_BYTES`): room for a turn's longest text with the page's UI context at its 64 KiB bound, and for a call service from before looking that still sends a camera frame of up to 256 KiB (read past). The container adapter's live-call route takes the same, within its own `maxBodyBytes`. |
| `onTurnEnd(outcome)` | Each turn's outcome, after it ends. |

**The request.** `POST`, `Content-Type: application/json`, `Authorization: Bearer <credential>`:

| Field | |
|---|---|
| `sessionId` | The call service's session. |
| `clientRef` | Your conversation reference, given to the call service when the call was created. |
| `turnId` | Unique per turn; the turn runs under it. |
| `kind` | `message`: the person said `text`. `opening`: the call has just connected, `text` is empty, and the agent greets: the model reads `liveCallOpeningMessage(request)` where the person's words would be (`LIVE_CALL_OPENING_MESSAGE` when no disclosure was sent). `glance`: nobody has spoken for a while and the call service's look noticed something; `text` is empty, `client.vision` carries `remarks` on and the `observation`, and the model reads `LIVE_CALL_GLANCE_MESSAGE` ("Vision"). `capture`: something happened in a photo capture; `text` is empty, `client.capture.update` says what, and the model reads `liveCallCaptureMessage(update)` ("Photo captures"). `device`: something happened to the caller's devices (the call moved, came back, was disconnected or lost); `text` is empty, `client.handoff.update` says what, and the model reads `liveCallDeviceMessage(update)` ("Moving the call to another device"). `liveCallTurnMessage(request)` is what the model reads for any kind, and the row to store for it. |
| `text` | What the person said, as transcribed; at most 8,000 characters. |
| `input` | `{ mode: 'voice', language? }` for what the person said: set as the turn's `context.input`, so the model is told it was transcribed. `{ mode: 'text' }` for a message they typed during the call: read as typed, with no `context.input`. Dropped on an `opening`. |
| `output` | `{ mode: 'voice', voiceDirections? }`: set as the turn's `context.output`, so the model writes for the ear, and may use the voice's tags when `voiceDirections: { engine, tags, guidance }` offers them ("What a UI client sends with a turn"). |
| `disclosureLine` | On an `opening`: what the call service has just said to the person before the greeting (that they are talking with an AI assistant), as spoken; at most 1,000 characters. The model is told it was said, and greets following on from it without repeating it. Not read on a `message`. |
| `supersedes` | Turns this one replaces. Each still running in this process is stopped at once, and the turn's `getHistory` is given them to wait for, as for any superseding message. |
| `client` | `{ ui, vision, capture, handoff }`. `ui`: the person's page, when it sent its UI into the call (Closure's `<LiveCall uiContext>`), as its typed turns carry it: `{ buildId?, currentPath?, oui?, uiKnowledge? }`, at most 64 KiB (`LIVE_CALL_LIMITS.clientUiBytes`). Its `oui`, `uiKnowledge` and `currentPath` go on the turn's context under those names, so the turn's UI tools are the page's and its UI actions reach that page through the room, as on a typed turn; a key your target's `context` sets itself is kept. `buildId` stays on `request.client.ui`, for your `resolveTurn` to check against the build you expect. Fields it does not know are read past. Absent, or `ui: null`, for a call with no page (a phone call): the turn has only your context. `vision`: whether and how the character may look at the caller's camera ("Vision"). `capture`: the session's photo plans, the route the capture tools call, the capture running now and what happened in it ("Photo captures"). `handoff`: the route `call_handoff` calls, the device the call is live on, an open offer, and what happened to the caller's devices ("Moving the call to another device"). |

`readLiveCallTurnRequest` reads a body as the handler does, and `LIVE_CALL_LIMITS` holds its limits.

**The response.** `200 text/event-stream`, flushed event by event:

| Event | Data | |
|---|---|---|
| `text` | `{ text }` | The reply; concatenate the pieces. With `speak: 'all'`, as the model writes it: rounds written between tool calls are separated by a blank line, as in the room. With `final-round`, the holding line and the turn's last round. |
| `readback` | `{ approvalId, text, expiresAt }` | The turn stopped at a call that needs approval. `text` is the preview's `spokenReadback` when your `approvals.preview` wrote one, else its `readback`, verbatim; `expiresAt` is ISO 8601. Sent once the turn has ended by itself, after all of its text. A turn that was stopped withdrew its approval, and sends none. |
| `done` | `{ stopReason? }` | The turn is over: `complete`, `awaiting_approval`, `present_options`, `time_limit`, `output_limit` or `step_count` when it ended by itself; `user_stop`, `superseded` or `deadline` when it was stopped. A turn whose reply is nothing (a glance with nothing worth a remark, a capture or device update not worth a word) is `done` alone, with no `text` before it: silence. |
| `error` | `{ code, message }` | The turn failed or did not run: `RATE_LIMIT`, `SERVICE_UNAVAILABLE`, `MODEL_TIMEOUT`, `TURN_TIMEOUT`, `TURN_DEADLINE_EXCEEDED`, `TURN_REFUSED` (your turn record refused it), `TURN_DECLINED` (your `beforeTurn` refused it) or `WORKER_ERROR`. `message` is a fixed line for the code; the cause stays in your logs. |

The stream is written from the turn's own events as the room receives them (`TurnHost.observe`): the same text, from the same model call. Before the stream opens, a refusal is a status and `{ error: { code, message } }`: `400 INVALID_REQUEST` naming the field, `401 UNAUTHORIZED`, `404 UNKNOWN_CLIENT_REF`, `405`, `409 TURN_RUNNING`, `413 BODY_TOO_LARGE`, `415`, `500 RESOLVE_FAILED` (your `resolveTurn` threw, or returned a target that is not a turn; nothing ran) and `503 UNAVAILABLE`.

**Vision.** The character sees the caller only when it chooses to look: no turn carries a picture, and this worker never receives one. The call service holds the caller's camera for a few seconds, and when the character may see the caller each turn carries `client.vision`:

```json
{ "seeing": true, "remarks": true, "canLook": true, "absent": null,
  "look": { "url": "https://…/api/v1/sessions/{id}/vision/look", "token": "lvl1.…", "expiresAt": "2026-11-15T10:16:30.000Z" },
  "observation": null }
```

`seeing`: the character may see the caller; `remarks`: it may bring up what it sees unprompted (false whenever `seeing` is). `canLook`: it can look now, through `look` (true only with `seeing` and a `look`; the call service sends it only to a brain whose endpoint declares `acceptsVision`). `absent` says why it cannot: `camera_off`, or `turned_off` (the caller or the session turned vision off, with `seeing: false`). `look` is the call service's look route and a token for this session only, sent only over https (or to this machine). It is read as strictly as `client.ui`: a wrong field answers `400` naming it, and no refusal repeats the token. A `frame` from a call service before §2.9 is read past. The handler sets it as the turn payload's `vision` (`TurnVision`; any turn can carry one, `payloadRefusal` checks it), and the worker gives the model:

- with `canLook`, the **`look` tool** (`lookTool`, the SDK's `vision` tool class, a `view`): `look({ question, frames? })`, a question of at most 500 characters about the picture and 1–4 of the newest pictures (default 1). It `POST`s `{ question, frames? }` to `look.url` with `Authorization: Bearer <token>`. The answer, `{ looked: true, answer, frames, newestAgeMs }`, reaches the model beside the call's result for that call only: the stored result is `{ looked: true, pictures, newestSecondsAgo }`, so a later turn that needs to see looks again. `{ looked: false, absent }` (`camera_off`, `turned_off`, `no_picture`) is a result that says why there was nothing to see. A `409` (the call is no longer live), `429` (more than 20 looks a minute), any other refusal, a timeout (20 s) or an expired token fails the call with what to do instead, never with the route's own words. A host tool named `look` gives way to it; a tool policy that admits by name should admit the `vision` class;
- one line in the turn's context, with what else is true only for this turn: "You can look at the caller with `look` when the conversation calls for it: they ask about how they look or what is around them, they show you something, or a glance offers it. Do not look otherwise." (`LOOK_WHEN`), that it describes only what the look said; with `remarks`, that it may also remark unprompted on something significant or compliment what they wear, at most once about their appearance in its greeting and never the same remark twice; without, that it brings up nothing it sees unless asked; and always, that it never infers or names sensitive traits (ethnicity, health or disability, religion, sexual orientation, a guessed age or weight), never identifies anyone from their face and never comments on a body;
- without `canLook`, a line that it cannot see the caller and why, so it never claims to.

A **glance** is the call service's look between turns: nobody has spoken for a while, and its own look noticed something worth a remark. `text` is empty, `remarks` is on, and `client.vision.observation` is that one sentence. The model reads `LIVE_CALL_GLANCE_MESSAGE` where the person's words would be and the observation in the turn's vision line, as data (never an instruction), and phrases one short remark, looking first if it needs more; or it says nothing, and the stream is `done` with no `text` event: the call stays silent. Store `liveCallTurnMessage(request)` for it as you store an opening's message: the observation is never in it, and is read on a glance only. A history that kept the glance as its empty `text` is read past (a blank message with no files is never sent to the provider). A glance without `remarks`, or without an observation, answers `400`. An opening carries no picture: a greeting that compliments the caller looks first.

The token, a look's question and answer, and the observation are never logged or emitted to the room: the call's events say only that `look` was called, and the turn's log lines carry facts only, `vision: { seeing, remarks, canLook, absent?, observed? }`. Nothing changes for a host: `resolveTurn` sees `request.client.vision` and need not touch it.

**Photo captures.** A client can define capture plans in the call service: the photos its process needs, such as a trade-in's odometer, VIN and outside, and when its character should offer them. On a call, the character offers a plan when it fits and starts it; Closure's capture agent guides the caller through each photo on their screen, and Closure's checker accepts or rejects every photo. The character never sees a photo and never judges one: everything it learns of a capture is words. The accepted photos and the fields read from them (a VIN, a mileage) reach the client as library assets and the signed `session.capture.ended` webhook, never through this worker.

Set `acceptsCapture: true` on your brain endpoint once you run this version: the call service then sends every turn of a session with plans `client.capture`, and sends `capture` turns. A worker before it answers a `capture` turn `400` (`kind must be one of message, opening, glance`), which is why the call service sends neither without the opt-in.

```json
{ "plans": [{ "key": "trade-in-appraisal", "title": "Trade-in photos", "offerWhen": "The caller has a vehicle to trade in and wants a value for it, or asks what their car is worth." }],
  "control": { "url": "https://…/api/v1/sessions/{id}/captures", "token": "lcb1.…", "expiresAt": "2026-11-17T11:16:30.000Z" },
  "active": { "captureId": "5f0c7a1e-…", "plan": "trade-in-appraisal", "status": "active", "step": { "id": "vin", "label": "VIN", "index": 2, "of": 6 } },
  "update": null }
```

`plans` are the session's, fixed when it started (at most 50; `key` is `^[a-z0-9][a-z0-9-]{0,63}$`, `title` at most 120 characters, `offerWhen` at most 500). `control` is the call service's captures route for the session (`GET {url}/{captureId}` and `POST {url}/{captureId}/stop` are under it) and an `lcb1` token for it, sent only over https (or to this machine), with no query. `active` is the capture running now (`status` one of `CAPTURE_STATUSES`: `starting`, `awaiting_consent`, `active`, `blocked`, `ending`) or null. `update` is what happened since the brain last heard, in Closure's words: the updates pending since then, joined in order, each at most `CAPTURE_UPDATE_TEXT_MAX` (600) characters; the whole at most 8,000. It is read as strictly as `client.vision`: a wrong field answers `400` naming it, and no refusal repeats the token. The handler sets it as the turn payload's `capture` (`TurnCapture`; `payloadRefusal` checks it), and the worker gives the model:

- while there are plans and a `control` route, the **capture tools** (`captureTools`, the SDK's `capture` tool class, `kind: 'backend'`), which call the route with `Authorization: Bearer <token>`:
  - `capture_start({ plan, resumeCaptureId? })` (a `mutate`): `POST {url}` with `{ plan, resumeCaptureId? }`. `plan` is an enum of the session's keys, and the description lists each plan's title and when to offer it, and tells the model to say one short line before it calls ("I’ll send a photo request to your screen now."). `resumeCaptureId` continues an earlier capture of the plan that did not complete;
  - `capture_status({})` (a `view`): `GET {url}/{captureId}`, for the capture running when the turn began or the one it started; with none, it says so without a call;
  - `capture_stop({ reason? })` (a `mutate`): `POST {url}/{captureId}/stop` with `{ reason? }` (at most 200 characters).

  Each result is `{ captureId, status, outcome?, words }`: the route's `words`, one or two sentences, are what the model says from. A refusal fails with a line chosen by its code, never the route's own words: `CAPTURE_IN_PROGRESS` is "A photo capture is already running; use capture_status.", `RESUME_NOT_ALLOWED` says why by `details.why`, `CAPTURE_AGENT_UNAVAILABLE` gives Closure's `details.words` (its offer included), and `SESSION_NOT_LIVE`, `NO_ROOM_AGENT`, `CAPTURE_PLAN_NOT_FOUND`, `RATE_LIMITED`, `401`/`403`, a timeout (20 s) or an expired token each say what to do instead. No tool returns a picture. A host tool of the same name gives way to them; a tool policy that admits by name should admit the `capture` class;
- one line in the turn's context: "You can ask the caller for photos with `capture_start` when a plan below fits. Closure’s checker accepts or rejects every photo; you never judge a photo, and you never use `look` for one. While a capture runs you receive capture updates: turn each into one or two short, natural sentences in the caller’s language, and never read out a code. When a capture ends without completing, offer what its update says to offer." (`CAPTURE_WHEN`, the clause Closure's own brain is given), that a plan is offered only when its "offer it when" applies, that it never sees a photo and never claims to (`CAPTURE_NEVER`), the plans, and where the running capture stands. Without a `control` route the tools are not offered, and the line says photos cannot be started from this turn.

A **capture** turn passes on what happened in a capture: consent asked, given or declined, the camera, each step, a hint, a photo accepted or rejected, a step skipped or failed, the end. `text` is empty and `client.capture.update` is the words, for example `Odometer accepted: 48,212 mi.` The model reads `liveCallCaptureMessage(update)` where the person's words would be: the update in a `<capture_update>` tag, as data, and the instruction to say it in one or two short sentences, or to say nothing, and the stream is `done` with no `text` event. Every capture that ends without completing (declined, unanswered, the camera blocked or missing, stopped, out of retries, timed out, the guide or the checker unavailable) ends its words with `Offer: …`, the plan's own offer (a link to finish on the caller's phone, say), and the model is told to say what is missing without pushing and to make that offer. Store `liveCallTurnMessage(request)` for the turn, as for an opening: it is a readable row with what happened, so later turns know which photos were taken. An update can also ride a `message` turn (the caller spoke first): it then reaches the model in the turn's capture line, for that turn only, and the person's message is stored as it is. A capture turn without an update answers `400`.

The capture's names and values are those of Closure's capture contract (`@closurestudio/realtime-contracts`, `live-capture`), exported here without depending on it: `CAPTURE_STATUSES` / `CaptureStatus`, `CAPTURE_OUTCOMES` / `CaptureOutcome`, `CAPTURE_END_REASONS` / `CaptureEndReason`, `CAPTURE_BRAIN_UPDATE_KINDS` / `CaptureBrainUpdateKind` (`opened`, `consented`, `declined`, `camera`, `step`, `hint`, `accepted`, `rejected`, `skipped`, `failed`, `ended`) and `CAPTURE_UPDATE_TEXT_MAX` (600). A tool result's `status` and `outcome` are read by them.

The token is never logged or emitted, and neither are an update's words: the turn's log lines carry facts only, `capture: { plans, canStart, active?, step?, update? }`. Nothing changes for a host but the opt-in and the stored row: `resolveTurn` sees `request.client.capture` and need not touch it.

**Picking up where they left off.** `client.capture.resumable` lists the caller's earlier captures of the session's plans that ended without completing and can be continued, newest first (Closure lists at most `CAPTURE_RESUMABLE_MAX`, 5): `[{ captureId, planKey, outcome, endedAt, missingSteps }]` (`CaptureResumable`), where `outcome` is one of `CAPTURE_RESUMABLE_OUTCOMES` (`partial`, `camera_unavailable`, `abandoned`, `failed`: never `completed`, never `declined`), `endedAt` is ISO 8601 or null, and `missingSteps` are the plan's required step ids it has no accepted photo for. Absent reads as `[]`. A malformed entry answers `400` naming it; one of a plan the session does not offer, or missing nothing, is left out, since this call could never continue it. While the turn can start photos, `capture_start`'s description lists each one in the lines Closure's own brain is shown (`- {captureId} (plan {planKey}): {outcome}, ended {endedAt}; missing: {steps}`, `resumableLines`), and the capture line adds the sentence Closure's brain has (`CAPTURE_RESUME_WHEN`): "This caller has an earlier photo capture that was not completed (listed in `capture_start`). When photos fit, offer to finish it: call `capture_start` with its plan and its `resumeCaptureId`, so only the missing photos are asked for." Log lines count them (`capture.resumable`), never name them.

A capture can say why it is `blocked`: `active.blockedReason` is `camera_denied` or `no_rear_camera` (`CAPTURE_BLOCKED_REASONS`). With `no_rear_camera`, the call can move to the caller's phone, and the capture's words say to offer it with `call_handoff` ("Moving the call to another device").

**Moving the call to another device.** A caller on a laptop can carry the same call on to their phone (Closure Studio's call hand-off): the character offers it, a QR code appears on the laptop's screen, the phone opens the link on your own site, and the same conversation carries on there while the laptop pauses. Nothing moves on the server: the session, the room, your conversation and a running capture are the same throughout. The character never sees a device, a screen or a code: everything it learns of a move is words, and it never gets the code or the link.

Set `acceptsHandoff: true` on your brain endpoint once you run this version: the call service then sends every turn of a session whose call can move `client.handoff`, and sends `device` turns. A worker before it answers a `device` turn `400` (`kind must be one of message, opening, glance, capture`), which is why the call service sends neither without the opt-in. Without it, the caller can still move the call with their own **Continue on phone** control; your brain is simply not told.

```json
{ "control": { "url": "https://…/api/v1/sessions/{id}/handoffs", "token": "lhb1.…", "expiresAt": "2026-11-18T11:16:30.000Z" },
  "device": { "formFactor": "desktop", "switches": 0 },
  "offer": { "handoffId": "3c1d9e2a-…", "purpose": "photos", "expiresAt": "2026-11-18T10:26:30.000Z" },
  "update": null }
```

`control` is the call service's hand-offs route for the session and an `lhb1` token for it, sent only over https (or to this machine), with no query. `device` is the device the call is live on (`formFactor` one of `CALL_FORM_FACTORS`: `phone`, `tablet`, `desktop`, `unknown`) and how many times the call has switched devices, or null while no device is live. `offer` is the code on the caller's screen now, or null. `update` is what happened since the brain last heard, in Closure's words: the updates pending since then, joined in order, each at most `DEVICE_UPDATE_TEXT_MAX` (600) characters; the whole at most 8,000. It is read as strictly as `client.capture`: a wrong field answers `400` naming it, and no refusal repeats the token. The handler sets it as the turn payload's `handoff` (`TurnHandoff`; `payloadRefusal` checks it), and the worker gives the model:

- while there is a `control` route, the **hand-off tool** `call_handoff({ purpose })` (`handoffTool`, the SDK's `handoff` tool class, `kind: 'backend'`, a `mutate`): `POST {url}` with `{ purpose }` and `Authorization: Bearer <token>`. `purpose` is `photos` (a photo capture needs a phone's rear camera), `caller_asked` (the caller asked to continue on their phone) or `other` (`CALL_HANDOFF_PURPOSES`). The result is `{ handoffId, status, words }`: the route's `words` are what the model says from ("A QR code is on their screen. Tell them to scan it with their phone's camera…"). It never carries the code or the link, even if an answer did. A refusal fails with a line chosen by its code, never the route's own words (`HANDOFF_REFUSALS`): `HANDOFF_UNAVAILABLE` is "This call can't move to another device.", `HANDOFF_UNSUPPORTED_CALL` is "This call's app can't move to another device.", `RATE_LIMITED` is "A code was offered several times already; ask them to use the one on their screen.", and `SESSION_NOT_LIVE`, `NO_ACTIVE_DEVICE`, `HANDOFF_TOKEN_WRONG_SESSION`, `401`/`403`, a timeout (15 s) or an expired token each say what to do instead. A host tool of the same name gives way to it; a tool policy that admits by name should admit the `handoff` class;
- one line in the turn's context: "You can move this call to the caller's phone with `call_handoff`. Offer it when photos need a rear camera this device lacks, or when the caller would be better off on their phone, and call it once they agree. A QR code then appears on their screen. Never read out a code or a link. While the call moves you receive device updates: answer each with one short sentence, or with nothing." (`HANDOFF_WHEN`, the clause Closure's own brain is given), that it never sees the caller's devices, their screen or the code and never claims to (`HANDOFF_NEVER`), the device the call is live on and how often it has moved, and the open offer. Without a `control` route the tool is not offered, and the line says the call cannot be moved from this turn.

A **device** turn passes on what happened to the caller's devices (`CALL_DEVICE_UPDATE_KINDS`): a code offered from the caller's own control (`offered`), the call moved to the device that redeemed it (`switched`), brought back (`brought_back`), the other device disconnected by "That wasn't me" (`revoked`), a code that expired unused (`expired`), or the live device lost (`active_lost`). `text` is empty and `client.handoff.update` is the words, for example `The caller moved the call to their phone. Their computer is paused. Carry on where you left off.` The model reads `liveCallDeviceMessage(update)` where the person's words would be: the update in a `<device_update>` tag, as data, and the instruction to answer it in one short sentence, or to say nothing, and the stream is `done` with no `text` event. Capture updates that arrived with it ride the same turn: its message is then `liveCallDeviceMessage(update)` followed by `liveCallCaptureMessage(client.capture.update)`. Store `liveCallTurnMessage(request)` for the turn, as for a capture: it is a readable row with which device the call moved to. An update can also ride a `message` turn (the caller spoke first): it then reaches the model in the turn's hand-off line, for that turn only. A device turn without an update answers `400`.

The hand-off's names and values are those of Closure's hand-off contract (`@closurestudio/realtime-contracts`, `live-call-devices`), exported here without depending on it: `CALL_HANDOFF_PURPOSES` / `CallHandoffPurpose`, `CALL_FORM_FACTORS` / `CallFormFactor`, `CALL_HANDOFF_STATUSES` / `CallHandoffStatus`, `CALL_DEVICE_UPDATE_KINDS` / `CallDeviceUpdateKind`, `DEVICE_UPDATE_TEXT_MAX` (600) and `HANDOFF_CODE_TTL_S` (600).

The token is never logged or emitted, and neither are an update's words: the turn's log lines carry facts only, `handoff: { canOffer, device, switches?, offer?, update? }`. Nothing changes for a host but the opt-in and the stored row: `resolveTurn` sees `request.client.handoff` and need not touch it.

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
- runs a `transaction` only with the person's approval of that exact call: the worker's approval card supplies it, and its title and consequence come from the operation's `summary` and `x-agent.consequence`. Without one, as over MCP, it returns `APPROVAL_REQUIRED` and sends nothing. The approved call carries its receipt as the `OUI-Approval-Receipt` header, for the API's origin ("The receipt an approved call carries").

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
- `@ouispec/agent-worker/testing` has what a product's own tests use: `recordingFetch` and `replayingFetch` (recorded model responses through a provider's real package; a recording hands each chunk on as it arrives, so a caller's first-token clock measures the API), `scriptedChatCompletions` (a model whose every answer a test states), `conversationOf` (a request’s conversation without the turn’s context and the step’s tail), and the Desk fixture API.
- Both of those live commands need Bedrock credentials in the environment.

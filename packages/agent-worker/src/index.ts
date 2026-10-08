/**
 * @ouispec/agent-worker — the agent runtime.
 *
 * Hosts provide: the model (any `ai` provider), the realtime server, the
 * persona, tools and persistence callbacks.
 * The worker handles: the multi-round tool loop, UI actions, streaming,
 * retries and timeouts, on Lambda + SQS or in a container.
 */

export type { AgentWorkerConfig, AgentTurnInput, AgentTurnResult, TurnMessage, TurnHistoryMessage, ToolCallRef, SystemPromptContext } from './types.js';
export { historyOf } from './history.js';
export type { RealtimeEmitAdapter } from './emit/types.js';
export { filterEmitAdapter } from './emit/filter.js';
export type { TurnEventFilter } from './emit/filter.js';
export type { ToolRegistry, RegisteredTool, ToolExecutionResult, ToolExecutionContext, ToolCallApproval } from './tools/types.js';
export { createToolRegistry } from './tools/types.js';
export { loadToolsFromSchema } from './tools/schema-loader.js';
export type { LoadToolsOptions } from './tools/schema-loader.js';
// Async tools wait on the product's declared events
export { bindAsyncTool, awaitAsyncTool } from './tools/async-binding.js';
export type { AsyncToolSpec, BoundAsyncTool, AsyncToolSettlement } from './tools/async-binding.js';
export { createHttpEventWaiter } from './events/http-waiter.js';
export type { HttpEventWaiterConfig } from './events/http-waiter.js';
export { loadEntityToolsFromSchema } from './tools/entity-tools.js';
export { loadBuiltinTools } from './tools/builtin-tools.js';
export { loadAllTools } from './tools/load-all-tools.js';
export type { LoadAllToolsOptions } from './tools/load-all-tools.js';
export { createToolInputValidator } from './tools/input-validation.js';
export type { ToolInputValidation, ToolInputValidator } from './tools/input-validation.js';

// API tools generated from any OpenAPI 3 document, each call acting
// as the caller the host's actAs seam names. Also at `/openapi`.
export { loadOpenApiTools, OpenApiToolError, API_OPERATION_EFFECTS } from './openapi/index.js';
export type {
  OpenApiTool,
  OpenApiToolsOptions,
  OpenApiToolAudience,
  ActAs,
  OperationRef,
  OpenApiDocument,
  OpenApiOperation,
  OpenApiParameter,
  OpenApiPathItem,
  OpenApiRequestBody,
  SecurityRequirement,
  HttpMethod,
} from './openapi/index.js';

// Tool Authorization
export type { ToolPolicy, ToolPolicyContext, ToolPolicyDecision } from './authz/tool-policy.js';
export { defaultToolPolicy, evaluateToolPolicySafe } from './authz/tool-policy.js';

// Approvals: an irreversible action runs only on an approval the
// user gave, bound to the call, kept by the realtime server's approval store.
export { createHttpApprovalStoreClient } from './approvals/client.js';
export type { ApprovalStoreClient, HttpApprovalStoreClientConfig } from './approvals/client.js';
export {
  approvalRequirement,
  approvalToolNote,
  APPROVAL_TOOL_NOTE,
  READBACK_APPROVAL_TOOL_NOTE,
  SCREEN_APPROVAL_TOOL_NOTE,
  VOICE_APPROVAL_CHANNELS,
} from './approvals/requirement.js';
export type { ApprovalRequirement } from './approvals/requirement.js';
export { buildApprovalPreview } from './approvals/preview.js';
// The host's say before an approval is asked for: a check, and the display copy.
export { readHostPreview, readValidation, MAX_VALIDATION_ERROR_CHARS } from './approvals/hooks.js';
export type {
  ApprovalHookContext,
  ApprovalPreviewContext,
  ApprovalPreviewHook,
  ApprovalValidation,
  ValidateBeforeApproval,
  ApprovalHooks,
} from './approvals/hooks.js';

// Stopping a turn: the person's Stop, or a newer message that
// supersedes the turn, is kept by the realtime server and asked for by the
// turn. What the turn had produced is stored, then announced.
export { createHttpTurnStopClient, watchTurnStop, withLocalStop, stopOf, TurnStopped, DEFAULT_STOP_GRACE_MS } from './stop/turn-stop.js';
export type { TurnStopClient, HttpTurnStopClientConfig, TurnStopWatch, TurnStopState } from './stop/turn-stop.js';
export { stoppedTurnMessages } from './stop/partial.js';
// A person takes a conversation over and hands it back: the product API's client for the
// realtime server's conversation routes.
export { createHttpConversationClient } from './conversations/client.js';
export type { ConversationClient, HttpConversationClientConfig } from './conversations/client.js';
// Files the person attaches: the host's file area, the cost guard, the attachment tools.
export type { AttachmentStore, AttachmentStoreCallOptions, AttachmentOwner, AttachmentLoadAs, AttachmentContent, AttachmentWorkerConfig } from './attachments/store.js';
export { AttachmentGuard, type AttachmentUsage, type GuardedPart, type AttachmentCap } from './attachments/guard.js';
export { attachmentTools, ATTACHMENT_TOOLS, ATTACHMENT_TOOL_CLASS } from './attachments/tools.js';
export {
  VIEW_TOOL as ATTACHMENT_VIEW_TOOL,
  READ_TOOL as ATTACHMENT_READ_TOOL,
  LIST_TOOL as ATTACHMENT_LIST_TOOL,
  ATTACHMENT_DATA_NOTE,
  escapeAttachmentText,
} from './attachments/content.js';
export * as attachmentLimits from './attachments/limits.js';
export type { RecordedStep, RecordedCall } from './stop/partial.js';

// UI actions: the client's surfaces become the turn's UI tools,
// and every UI action is answered by the client.
export type { UIActionChannel, HttpUIActionChannelConfig } from './ui/channel.js';
export { createHttpUIActionChannel } from './ui/channel.js';
export { readClientPage, withoutClientSnapshot, withoutClientUI, capabilityFingerprint, CLIENT_SNAPSHOT_KEY, type ClientPage } from './ui/snapshot.js';
export {
  DEFAULT_INDEX_CHARS,
  indexDiff,
  indexLine,
  indexText,
  pageActions,
  pageFingerprint,
  pageFromIndex,
  pageFromSurfaces,
  type HeldDefinitions,
  type PageAction,
  type PageSurface,
} from './ui/page-index.js';
export { liftAnswerImage, ANSWER_IMAGE_MEDIA_TYPES, MAX_ANSWER_IMAGE_BASE64_CHARS, type AnswerImage } from './ui/answer-image.js';
export { describeSchema, schemaAt, WHOLE_SCHEMA_CHARS, type SchemaView } from './ui/outline.js';
export { readClientKnowledge, renderClientKnowledge, withClientKnowledge, CLIENT_KNOWLEDGE_KEY, type ClientKnowledge } from './ui/knowledge.js';
export { BLIND_REFUSALS_BEFORE_STOP, buildUITools, createPageSight, fitNotes, UI_ACT_TOOL, UI_DESCRIBE_TOOL, UI_READ_TOOL } from './ui/ui-tools.js';
export type { PageSight, UIToolDependencies, UIToolCollision } from './ui/ui-tools.js';
export { createUISequence } from './ui/ui-sequence.js';
export type { UISequence } from './ui/ui-sequence.js';

// Re-export AgentApiSurface types from core so hosts only need to depend on the worker
export type {
  AgentApiSurface,
  EntityInstance,
  EntityFilter,
  EntityMutation,
  IntentResult,
  ViewAnnotationState,
  NavigationState,
  SessionApiSurface,
  LearningApiSurface,
} from '@ouispec/agent-core';
export { runAgentTurn } from './orchestrator.js';

// The model seam: any `ai` library model; the worker imports no provider.
export { PROMPT_CACHE_BREAKPOINTS, describeModel } from './model.js';
// An answer as the model is sent it and as it is stored, for a host that fits answers stored before 0.11.
export { answerWithoutState } from './ui/page-state-at-end.js';
export type { LanguageModel, ProviderOptions } from './model.js';
export type { TurnPolicy, StepTool } from './turn-policy.js';
export { defaultTurnPolicy } from './turn-policy.js';
export { createHttpEmitAdapter } from './emit/http-adapter.js';
export type { HttpEmitAdapterConfig } from './emit/http-adapter.js';
export { teeEmitAdapter } from './emit/tee.js';
export type { TurnEventObserver } from './emit/tee.js';

// The runtime: one core, two host adapters (Lambda + SQS, container)
export { createAgentTurnRunner, categorizeError, hostSystemPrompt, payloadRefusal, TURN_DEADLINE_EXCEEDED } from './runtime/turn-runner.js';
export type { AgentTurnRunner, TurnHost, TurnOutcome, CategorizedError } from './runtime/turn-runner.js';
export { assertAgentRuntimeConfig } from './runtime/config.js';
export { turnInfoOf, DEFAULT_TURN_CHANNEL } from './runtime/turn-info.js';
export type { AgentTurnInfo, AgentTurnChannel, AgentTurnInputMode } from './runtime/turn-info.js';
export type { AgentRuntimeConfig, LambdaAgentConfig, AgentTurnPayload, HistoryRequest, TurnHistory } from './runtime/types.js';
export { createLambdaAgentHandler } from './lambda/handler.js';
export { startContainerAgentWorker, DEFAULT_LIVE_CALL_PATH } from './container/server.js';
export type { ContainerAgentConfig, ContainerAgentWorker, ContainerLiveCallRoute } from './container/server.js';

// Live calls: the call service's turns, answered by the product's own agent as
// a server-sent event stream, while the turn streams to its room as any turn does.
export { createLiveCallTurnHandler, LIVE_CALL_SPEECH, LIVE_CALL_CHANNEL } from './live-call/handler.js';
export type {
  LiveCallSpeech,
  LiveCallTurnHandler,
  LiveCallTurnHandlerConfig,
  LiveCallTurnOptions,
  LiveCallTurnTarget,
  LiveCallTurnCallContext,
} from './live-call/handler.js';
export {
  readLiveCallTurnRequest,
  liveCallError,
  LIVE_CALL_TURN_KINDS,
  LIVE_CALL_OPENING_MESSAGE,
  liveCallOpeningMessage,
  LIVE_CALL_TYPED_INPUT_MODE,
  LIVE_CALL_LIMITS,
  LIVE_CALL_ERROR_MESSAGES,
} from './live-call/protocol.js';
export type {
  LiveCallTurnKind,
  LiveCallTurnRequest,
  LiveCallStreamEvents,
  LiveCallStreamEventName,
  LiveCallRequestReading,
} from './live-call/protocol.js';
export { DEFAULT_KEEP_ALIVE_MS as LIVE_CALL_KEEP_ALIVE_MS } from './live-call/event-stream.js';

// Prompt Framework
export { buildAgentSystemPrompt } from './prompt/index.js';
export type {
  AgentPersonaConfig,
  AgentKnowledgeEntry,
  AgentWorkflow,
  AgentFewShotExample,
  AgentPersonaOverrides,
  PromptBuildContext,
  CommunicationStyle,
} from './prompt/index.js';
export { getBaseRules, getCommunicationRules, getToolStrategyRules, getUIControlRules } from './prompt/index.js';

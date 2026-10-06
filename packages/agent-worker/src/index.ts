/**
 * @ouispec/agent-worker — the agent runtime.
 *
 * Hosts provide: the model (any `ai` provider), the realtime server, the
 * persona, tools and persistence callbacks (ADR-0227 §2.2).
 * The worker handles: the multi-round tool loop, UI actions, streaming,
 * retries and timeouts, on Lambda + SQS or in a container.
 */

export type { AgentWorkerConfig, AgentTurnInput, AgentTurnResult, TurnMessage, TurnHistoryMessage, ToolCallRef, SystemPromptContext } from './types.js';
export type { RealtimeEmitAdapter } from './emit/types.js';
export type { ToolRegistry, RegisteredTool, ToolExecutionResult, ToolExecutionContext } from './tools/types.js';
export { createToolRegistry } from './tools/types.js';
export { loadToolsFromSchema } from './tools/schema-loader.js';
export type { LoadToolsOptions } from './tools/schema-loader.js';
// Async tools wait on the product's declared events (W9)
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

// API tools generated from any OpenAPI 3 document (ADR-0181 §2), each call acting
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

// Approvals (ADR-0228): an irreversible action runs only on an approval the
// user gave, bound to the call, kept by the realtime server's approval store.
export { createHttpApprovalStoreClient } from './approvals/client.js';
export type { ApprovalStoreClient, HttpApprovalStoreClientConfig } from './approvals/client.js';
export { approvalRequirement, APPROVAL_TOOL_NOTE } from './approvals/requirement.js';
export type { ApprovalRequirement } from './approvals/requirement.js';
export { buildApprovalPreview } from './approvals/preview.js';

// Stopping a turn (ADR-0252): the person's Stop, or a newer message that
// supersedes the turn, is kept by the realtime server and asked for by the
// turn. What the turn had produced is stored, then announced.
export { createHttpTurnStopClient, watchTurnStop, stopOf, TurnStopped, DEFAULT_STOP_GRACE_MS } from './stop/turn-stop.js';
export type { TurnStopClient, HttpTurnStopClientConfig, TurnStopWatch, TurnStopState } from './stop/turn-stop.js';
export { stoppedTurnMessages } from './stop/partial.js';
// Files the person attaches (ADR-0252 §2.8–§2.12): the host's file area, the cost guard, the attachment tools.
export type { AttachmentStore, AttachmentOwner, AttachmentLoadAs, AttachmentContent, AttachmentWorkerConfig } from './attachments/store.js';
export { AttachmentGuard, type AttachmentUsage, type GuardedPart } from './attachments/guard.js';
export { attachmentTools, ATTACHMENT_TOOLS, ATTACHMENT_TOOL_CLASS } from './attachments/tools.js';
export { VIEW_TOOL as ATTACHMENT_VIEW_TOOL, READ_TOOL as ATTACHMENT_READ_TOOL, LIST_TOOL as ATTACHMENT_LIST_TOOL } from './attachments/content.js';
export * as attachmentLimits from './attachments/limits.js';
export type { RecordedStep, RecordedCall } from './stop/partial.js';

// UI actions (ADR-0209): the client's surfaces become the turn's UI tools,
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
export type { LanguageModel, ProviderOptions } from './model.js';
export type { TurnPolicy } from './turn-policy.js';
export { defaultTurnPolicy } from './turn-policy.js';
export { createHttpEmitAdapter } from './emit/http-adapter.js';
export type { HttpEmitAdapterConfig } from './emit/http-adapter.js';

// The runtime: one core, two host adapters (Lambda + SQS, container)
export { createAgentTurnRunner, categorizeError, payloadRefusal } from './runtime/turn-runner.js';
export type { AgentTurnRunner, TurnOutcome, CategorizedError } from './runtime/turn-runner.js';
export { assertAgentRuntimeConfig } from './runtime/config.js';
export type { AgentRuntimeConfig, LambdaAgentConfig, AgentTurnPayload, HistoryRequest } from './runtime/types.js';
export { createLambdaAgentHandler } from './lambda/handler.js';
export { startContainerAgentWorker } from './container/server.js';
export type { ContainerAgentConfig, ContainerAgentWorker } from './container/server.js';

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

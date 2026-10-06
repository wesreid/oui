export { AgentProvider, useAgent, STOP_CONFIRM_TIMEOUT_MS } from './provider/AgentProvider.js';

export { useFeedback } from './hooks/useFeedback.js';
export { storedToAgentMessages } from './provider/stored-messages.js';
// The composer's files (ADR-0252 §2.14).
export type { ComposerAttachment, ComposerAttachmentsState, NotSentReason } from './provider/attachments.js';
// Approvals (ADR-0228): the card where the person approves an irreversible call.
export { ApprovalCard } from './approvals/ApprovalCard.js';
export type {
  ApprovalCardProps,
  ApprovalCardParts,
  ApprovalCardFrameProps,
  ApprovalCardButtonProps,
  ApprovalCardLabels,
} from './approvals/ApprovalCard.js';

export type {
  AgentApprovalRequest,
  AgentClientConfig,
  AgentContextValue,
  AgentHistoryState,
  AgentMessage,
  AgentToolCallState,
  AgentDebugState,
  AgentSessionRecord,
  DebugLogEntry,
  DebugLogLevel,
  DebugLogNamespace,
  SendMessageResult,
} from './provider/types.js';

// Entity integration patterns
export {
  AgentEntityComponent,
  defineAgentEntity,
  AgentEntity,
  asAgentEntity,
  useViewAnnotation,
} from './entity/index.js';

export type {
  AgentEntityRenderContext,
  DefineAgentEntityConfig,
  AgentEntityProps,
  AgentEntityChildContext,
  AsAgentEntityConfig,
  InjectedAgentEntityProps,
  UseViewAnnotationOptions,
  UseViewAnnotationReturn,
} from './entity/index.js';

// Annotation registry for view annotations
export { AnnotationRegistry } from './annotations/AnnotationRegistry.js';
export type { ViewAnnotationOptions, AnnotationEntry } from './annotations/types.js';
export { annotationRegistry } from './annotations/singleton.js';

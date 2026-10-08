export { AgentProvider, useAgent, useAgentStatus, STOP_CONFIRM_TIMEOUT_MS } from './provider/AgentProvider.js';
export { DEFAULT_PLANNING_TEXT } from './provider/turn-progress.js';

export { useFeedback } from './hooks/useFeedback.js';
export { storedToAgentMessages } from './provider/stored-messages.js';
// A listed conversation's spoken marks, as the history hands them on.
export { readConversationSummary, readConversationSummaries } from './provider/conversation-summaries.js';
// The composer's files.
export type { ComposerAttachment, ComposerAttachmentsState, NotSentReason } from './provider/attachments.js';
// A person on the staff takes a conversation over and hands it back: the staff console's side.
export { useStaffConversation } from './staff/useStaffConversation.js';
export type { StaffConversationState } from './staff/useStaffConversation.js';
// Approvals: the card where the person approves an irreversible call.
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
  AgentReasoning,
  AgentStatus,
  AgentStatusState,
  AgentTurnEnd,
  AgentToolCallState,
  AgentDebugState,
  AgentSessionRecord,
  DebugLogEntry,
  DebugLogLevel,
  DebugLogNamespace,
  SendMessageOptions,
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

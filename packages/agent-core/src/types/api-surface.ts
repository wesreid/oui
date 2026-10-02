/**
 * AgentApiSurface — the contract a host application implements to integrate with the Agent SDK.
 * This is the evolution of PA's PAApiSurface, enriched with entity and intent awareness.
 */

export interface AgentApiSurface {
  /** Query entities of a given type with optional filtering */
  queryEntities(type: string, filter?: EntityFilter): Promise<EntityInstance[]>;

  /** Get a single entity by type and ID */
  getEntity(type: string, id: string): Promise<EntityInstance>;

  /** Create or update an entity */
  mutateEntity(type: string, id: string, mutation: EntityMutation): Promise<EntityInstance>;

  /** Execute a named intent with parameters */
  executeIntent(intentId: string, params: Record<string, unknown>): Promise<IntentResult>;

  /** Get all currently visible view annotations */
  getVisibleAnnotations(): ViewAnnotationState[];

  /** Get the current navigation/routing state */
  getNavigationState(): NavigationState;

  /** Navigate to a route */
  navigate(route: string, params?: Record<string, unknown>): Promise<void>;

  /** Optional: working session management */
  sessions?: SessionApiSurface;

  /** Optional: learning signal reporting */
  learning?: LearningApiSurface;
}

export interface EntityInstance {
  id: string;
  type: string;
  properties: Record<string, unknown>;
  relations?: Record<string, EntityInstance | EntityInstance[]>;
  displayRepresentation?: {
    title: string;
    subtitle?: string;
    image?: string;
  };
}

export interface EntityFilter {
  where?: Record<string, unknown>;
  search?: string;
  limit?: number;
  offset?: number;
  orderBy?: Record<string, 'asc' | 'desc'>;
  include?: string[];
}

export interface EntityMutation {
  set?: Record<string, unknown>;
  connect?: Record<string, string>;
  disconnect?: string[];
  create?: boolean;
}

export interface IntentResult {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
  async?: { jobId: string; estimatedDuration?: string };
  artifacts?: Array<{ type: string; id: string; label: string }>;
}

export interface ViewAnnotationState {
  elementId: string;
  entity: { type: string; id: string };
  intents: string[];
  displayContext: {
    label: string;
    image?: string;
    badge?: string;
  };
  rect?: { x: number; y: number; width: number; height: number };
  visible: boolean;
  metadata?: Record<string, unknown>;
}

export interface NavigationState {
  route: string;
  params?: Record<string, string>;
  title?: string;
  breadcrumbs?: Array<{ label: string; route: string }>;
}

export interface SessionApiSurface {
  createSession(config: { name: string; description?: string }): Promise<{ id: string }>;
  getSession(id: string): Promise<SessionState>;
  addObjective(sessionId: string, objective: { description: string; intentId?: string }): Promise<{ id: string }>;
  updateObjective(sessionId: string, objectiveId: string, update: { status: string; result?: unknown }): Promise<void>;
  addArtifact(sessionId: string, artifact: { type: string; referenceId: string; label: string }): Promise<{ id: string }>;
}

export interface SessionState {
  id: string;
  name: string;
  status: 'active' | 'completed' | 'paused';
  objectives: Array<{ id: string; description: string; status: string; result?: unknown }>;
  artifacts: Array<{ id: string; type: string; referenceId: string; label: string }>;
}

export interface LearningApiSurface {
  recordTrajectory(trajectory: TrajectoryRecord): Promise<void>;
  recordFeedback(feedback: FeedbackRecord): Promise<void>;
  syncTrajectories(trajectories: TrajectoryRecord[]): Promise<{ synced: number }>;
}

export interface TrajectoryRecord {
  sessionId: string;
  turnId: string;
  timestamp: number;
  userIntent: string;
  resolvedIntents: string[];
  toolCalls: Array<{ intentId: string; params: Record<string, unknown>; result: unknown; durationMs: number }>;
  outcome: 'success' | 'failure' | 'partial' | 'abandoned';
  turnsToGoal?: number;
}

export interface FeedbackRecord {
  turnId: string;
  type: 'explicit' | 'implicit' | 'outcome';
  signal: 'positive' | 'negative' | 'neutral';
  detail?: string;
  timestamp: number;
}

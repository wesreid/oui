/**
 * UI Surface Schema — Declarative description of a platform's UI surface.
 *
 * Integrators use this schema to describe their pages, forms, actions,
 * players, and modals so the agent knows what it can control.
 * This is platform-agnostic — any application (web, mobile, desktop)
 * can define its surface and get agent-driven UI control.
 */

export interface UISurfaceSchema {
  /** All navigable pages/screens in the application */
  pages: PageDeclaration[];

  /** Modal dialogs/drawers that can be opened programmatically */
  modals: ModalDeclaration[];

  /** Actions available globally regardless of current page */
  globalActions: ActionDeclaration[];

  /** Entity type → route pattern mapping for open_entity navigation */
  entityRoutes?: Record<string, string>;
}

export interface PageDeclaration {
  /** Unique page identifier (e.g. "clip_creator", "project_editor") */
  id: string;

  /** Route pattern (e.g. "/projects/:projectId/editor") */
  route: string;

  /** Human-readable page title */
  title: string;

  /** What this page does — included in agent context for decision-making */
  description: string;

  /** Entity types visible/manageable on this page */
  entities?: string[];

  /** Actions available on this page */
  actions: ActionDeclaration[];

  /** Forms the agent can fill on this page */
  forms?: FormDeclaration[];

  /** Media player(s) present on this page */
  players?: PlayerDeclaration[];

  /** Whether this page supports entity selection (list views) */
  selectable?: SelectionDeclaration;
}

export interface ActionDeclaration {
  /** Unique action identifier within its scope */
  id: string;

  /** Human-readable label */
  label: string;

  /** What the action does — for LLM reasoning */
  description: string;

  /** Parameters the action accepts */
  params?: Record<string, ParamDeclaration>;

  /** Whether the action requires user confirmation before executing */
  confirmRequired?: boolean;

  /** Whether this action requires a selected entity */
  entityScoped?: boolean;

  /** Entity type this action operates on (if entityScoped) */
  entityType?: string;

  /** Whether the action is destructive (deletes data) */
  destructive?: boolean;
}

export interface ParamDeclaration {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description?: string;
  required?: boolean;
  enum?: string[];
  default?: unknown;
}

export interface FormDeclaration {
  /** Unique form identifier within its page */
  id: string;

  /** Human-readable form title */
  title?: string;

  /** Fields that can be filled by the agent */
  fields: FormFieldDeclaration[];

  /** Action to call when submitting this form (references an ActionDeclaration.id) */
  submitAction?: string;
}

export interface FormFieldDeclaration {
  /** Field key — used in fill_form to identify which field to set */
  id: string;

  /** Human-readable label */
  label: string;

  /** Field type determines how the agent interacts with it */
  type: FormFieldType;

  /** For 'select' type — available options */
  options?: Array<{ value: string; label: string; description?: string }>;

  /** For 'entity_picker' type — which entity type to pick from */
  entityType?: string;

  /** Whether this field is required for form submission */
  required?: boolean;

  /** Description of what this field is for — helps LLM fill correctly */
  description?: string;

  /** Default value */
  defaultValue?: unknown;

  /** Validation constraints */
  validation?: FieldValidation;

  /** Whether filling this field triggers dependent updates (cascading) */
  cascades?: string[];
}

export type FormFieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'boolean'
  | 'select'
  | 'multi_select'
  | 'entity_picker'
  | 'file'
  | 'color'
  | 'date'
  | 'range'
  | 'json';

export interface FieldValidation {
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  patternMessage?: string;
}

export interface PlayerDeclaration {
  /** Player identifier on this page */
  id: string;

  /** Type of media player */
  type: 'video' | 'audio' | 'timeline';

  /** Available commands */
  commands: PlayerCommand[];

  /** Whether the player supports seek */
  seekable?: boolean;

  /** Whether the player supports looping */
  loopable?: boolean;
}

export type PlayerCommand = 'play' | 'pause' | 'seek' | 'stop' | 'loop' | 'mute' | 'unmute' | 'fullscreen';

export interface SelectionDeclaration {
  /** Entity type that can be selected */
  entityType: string;

  /** Whether multiple selection is supported */
  multi?: boolean;

  /** Actions available on selected items */
  bulkActions?: string[];
}

export interface ModalDeclaration {
  /** Unique modal identifier */
  id: string;

  /** Human-readable title */
  title: string;

  /** What this modal does */
  description: string;

  /** Action ID that triggers this modal (optional) */
  trigger?: string;

  /** Forms within this modal */
  forms?: FormDeclaration[];

  /** Actions available within this modal */
  actions?: ActionDeclaration[];
}

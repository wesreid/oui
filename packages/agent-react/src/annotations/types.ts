export interface ViewAnnotationOptions {
  entity: { type: string; id: string };
  intents?: string[];
  displayContext: { label: string; image?: string; badge?: string };
  metadata?: Record<string, unknown>;
}

export interface AnnotationEntry {
  id: string;
  element: HTMLElement | null;
  options: ViewAnnotationOptions;
  visible: boolean;
  rect?: DOMRect;
}

export type AnnotationListener = () => void;

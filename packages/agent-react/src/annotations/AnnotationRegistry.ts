import type { ViewAnnotationState } from '@ouispec/agent-core';
import type { AnnotationEntry, AnnotationListener } from './types.js';

/**
 * Registry of view annotations — tracks which entities are visible on screen.
 * Replaces PA's PATargetRegistry with entity-bound annotations.
 */
export class AnnotationRegistry {
  private entries = new Map<string, AnnotationEntry>();
  private listeners = new Set<AnnotationListener>();
  private observer: IntersectionObserver | null = null;

  constructor() {
    if (typeof IntersectionObserver !== 'undefined') {
      this.observer = new IntersectionObserver(
        (entries) => {
          let changed = false;
          for (const ioEntry of entries) {
            const id = (ioEntry.target as HTMLElement).dataset.agentAnnotationId;
            if (!id) continue;
            const annotation = this.entries.get(id);
            if (annotation && annotation.visible !== ioEntry.isIntersecting) {
              annotation.visible = ioEntry.isIntersecting;
              annotation.rect = ioEntry.isIntersecting ? ioEntry.boundingClientRect : undefined;
              changed = true;
            }
          }
          if (changed) this.notify();
        },
        { threshold: 0.1 },
      );
    }
  }

  register(entry: AnnotationEntry): () => void {
    const id = entry.id;
    this.entries.set(id, entry);

    if (entry.element && this.observer) {
      entry.element.dataset.agentAnnotationId = id;
      this.observer.observe(entry.element);
    }

    this.notify();

    return () => {
      if (entry.element && this.observer) {
        this.observer.unobserve(entry.element);
      }
      this.entries.delete(id);
      this.notify();
    };
  }

  updateElement(id: string, element: HTMLElement | null): void {
    const entry = this.entries.get(id);
    if (!entry) return;

    if (entry.element && this.observer) {
      this.observer.unobserve(entry.element);
    }

    entry.element = element;

    if (element && this.observer) {
      element.dataset.agentAnnotationId = id;
      this.observer.observe(element);
    }
  }

  getVisibleAnnotations(): ViewAnnotationState[] {
    const annotations: ViewAnnotationState[] = [];
    for (const [id, entry] of this.entries) {
      annotations.push({
        elementId: id,
        entity: entry.options.entity,
        intents: entry.options.intents ?? [],
        displayContext: entry.options.displayContext,
        rect: entry.rect ? {
          x: entry.rect.x,
          y: entry.rect.y,
          width: entry.rect.width,
          height: entry.rect.height,
        } : undefined,
        visible: entry.visible,
        ...(entry.options.metadata ? { metadata: entry.options.metadata } : {}),
      });
    }
    return annotations;
  }

  resolveEntity(type: string, id: string): AnnotationEntry | undefined {
    for (const entry of this.entries.values()) {
      if (entry.options.entity.type === type && entry.options.entity.id === id) {
        return entry;
      }
    }
    return undefined;
  }

  resolveByContext(description: string): AnnotationEntry[] {
    const lower = description.toLowerCase();
    return [...this.entries.values()].filter(
      e => e.visible && e.options.displayContext.label.toLowerCase().includes(lower),
    );
  }

  subscribe(listener: AnnotationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

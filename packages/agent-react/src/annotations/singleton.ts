import { AnnotationRegistry } from './AnnotationRegistry.js';

/**
 * Singleton annotation registry instance for app-wide use.
 * Tracks which annotated entities are currently visible on screen.
 */
export const annotationRegistry = new AnnotationRegistry();

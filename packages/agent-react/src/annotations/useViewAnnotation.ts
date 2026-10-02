import { useRef, useCallback, useEffect } from 'react';
import type { ViewAnnotationOptions } from './types.js';
import { annotationRegistry } from './singleton.js';

/**
 * Hook to annotate a UI element with an entity binding.
 * Replaces PA's usePATarget — now entity-aware with contextual resolution.
 *
 * Usage:
 *   const ref = useViewAnnotation({
 *     entity: { type: 'Character', id: character.id },
 *     intents: ['edit-character', 'generate-clip'],
 *     displayContext: { label: character.name, image: character.thumbnailUrl },
 *   });
 *   return <div ref={ref}>...</div>;
 */
export function useViewAnnotation(options: ViewAnnotationOptions): (element: HTMLElement | null) => void {
  const idRef = useRef(`annotation-${options.entity.type}-${options.entity.id}`);
  const unregisterRef = useRef<(() => void) | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    return () => {
      unregisterRef.current?.();
    };
  }, []);

  const refCallback = useCallback((element: HTMLElement | null) => {
    const id = idRef.current;

    if (unregisterRef.current) {
      unregisterRef.current();
      unregisterRef.current = null;
    }

    if (element) {
      unregisterRef.current = annotationRegistry.register({
        id,
        element,
        options: optionsRef.current,
        visible: false,
      });
    }
  }, []);

  return refCallback;
}

import { useCallback } from 'react';
import type { FeedbackRecord } from '@ouispec/agent-core';
import { useAgent } from '../provider/AgentProvider.js';

export interface FeedbackActions {
  thumbsUp: (turnId: string, detail?: string) => void;
  thumbsDown: (turnId: string, detail?: string) => void;
  recordImplicit: (turnId: string, signal: 'positive' | 'negative', detail?: string) => void;
}

export function useFeedback(): FeedbackActions {
  useAgent(); // validate agent context is available

  const thumbsUp = useCallback((turnId: string, detail?: string) => {
    const record: FeedbackRecord = {
      turnId,
      type: 'explicit',
      signal: 'positive',
      detail,
      timestamp: Date.now(),
    };
    // Emit to learning surface if available
    window.dispatchEvent(new CustomEvent('agent:feedback', { detail: record }));
  }, []);

  const thumbsDown = useCallback((turnId: string, detail?: string) => {
    const record: FeedbackRecord = {
      turnId,
      type: 'explicit',
      signal: 'negative',
      detail,
      timestamp: Date.now(),
    };
    window.dispatchEvent(new CustomEvent('agent:feedback', { detail: record }));
  }, []);

  const recordImplicit = useCallback((turnId: string, signal: 'positive' | 'negative', detail?: string) => {
    const record: FeedbackRecord = {
      turnId,
      type: 'implicit',
      signal,
      detail,
      timestamp: Date.now(),
    };
    window.dispatchEvent(new CustomEvent('agent:feedback', { detail: record }));
  }, []);

  return { thumbsUp, thumbsDown, recordImplicit };
}

/**
 * createLambdaAgentHandler — the Lambda + SQS host adapter.
 *
 * The runtime core (runtime/turn-runner.ts) runs the turn; this adapter reads
 * it from the SQS record and tells SQS what a failure means. The host passes
 * every seam explicitly, and a missing one fails when the handler is created
 * — at cold start — naming it.
 *
 * @example
 * ```typescript
 * import { createLambdaAgentHandler, PROMPT_CACHE_BREAKPOINTS } from '@ouispec/agent-worker';
 * import { bedrock } from '@ai-sdk/amazon-bedrock';
 *
 * export const handler = createLambdaAgentHandler({
 *   model: bedrock('us.anthropic.claude-sonnet-4-6'),
 *   promptCacheBreakpoint: PROMPT_CACHE_BREAKPOINTS.bedrock,
 *   realtime: { url: env.REALTIME_URL, apiKey: env.REALTIME_INTERNAL_KEY },
 *   persona,
 *   tools: [],
 *   getDb,
 *   getHistory: (conversationId, db) => db.message.findMany({ where: { conversationId }, orderBy: { createdAt: 'asc' } }),
 *   persistMessages: ({ turnId, conversationId, messages, db }) => db.message.createMany({ data: toRows(turnId, conversationId, messages) }),
 * });
 * ```
 */
import type { SQSEvent } from 'aws-lambda';
import { createAgentTurnRunner, payloadRefusal } from '../runtime/turn-runner.js';
import type { AgentTurnPayload, LambdaAgentConfig } from '../runtime/types.js';

/**
 * Creates a Lambda handler for SQS: one record per invocation, its body an
 * `AgentTurnPayload`.
 *
 * A failure the runtime marks unrecoverable is rethrown, so SQS's redrive
 * policy sees it; a recoverable one (the provider rate-limiting or
 * unavailable) has already been reported to the client and is not retried.
 */
export function createLambdaAgentHandler<TDb>(config: LambdaAgentConfig<TDb>) {
  const runner = createAgentTurnRunner(config);

  return async (event: SQSEvent): Promise<void> => {
    if (!event.Records?.length) {
      runner.logger.warn('[agent-sdk] Empty SQS event');
      return;
    }
    const payload = JSON.parse(event.Records[0].body) as AgentTurnPayload;
    const refusal = payloadRefusal(payload);
    if (refusal) throw new Error(`[agent-sdk] ${refusal}`);

    const outcome = await runner.run(payload);
    if (outcome.status === 'failed' && !outcome.error.recoverable) throw outcome.cause;
  };
}

export type { LambdaAgentConfig, AgentTurnPayload } from '../runtime/types.js';

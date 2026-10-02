/**
 * The model seam (ADR-0227 §2.2, D5): the host passes any `ai` library model.
 * The worker names no provider and imports none.
 */
import type { LanguageModel, SystemModelMessage } from 'ai';

export type { LanguageModel };

/** Provider options on a message, keyed by provider. */
export type ProviderOptions = NonNullable<SystemModelMessage['providerOptions']>;

/**
 * The provider options that mark a prompt-cache breakpoint, for providers that
 * cache by breakpoint. Pass one as `promptCacheBreakpoint`; omit it for a
 * provider that caches on its own or not at all. These are data, not
 * dependencies: the worker imports no provider.
 */
export const PROMPT_CACHE_BREAKPOINTS = {
  bedrock: { amazonBedrock: { cachePoint: { type: 'default' } } },
  anthropic: { anthropic: { cacheControl: { type: 'ephemeral' } } },
} as const satisfies Record<string, ProviderOptions>;

/** How a model is named in logs and in `recordTurnStart`. */
export function describeModel(model: LanguageModel): string {
  return typeof model === 'string' ? model : `${model.provider}:${model.modelId}`;
}

import type { OUISurface, OUIActivation, OUIActionPolling, JSONSchema } from '@oui/spec';
/**
 * Configuration for defining an OUI surface with handlers.
 * This is the "integration file" an app provides — it declares both
 * the schema (what the agent sees) and the implementation (what executes).
 */
export interface SurfaceDefinition<TContext = unknown> {
    id: string;
    name: string;
    description: string;
    version?: string;
    activation?: OUIActivation;
    actions: ActionDefinition<TContext>[];
    observations?: ObservationDefinition[];
    metadata?: Record<string, unknown>;
}
/**
 * Polling config with an optional resolve handler.
 * The spec's OUIActionPolling is the manifest shape (no functions).
 * The core extends it with the resolve implementation for the runtime.
 */
export interface ActionPollingConfig<TContext = unknown> extends OUIActionPolling {
    /**
     * Called on each poll interval. Receives the dispatch result from the handler
     * plus the current context. Return { done: true, data } to stop polling,
     * or { done: false, data } to continue.
     */
    resolve?: (dispatchResult: unknown, context: TContext) => Promise<{
        done: boolean;
        data: unknown;
    }>;
}
/**
 * An action definition includes both the schema (for the agent) and
 * the handler (for execution). This is the single source of truth —
 * no separate YAML, no separate listener, no drift possible.
 */
export interface ActionDefinition<TContext = unknown> {
    id: string;
    description: string;
    input: JSONSchema;
    output?: JSONSchema;
    confirm?: boolean;
    async?: boolean;
    /**
     * Polling/subscription config for async actions.
     * After the handler returns, the OUI runtime starts polling or subscribing
     * and pushes observation updates until the operation completes.
     * Extends the spec's OUIActionPolling with an optional resolve handler.
     */
    polling?: ActionPollingConfig<TContext>;
    usage?: string;
    preconditions?: string;
    estimatedDuration?: string;
    tags?: string[];
    /**
     * The handler that executes when the agent invokes this action.
     * Receives typed params and a context object (app-specific state/utilities).
     * Returns a result that the agent sees as the tool output.
     */
    handler: (params: Record<string, unknown>, context: TContext) => Promise<ActionHandlerResult>;
}
export interface ActionHandlerResult {
    success: boolean;
    data?: unknown;
    error?: {
        code: string;
        message: string;
        details?: unknown;
    };
    /** For async actions: metadata passed to the polling resolver */
    dispatchMeta?: Record<string, unknown>;
}
export interface ObservationDefinition {
    id: string;
    description: string;
    schema: JSONSchema;
    /** Function that returns the current observation value */
    getValue?: () => unknown;
}
/**
 * Define an OUI surface — the single entry point for integrating
 * an application feature with the OUI protocol.
 *
 * This function validates the definition and returns a typed surface
 * object that can be registered with an agent runtime or transport layer.
 *
 * @example
 * ```typescript
 * const mySurface = defineSurface({
 *   id: 'my-feature',
 *   name: 'My Feature',
 *   description: 'Does something cool',
 *   actions: [
 *     {
 *       id: 'do_thing',
 *       description: 'Does the thing',
 *       input: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
 *       handler: async (params) => {
 *         const result = await doTheThing(params.name);
 *         return { success: true, data: result };
 *       },
 *     },
 *   ],
 * });
 * ```
 */
export declare function defineSurface<TContext = unknown>(definition: SurfaceDefinition<TContext>): DefinedSurface<TContext>;
/** A fully defined surface with both manifest extraction and execution capabilities */
export interface DefinedSurface<TContext = unknown> extends SurfaceDefinition<TContext> {
    toManifest(): OUISurface;
    executeAction(actionId: string, params: Record<string, unknown>, context: TContext): Promise<ActionHandlerResult>;
    getActionIds(): string[];
    /** Get the polling config for an action (if async) */
    getPollingConfig(actionId: string): OUIActionPolling | undefined;
}

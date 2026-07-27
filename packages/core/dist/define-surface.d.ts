import type { OUISurface, OUIActivation, JSONSchema } from '@oui/spec';
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
}

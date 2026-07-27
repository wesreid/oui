"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.defineSurface = defineSurface;
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
function defineSurface(definition) {
    // Validate: no duplicate action IDs
    const actionIds = new Set();
    for (const action of definition.actions) {
        if (actionIds.has(action.id)) {
            throw new Error(`[OUI] Duplicate action ID "${action.id}" in surface "${definition.id}"`);
        }
        actionIds.add(action.id);
    }
    // Validate: no duplicate observation IDs
    if (definition.observations) {
        const obsIds = new Set();
        for (const obs of definition.observations) {
            if (obsIds.has(obs.id)) {
                throw new Error(`[OUI] Duplicate observation ID "${obs.id}" in surface "${definition.id}"`);
            }
            obsIds.add(obs.id);
        }
    }
    return {
        ...definition,
        /** Extract the manifest (schema only, no handlers) for transmission to the agent runtime */
        toManifest() {
            return {
                id: definition.id,
                name: definition.name,
                description: definition.description,
                version: definition.version,
                activation: definition.activation,
                actions: definition.actions.map(actionToManifest),
                observations: definition.observations?.map(obsToManifest),
                metadata: definition.metadata,
            };
        },
        /** Execute an action by ID with the given params and context */
        async executeAction(actionId, params, context) {
            const action = definition.actions.find(a => a.id === actionId);
            if (!action) {
                return { success: false, error: { code: 'ACTION_NOT_FOUND', message: `Action "${actionId}" not found on surface "${definition.id}"` } };
            }
            try {
                return await action.handler(params, context);
            }
            catch (err) {
                return {
                    success: false,
                    error: {
                        code: 'ACTION_EXECUTION_ERROR',
                        message: err instanceof Error ? err.message : String(err),
                    },
                };
            }
        },
        /** Get all action IDs */
        getActionIds() {
            return definition.actions.map(a => a.id);
        },
    };
}
// ─── Internal helpers ────────────────────────────────────────────────────────
function actionToManifest(action) {
    return {
        id: action.id,
        description: action.description,
        input: action.input,
        output: action.output,
        confirm: action.confirm,
        async: action.async,
        usage: action.usage,
        preconditions: action.preconditions,
        estimatedDuration: action.estimatedDuration,
        tags: action.tags,
    };
}
function obsToManifest(obs) {
    return {
        id: obs.id,
        description: obs.description,
        schema: obs.schema,
    };
}

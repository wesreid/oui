"use strict";
/**
 * OUI — Open UI Specification
 *
 * The machine-readable contract for agent-controllable user interfaces.
 * Any UI application that implements this interface can be controlled by
 * any OUI-compatible agent runtime.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.OUI_PROTOCOL_EVENTS = void 0;
/**
 * Protocol event type strings (for type guards and routing).
 */
exports.OUI_PROTOCOL_EVENTS = {
    SURFACE_REGISTER: 'surface:register',
    SURFACE_DEREGISTER: 'surface:deregister',
    ACTION_REQUEST: 'action:request',
    ACTION_RESULT: 'action:result',
    OBSERVATION_UPDATE: 'observation:update',
};

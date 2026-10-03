/**
 * @ouispec/bindings — every UI capability declared once, in code
 * (ADR-0220).
 *
 * - The binding a design-system control carries, and the input schema derived
 *   from its props.
 * - The room catalog contract a room with its own editing model publishes.
 * - The generated manifest and knowledge, and how the runtime reads them.
 * - The registry of what is mounted right now.
 *
 * React hooks are in `@ouispec/bindings/react`; the adapter to OUI
 * surfaces is in `@ouispec/bindings/oui`. This entry has no
 * dependencies, so the build-time generator reads it in plain Node.
 */

export * from './json-schema.js';
export * from './effect.js';
export * from './room.js';
export * from './readers.js';
export * from './binding.js';
export * from './controls.js';
export * from './manifest.js';
export * from './registry.js';
export * from './interactive.js';
export * from './package-declaration.js';
export * from './tier2.js';
export * from './budgets.js';

// The rest of the contract an integrator builds against: the tier 2 mapping,
// a package's `oui` declarations, and `oui.config.json`.
export type { OuiConfigFile, OuiPackageDeclaration, Tier2Control, Tier2Mapping, Tier2Part, ValueFrom } from '@ouispec/contract';

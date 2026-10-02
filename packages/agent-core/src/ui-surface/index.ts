/**
 * UI Surface Schema types — used by the discover package
 * to describe application pages, forms, actions, and players.
 *
 * NOTE: The UIAction dispatch mechanism (actions.ts, emitter.ts, loader.ts)
 * was removed per ADR-0137. UI control is now exclusively handled by OUI
 * surfaces registered at runtime. Only the schema types remain for use by
 * the discover package. (The manifest loader that also used them,
 * surface-loader.ts, was deleted with ADR-0168 — it was never imported.)
 */
export type {
  UISurfaceSchema,
  PageDeclaration,
  ActionDeclaration,
  ParamDeclaration,
  FormDeclaration,
  FormFieldDeclaration,
  FormFieldType,
  FieldValidation,
  PlayerDeclaration,
  PlayerCommand,
  SelectionDeclaration,
  ModalDeclaration,
} from './schema.js';

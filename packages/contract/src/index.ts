/**
 * @ouispec/contract — the OUI integrator contract.
 *
 * The JSON Schemas an integrator builds against, versioned together with
 * `MANIFEST_VERSION`, and the TypeScript types generated from them:
 *
 * | Schema | What it describes |
 * |---|---|
 * | `control-table.json` | A tier 1 design system's control table, with the kinds it registers |
 * | `control-kind-registration.json` | A control kind a design system adds |
 * | `tier2-mapping.json` | A tier 2 mapping of a third-party design system |
 * | `agent-binding.json` | The `agent` prop a control carries |
 * | `page-query.json` | The query parameters a page reads from its address |
 * | `action-effect.json` | What an action does, and how a job settles |
 * | `room-catalog-data.json` | A tier 3 room catalog |
 * | `oui-manifest.json` | The generated manifest |
 * | `generated-knowledge.json` | The generated knowledge |
 * | `oui-config.json` | `oui.config.json` |
 * | `approvals.json` | The approval messages |
 * | `event-declarations.json` | A product's event declarations |
 * | `conversation-takeover.json` | A person taking a conversation from the agent, and handing it back |
 * | `agent-evals.json` | A suite of agent eval scenarios |
 *
 * Browser-safe and dependency-free. Validation is `./validate`; the type
 * renderer is `./codegen`; the files are `./schemas/<file>`; the integrator
 * guide is `INTEGRATOR-GUIDE.md`.
 */
export * from './generated/contract.js';
export { CONTRACT_SCHEMAS, CONTRACT_TYPES, type ContractSchemaFile, type ContractTypeName } from './generated/schemas.js';
export type { ContractSchemaDocument } from './schema-document.js';
export { CONTRACT_FILES, CONTRACT_SCHEMA_HOST, type ContractFile } from './render-contract.js';

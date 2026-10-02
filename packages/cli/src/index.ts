/**
 * @ouispec/cli — the assistant's surfaces and knowledge,
 * generated from a UI's code (ADR-0220).
 */

export {
  CONFIG_FILE,
  ConfigError,
  loadConfig,
  resolveConfig,
  type AppCatalogEntry,
  type ConfigInjection,
  type GeneratorConfig,
  type OuiConfigFile,
  type ShellEntry,
} from './config.js';
export { generate, writeOrCheck, MANIFEST_FILE, KNOWLEDGE_FILE, type GenerateResult, type Tier2Use } from './generate.js';
export { boundModuleSlug, BINDINGS_JSX_MODULE, BINDINGS_REACT_MODULE, BOUND_DIR } from './tier2.js';
export type { Finding } from './analyze.js';

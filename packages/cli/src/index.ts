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
export { generate, writeOrCheck, MANIFEST_FILE, KNOWLEDGE_FILE, type GenerateResult } from './generate.js';
export type { Finding } from './analyze.js';

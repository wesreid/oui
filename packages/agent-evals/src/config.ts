/**
 * A product's eval configuration (ADR-0260 §3.4): its suites, where their
 * recordings live, the channels it serves, its model, and its real agent
 * configuration, which the harness runs through the SDK's own turn runner.
 */
import type { ApprovalChannel, MessageInput } from '@ouispec/agent-core';
import type { AgentEvalScenario, AgentEvalSuite } from '@ouispec/contract';
import type { AgentRuntimeConfig, LanguageModel, ProviderOptions, ToolExecutionContext, ToolExecutionResult } from '@ouispec/agent-worker';

/**
 * How a run reaches the model:
 * - `replay`: from the recordings, with no network and no credentials (CI);
 * - `record`: the live model, and the recordings are written;
 * - `live`: the live model, and nothing is written.
 */
export type EvalMode = 'replay' | 'record' | 'live';

/** What a channel changes about a turn (ADR-0260 §3.3). */
export interface EvalChannel {
  /**
   * How the customer confirms an approval: `ui` (the card, the default), or a
   * conversation channel (`chat`, `sms`, `voice`, `phone`), where the readback
   * is sent and their next message confirms it. The turn carries it as its
   * `channel`.
   */
  approvals?: ApprovalChannel;
  /** What every customer message carries as `context.input`: `{ mode: 'voice', language }` marks it spoken. */
  input?: MessageInput;
  /** What every turn on this channel carries as its context, after the suite's. */
  context?: Record<string, unknown>;
}

/**
 * The parts of the product's agent configuration a turn runs with: the same
 * ones its worker is given. The harness keeps every one of them and replaces
 * only what reaches the outside (the model's network, storage, the realtime
 * server, each tool's execution).
 */
export type EvalAgentConfig = Pick<
  AgentRuntimeConfig<unknown>,
  | 'tools'
  | 'persona'
  | 'systemPrompt'
  | 'toolPolicy'
  | 'turnPolicy'
  | 'maxRounds'
  | 'maxTokens'
  | 'temperature'
  | 'toolTimeoutMs'
  | 'turnDeadlineMs'
  | 'retries'
>;

/** What the model factory is handed: the fetch every model request must go through, and why the model is wanted. */
export interface EvalModelSeam {
  /** Pass it to the provider (`createAmazonBedrock({ fetch })`, `createOpenAI({ fetch })`): it replays, records or passes through. */
  fetch: typeof globalThis.fetch;
  mode: EvalMode;
  /** `agent` for the turns; `judge` for a rubric's verdict. */
  purpose: 'agent' | 'judge';
}

/** A tool's stub as code: what the tool returns for a call, or `undefined` to fall through to the suite's data. */
export type EvalStubFunction = (
  args: Record<string, unknown>,
  context: { channel: string; scenario: AgentEvalScenario; tool: string; call: ToolExecutionContext },
) => ToolExecutionResult | undefined | Promise<ToolExecutionResult | undefined>;

export interface AgentEvalConfig {
  /**
   * Where relative paths (`suites`, `cassettes`) start: a directory, or a
   * file URL (`new URL('.', import.meta.url)`). Default: the CLI's config
   * file's directory, else the working directory.
   */
  root?: string | URL;
  /** The suites: files (`.json`, `.yaml`, `.yml`), or suites given as values. */
  suites: ReadonlyArray<string | AgentEvalSuite>;
  /** Where the recordings live, one file per scenario and channel. */
  cassettes: string;
  /** Every channel the product serves, by the name suites use. */
  channels: Readonly<Record<string, EvalChannel>>;
  /** The model: any `ai` provider, built with the fetch the harness hands it. */
  model: (seam: EvalModelSeam) => LanguageModel;
  /** The model's prompt-cache breakpoint, as the worker is given it. */
  promptCacheBreakpoint?: ProviderOptions;
  /** The judge of rubrics. Default: `model`, asked with `purpose: 'judge'`. */
  judge?: (seam: EvalModelSeam) => LanguageModel;
  /** The product's real agent configuration for a channel and scenario: the parts its worker runs with. */
  agent: (context: { channel: string; scenario: AgentEvalScenario; suite: AgentEvalSuite }) => EvalAgentConfig | Promise<EvalAgentConfig>;
  /** Stubs as code, by tool name, tried after a scenario's and a suite's data. */
  stubs?: Readonly<Record<string, EvalStubFunction>>;
  /** Who the customer is in every turn. Default `{ userId: 'eval-customer', accountId: 'eval-account' }`. */
  customer?: { userId?: string; accountId?: string };
}

/** The configuration, as written: `defineEvals` checks nothing at run time beyond what TypeScript does, and returns it. */
export function defineEvals(config: AgentEvalConfig): AgentEvalConfig {
  return config;
}

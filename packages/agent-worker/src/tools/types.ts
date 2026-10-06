import type { TurnStopState } from '../stop/turn-stop.js';
import type { ActionRequestApproval, AgentApiSurface } from '@ouispec/agent-core';
import type { EffectOrKind } from '@ouispec/bindings';
import type { UISlot } from '../ui/ui-sequence.js';

/**
 * Tool registry — platforms register their tools here.
 * The worker calls tools by name during the orchestration loop.
 */

/**
 * What a tool declares it does (ADR-0226 §2.6): a host or API tool's full
 * effect, or, for a UI action, the effect kind its OUI surface carries.
 */
export type ToolEffect = EffectOrKind;

export interface RegisteredTool {
  name: string;
  /**
   * `ui`: an action on the client's UI, run as the user in their own session
   * (ADR-0209). Bounded by the turn's round cap rather than the backend
   * side-effect quota. Default `backend`.
   */
  kind?: 'ui' | 'backend';
  /**
   * The SDK's class for a tool it owns (ADR-0252 §2.12): `attachment` for the
   * attachment tools. A host's tool policy may admit a class as well as a name,
   * so a tool the SDK adds later in that class needs no change in the host.
   */
  toolClass?: 'attachment';
  /**
   * What calling the tool changes (ADR-0226 §2.6). A tool that declares none is
   * treated as a write. Approvals key on this and `destructive` (ADR-0228).
   */
  effect?: ToolEffect;
  /** The call removes or replaces something the person made (ADR-0228). */
  destructive?: boolean;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * The schema a call's input is checked against, when it is not known until
   * the tool is used: a UI action's definition is fetched from the page then
   * (ADR-0245 §2.1). Called once per call, before validation; `inputSchema`
   * only stands in for it. A rejection is told to the model as the reason the
   * call did not run.
   */
  resolveInputSchema?: (ctx: ToolExecutionContext) => Promise<Record<string, unknown>>;
  execute: (input: Record<string, unknown>, ctx: ToolExecutionContext) => Promise<ToolExecutionResult>;
  /** Its name as a person reads it, for the approval card. Default: `name`. */
  title?: string;
  /** What running it does, for the approval card. Default: `description`. */
  consequence?: string;
  /**
   * Whether its arguments are kept out of logs. Default true: an approval's
   * arguments are logged only when its declaration says they are not sensitive.
   */
  argsSensitive?: boolean;
}

export interface ToolExecutionContext {
  userId: string;
  accountId: string;
  turnId: string;
  conversationId: string;
  userToken?: string;
  /**
   * The host's AgentApiSurface binding. Schema-generated tools call
   * `apiSurface.executeIntent(intentId, params)` instead of hand-rolled bodies.
   * Optional only for tools that don't need host API access (e.g. pure UI actions).
   */
  apiSurface?: AgentApiSurface;
  /** AbortSignal tied to the turn deadline — tools should observe this for cancellation. */
  abortSignal?: AbortSignal;
  /** The model's id for this call. UI tools use it as the OUI request id. */
  toolCallId?: string;
  /** The turn's realtime room, where the client that sent the turn listens. */
  socketRoom?: string;
  /**
   * A UI tool's place in the turn's UI order, taken by the orchestrator when the
   * model's call arrived (ui-sequence.ts). A UI tool runs its action in it.
   */
  uiSlot?: UISlot;
  /**
   * Set when the call is one the user approved (ADR-0228): a UI action's
   * request carries it, and the browser runs the action only when it matches
   * the grant from the user's own click.
   */
  approval?: ActionRequestApproval;
  /**
   * Whether the turn has been asked to stop (ADR-0252). A tool that waits on
   * something it sent reads it when `abortSignal` aborts, to say what became
   * of the call: not run, or sent with its outcome unknown.
   */
  stop?: TurnStopState;
  [key: string]: unknown;
}

export interface ToolExecutionResult {
  success: boolean;
  data?: unknown;
  error?: string;
  /**
   * A picture the model is given beside the result's text, as an image part
   * of the tool result. It is given once and stored nowhere: `data` says what
   * the picture is.
   */
  image?: { mediaType: string; base64: string };
}

export interface ToolRegistry {
  tools: RegisteredTool[];
  execute(name: string, input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolExecutionResult>;
}

/**
 * Creates a tool registry from a list of registered tools.
 */
export function createToolRegistry(tools: RegisteredTool[]): ToolRegistry {
  const toolMap = new Map(tools.map(t => [t.name, t]));

  return {
    tools,
    async execute(name: string, input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
      const tool = toolMap.get(name);
      if (!tool) {
        return { success: false, error: `Unknown tool: ${name}` };
      }
      try {
        return await tool.execute(input, ctx);
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

import type { TurnStopState } from '../stop/turn-stop.js';
import type { ActionRequestApproval, AgentApiSurface } from '@ouispec/agent-core';
import type { EffectOrKind } from '@ouispec/bindings';
import type { UISlot } from '../ui/ui-sequence.js';

/**
 * Tool registry — platforms register their tools here.
 * The worker calls tools by name during the orchestration loop.
 */

/**
 * What a tool declares it does: a host or API tool's full
 * effect, or, for a UI action, the effect kind its OUI surface carries.
 */
export type ToolEffect = EffectOrKind;

/**
 * The classes of the tools the SDK owns: `attachment` (the attachment tools),
 * `vision` (`look`), `capture` (`capture_start`, `capture_status`,
 * `capture_stop`) and `handoff` (`call_handoff`).
 */
export type SdkToolClass = 'attachment' | 'vision' | 'capture' | 'handoff';

export interface RegisteredTool {
  name: string;
  /**
   * `ui`: an action on the client's UI, run as the user in their own session
   *. Bounded by the turn's round cap rather than the backend
   * side-effect quota. Default `backend`.
   */
  kind?: 'ui' | 'backend';
  /**
   * The SDK's class for a tool it owns: `attachment` for the
   * attachment tools, `vision` for `look`, `capture` for the capture tools,
   * `handoff` for `call_handoff`.
   * A host's tool policy may admit a
   * class as well as a name, so a tool the SDK adds later in that class needs
   * no change in the host.
   */
  toolClass?: SdkToolClass;
  /**
   * What calling the tool changes. A tool that declares none is
   * treated as a write. Approvals key on this and `destructive`.
   */
  effect?: ToolEffect;
  /** The call removes or replaces something the person made. */
  destructive?: boolean;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * The schema a call's input is checked against, when it is not known until
   * the tool is used: a UI action's definition is fetched from the page then
   *. Called once per call, before validation; `inputSchema`
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
  /**
   * Whether the call's input is kept out of logs and the room's events, which
   * then say only that the tool was called. For input that speaks of the
   * person (a look's question). Default false.
   */
  inputPrivate?: boolean;
  /**
   * The tool's answer only says that what it was given was written (a note the
   * agent keeps for itself): the model needs nothing from it to finish its
   * reply. A step that wrote reply text and whose only calls were to answerless
   * tools, every one of which succeeded, is the turn's last: its text is the
   * reply, and the model is not called again to read the answers. A call that
   * failed or did not run, or any other tool called in the same step, lets the
   * turn go on as it always has. Default false.
   *
   * The tool's description and schema are sent as they are, so the flag
   * changes no prompt. Tell the agent, in the host's rules, to make such a call
   * in the step that writes its reply.
   */
  answerless?: boolean;
  /**
   * The model writes the tool's calls into its response, after its reply, as
   * `<oui:name>{json}</oui:name>`, instead of calling it (tools/trailer.ts). A
   * response ends at a tool call, so a model that makes an answerless call in
   * a step of its own spends one more model call on the reply; a trailer is
   * text, and the reply and the call arrive in one. Default false.
   *
   * Only for an answerless tool, with an object input schema and a name of
   * letters, digits, `_` and `-`, whose effect is at most `edit`, that is never
   * destructive and never needs approval: text the model copies from a page
   * can hold a trailer. The model must be an `ai` provider model, not an id.
   * Anything else is refused when the adapter is created, or when a resolver
   * gives a turn its tools.
   *
   * Its definition is not sent to the provider: the step's system prompt
   * teaches the trailer, from its description and schema. It runs, is stored
   * and is reported as a call (an id starting `oui_trailer_`), and every later
   * prompt writes its calls back as trailers. Its answer, when it succeeds, is
   * a JSON object without an `error` field: that is how a stored result says
   * the note was written. A trailer that cannot be read is answered with
   * `Invalid input for tool <name>: …`; the reply stands and the turn ends. A
   * host's tool policy that would ask for approval of a trailer refuses it.
   */
  trailer?: boolean;
  /**
   * The API this tool's approved calls go to, as an origin
   * (`https://api.example.com`): the audience of the receipt an approved call
   * carries (`ctx.approval.receipt`), which that API verifies. A host tool
   * that needs approval and names none gets the product's own origin, the
   * realtime server's `approvals.defaultAudience`. A generated API tool names
   * its server's origin itself; a UI action gets no receipt.
   */
  approvalAudience?: string;
  /** For a generated API tool, its OpenAPI `operationId`, carried on an approved call's receipt. */
  operationId?: string;
}

/**
 * The approval a call runs on: the approval id and the args hash it is
 * bound to, and, for a host or API tool when the realtime server holds receipt
 * keys, the signed receipt the tool's own API verifies. A UI action's request
 * carries only the id and hash (the browser checks its own grant).
 */
export interface ToolCallApproval extends ActionRequestApproval {
  /**
   * The approval receipt: a compact JWS the tool forwards to its API, as the
   * `OUI-Approval-Receipt` header (`APPROVAL_RECEIPT_HEADER`) unless its API
   * expects it elsewhere. A generated API tool sends it itself. It lasts 120
   * seconds and its `jti` is the call's idempotency key.
   */
  receipt?: string;
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
   * Set only on the call the user approved, never on another call of the
   * turn. A UI action's request carries its id and hash, and the browser runs
   * the action only when they match the grant from the user's own click. A
   * host or API tool gets the receipt too, when there is one.
   */
  approval?: ToolCallApproval;
  /**
   * Whether the turn has been asked to stop. A tool that waits on
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
  /**
   * Text the model is given beside the result's text, as a text part of the
   * tool result: a file's text, which is the model's for this call only. Like
   * `image`, it is in no event, record or stored message: `data` says what it is.
   */
  modelText?: string;
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

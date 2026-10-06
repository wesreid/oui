import type { ToolEffect } from '../tools/types.js';

/**
 * ToolPolicy — evaluated before every tool execution.
 * Integrators provide their own policy implementation via AgentWorkerConfig.toolPolicy.
 *
 * The policy is called AFTER quota enforcement but BEFORE the tool executes.
 * This allows integrators to enforce per-user, per-account, per-tool authorization
 * rules (role-based access, feature flags, rate limits, compliance checks, etc.).
 */

export interface ToolPolicy {
  evaluate(ctx: ToolPolicyContext): Promise<ToolPolicyDecision>;
}

export interface ToolPolicyContext {
  /** The internal user ID performing the action. */
  userId: string;
  /** The account ID the user belongs to. */
  accountId: string;
  /** The tool being invoked. */
  toolName: string;
  /** The arguments passed to the tool. */
  args: Record<string, unknown>;
  /** The current turn ID for audit/traceability. */
  turnId: string;
  /** Whether the tool has side effects (fail-closed: true if unknown). */
  hasSideEffects: boolean;
  /**
   * `ui` for an action on the client's UI (ADR-0209), which runs in the
   * user's browser under their own session; `backend` for a host tool.
   * Decide by this, not by the name: a UI action id can equal a host tool's.
   */
  toolKind: 'ui' | 'backend';
  /**
   * The SDK's class for a tool it owns: `attachment` for the attachment tools
   * (ADR-0252 §2.12). A policy that admits by name should admit the class too,
   * so a tool the SDK adds to it later needs no change.
   */
  toolClass?: 'attachment';
  /** What the tool declares it does (ADR-0226 §2.6); undefined when it declares nothing, which counts as a write. */
  effect: ToolEffect | undefined;
  /** Whether the tool declares it removes or replaces something the person made. */
  destructive: boolean;
}

/**
 * - `allow`: run it. A `transaction` or destructive call still needs the
 *   user's approval (ADR-0228 §2.1): no policy waives that.
 * - `deny`: never run it. Approval never overrides a deny.
 * - `require_approval`: run it only on the user's approval of this exact call,
 *   given on the approval card (or a conversation channel's readback). The
 *   turn stops at it; the call runs in the turn after the decision.
 */
export type ToolPolicyDecision =
  | { action: 'allow' }
  | { action: 'deny'; reason: string }
  | { action: 'require_approval'; reason: string };

/**
 * Default policy — allows all tools. Integrators override this.
 */
export const defaultToolPolicy: ToolPolicy = {
  evaluate: async () => ({ action: 'allow' as const }),
};

/**
 * Evaluate a tool policy, returning a denial on error (fail-closed).
 * This wrapper ensures that a broken policy never silently allows execution.
 */
export async function evaluateToolPolicySafe(
  policy: ToolPolicy,
  ctx: ToolPolicyContext,
): Promise<ToolPolicyDecision> {
  try {
    return await policy.evaluate(ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown policy error';
    return {
      action: 'deny',
      reason: `Policy evaluation failed (fail-closed): ${message}`,
    };
  }
}

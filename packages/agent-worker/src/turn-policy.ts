/**
 * TurnPolicy — controls per-step tool selection and constraints.
 *
 * Integrators provide their own policy to encode product-specific orchestration
 * behavior (e.g. forced tool sequences for onboarding, navigation-first flows).
 * The SDK provides a safe, product-neutral default.
 *
 * The policy is consulted at two points:
 *   1. classifyTurn — called once at turn start to classify the user's intent
 *   2. prepareStep  — called before each LLM step to control tool selection
 */

export interface TurnPolicy {
  /**
   * Classify the current turn to determine orchestration behavior.
   * Returns a string label that `prepareStep` uses to apply constraints.
   * The SDK does not interpret the label — it's opaque to the orchestrator.
   */
  classifyTurn(
    content: string,
    history?: Array<{ role: string; content: string }>,
  ): string;

  /**
   * Called before each step to control tool selection.
   * Returns overrides for toolChoice and activeTools, or empty object for no constraint.
   */
  prepareStep(ctx: {
    steps: Array<{ toolCalls?: Array<{ toolName: string }> }>;
    turnClass: string;
    allToolNames: string[];
  }): Promise<{
    toolChoice?: 'auto' | 'none' | 'required' | { type: 'tool'; toolName: string };
    activeTools?: string[];
    /**
     * An instruction for this step only, added after the system prompt. Say why
     * the step is constrained when the model cannot tell: a model made to hand
     * back at a step limit, without being told, invents a reason (on dev: "I
     * navigated away before filling in the text", about text it had filled).
     */
    note?: string;
  }>;

  /**
   * Optional: called after turn classification to perform side effects
   * (e.g. emitting deterministic navigation events).
   * The SDK calls this if defined, passing the emit adapter and turn context.
   */
  onTurnClassified?: (ctx: {
    turnClass: string;
    content: string;
    emit: { emit: (room: string, event: string, data: unknown) => Promise<void> };
    socketRoom: string;
  }) => Promise<void>;
}

/**
 * Default turn policy — product-neutral, safe defaults.
 * No forced tool sequences, no product-specific constraints.
 * The orchestrator's existing step count and token limits provide the safety net.
 */
export const defaultTurnPolicy: TurnPolicy = {
  classifyTurn: () => 'normal',
  prepareStep: async () => ({}),
};

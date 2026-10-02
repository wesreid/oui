import { describe, it, expect, vi } from 'vitest';
import {
  defaultToolPolicy,
  evaluateToolPolicySafe,
} from '../authz/tool-policy.js';
import type {
  ToolPolicy,
  ToolPolicyContext,
  ToolPolicyDecision,
} from '../authz/tool-policy.js';

function makeContext(overrides: Partial<ToolPolicyContext> = {}): ToolPolicyContext {
  return {
    userId: 'user-1',
    accountId: 'acct-1',
    toolName: 'generate_image',
    args: { prompt: 'sunset over mountains' },
    turnId: 'turn-abc',
    hasSideEffects: true,
    toolKind: 'backend',
    effect: undefined,
    destructive: false,
    ...overrides,
  };
}

describe('W12.T1 — Per-tool authorization policy', () => {
  // ─── 1. Default policy allows all tools ──────────────────────────────────

  describe('defaultToolPolicy', () => {
    it('allows all tools', async () => {
      const decision = await defaultToolPolicy.evaluate(makeContext());
      expect(decision).toEqual({ action: 'allow' });
    });

    it('allows regardless of tool name', async () => {
      const decision = await defaultToolPolicy.evaluate(makeContext({ toolName: 'dangerous_operation' }));
      expect(decision).toEqual({ action: 'allow' });
    });
  });

  // ─── 2. Deny policy prevents execution and returns structured refusal ────

  describe('deny policy', () => {
    const denyPolicy: ToolPolicy = {
      evaluate: async (ctx) => ({
        action: 'deny',
        reason: `User ${ctx.userId} is not authorized to use ${ctx.toolName}`,
      }),
    };

    it('returns deny decision with reason', async () => {
      const decision = await denyPolicy.evaluate(makeContext());
      expect(decision.action).toBe('deny');
      expect((decision as { action: 'deny'; reason: string }).reason).toContain('not authorized');
      expect((decision as { action: 'deny'; reason: string }).reason).toContain('user-1');
      expect((decision as { action: 'deny'; reason: string }).reason).toContain('generate_image');
    });

    it('wrapped in evaluateToolPolicySafe returns deny', async () => {
      const decision = await evaluateToolPolicySafe(denyPolicy, makeContext());
      expect(decision.action).toBe('deny');
    });
  });

  // ─── 3. Require-approval policy returns approval request ─────────────────

  describe('require_approval policy', () => {
    const approvalPolicy: ToolPolicy = {
      evaluate: async (ctx) => {
        if (ctx.hasSideEffects) {
          return { action: 'require_approval', reason: `${ctx.toolName} has side effects` };
        }
        return { action: 'allow' };
      },
    };

    it('requires approval for side-effecting tools', async () => {
      const decision = await approvalPolicy.evaluate(makeContext({ hasSideEffects: true }));
      expect(decision.action).toBe('require_approval');
      expect((decision as { action: 'require_approval'; reason: string }).reason).toContain('side effects');
    });

    it('allows non-side-effecting tools', async () => {
      const decision = await approvalPolicy.evaluate(makeContext({ hasSideEffects: false }));
      expect(decision.action).toBe('allow');
    });
  });

  // ─── 4. Policy error defaults to deny (fail-closed) ─────────────────────

  describe('fail-closed on error', () => {
    const brokenPolicy: ToolPolicy = {
      evaluate: async () => {
        throw new Error('Policy service unavailable');
      },
    };

    it('returns deny with error message when policy throws', async () => {
      const decision = await evaluateToolPolicySafe(brokenPolicy, makeContext());
      expect(decision.action).toBe('deny');
      expect((decision as { action: 'deny'; reason: string }).reason).toContain('fail-closed');
      expect((decision as { action: 'deny'; reason: string }).reason).toContain('Policy service unavailable');
    });

    it('handles non-Error throws', async () => {
      const weirdPolicy: ToolPolicy = {
        evaluate: async () => {
          throw 'string error';
        },
      };

      const decision = await evaluateToolPolicySafe(weirdPolicy, makeContext());
      expect(decision.action).toBe('deny');
      expect((decision as { action: 'deny'; reason: string }).reason).toContain('fail-closed');
    });
  });

  // ─── 5. Policy receives correct context ──────────────────────────────────

  describe('policy receives correct context', () => {
    it('passes userId, accountId, toolName, args, turnId, hasSideEffects', async () => {
      const spy = vi.fn(async (): Promise<ToolPolicyDecision> => ({ action: 'allow' }));
      const spyPolicy: ToolPolicy = { evaluate: spy };

      const ctx = makeContext({
        userId: 'user-42',
        accountId: 'acct-77',
        toolName: 'delete_production',
        args: { productionId: 'prod-123' },
        turnId: 'turn-xyz',
        hasSideEffects: true,
      });

      await evaluateToolPolicySafe(spyPolicy, ctx);

      expect(spy).toHaveBeenCalledTimes(1);
      const received = spy.mock.calls[0][0];
      expect(received.userId).toBe('user-42');
      expect(received.accountId).toBe('acct-77');
      expect(received.toolName).toBe('delete_production');
      expect(received.args).toEqual({ productionId: 'prod-123' });
      expect(received.turnId).toBe('turn-xyz');
      expect(received.hasSideEffects).toBe(true);
    });
  });

  // ─── Composite policy patterns ───────────────────────────────────────────

  describe('composite policy patterns', () => {
    it('supports tool-name-based allow/deny lists', async () => {
      const blocklist = new Set(['delete_production', 'drop_database']);

      const blocklistPolicy: ToolPolicy = {
        evaluate: async (ctx) => {
          if (blocklist.has(ctx.toolName)) {
            return { action: 'deny', reason: `Tool ${ctx.toolName} is blocked by policy` };
          }
          return { action: 'allow' };
        },
      };

      const allowed = await blocklistPolicy.evaluate(makeContext({ toolName: 'search_clips' }));
      expect(allowed.action).toBe('allow');

      const denied = await blocklistPolicy.evaluate(makeContext({ toolName: 'delete_production' }));
      expect(denied.action).toBe('deny');
    });

    it('supports per-account feature flags', async () => {
      const premiumAccounts = new Set(['acct-premium']);

      const featureFlagPolicy: ToolPolicy = {
        evaluate: async (ctx) => {
          if (ctx.toolName === 'generate_image' && !premiumAccounts.has(ctx.accountId)) {
            return { action: 'deny', reason: 'Image generation requires a premium account' };
          }
          return { action: 'allow' };
        },
      };

      const premium = await featureFlagPolicy.evaluate(makeContext({ accountId: 'acct-premium' }));
      expect(premium.action).toBe('allow');

      const free = await featureFlagPolicy.evaluate(makeContext({ accountId: 'acct-free' }));
      expect(free.action).toBe('deny');
    });
  });
});

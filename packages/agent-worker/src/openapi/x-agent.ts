/**
 * `x-agent`: how an operation opts in as an agent tool (ADR-0181 §3, ADR-0227 §2.1).
 *
 * ```yaml
 * x-agent:
 *   expose: true            # without it, the operation is not a tool
 *   effect: mutate          # ADR-0226 §2.6: view | file | mutate | job | transaction, or its object form
 *   destructive: true       # optional, on a write: removes or replaces something the person made
 *   consequence: "..."      # optional: what happens, for the tool's description and an approval's preview
 *   pa: true                # optional: the product's own assistant may call it; only on a read
 * ```
 *
 * Every field is checked, on every operation that carries `x-agent`, exposed or not.
 */
import { effectAccess, effectKind, effectProblem, type ActionEffect, type ActionEffectKind } from '@ouispec/bindings';
import { OpenApiToolError, type HttpMethod } from './document.js';

export interface AgentExposure {
  expose: boolean;
  effect?: ActionEffect;
  destructive: boolean;
  consequence?: string;
  pa: boolean;
}

const KEYS = new Set(['expose', 'effect', 'destructive', 'consequence', 'pa']);

/** The effects an API operation can have. The others (selection, navigate, open, edit) only a page has. */
export const API_OPERATION_EFFECTS: readonly ActionEffectKind[] = ['view', 'file', 'mutate', 'job', 'transaction'];

/** Methods that change data by definition (RFC 9110): a read-only effect on one is a mistake. */
const WRITE_METHODS = new Set<HttpMethod>(['put', 'patch', 'delete']);

/**
 * The effect as the tool carries it. A `mutate` or `transaction` is through this
 * operation, so its `operation` is filled in; one naming another operation is refused.
 */
function readEffect(value: unknown, operationId: string | undefined, where: string): ActionEffect {
  let effect: unknown = value;
  if (effect === 'mutate' || effect === 'transaction' || effect === 'job') effect = { kind: effect };
  if (effect && typeof effect === 'object' && !Array.isArray(effect)) {
    const e = { ...(effect as Record<string, unknown>) };
    if (e.kind === 'mutate' || e.kind === 'transaction') {
      if (e.operation !== undefined && e.operation !== operationId) {
        throw new OpenApiToolError(`${where}: x-agent.effect names operation "${String(e.operation)}"; an operation's effect is its own`);
      }
      if (operationId) e.operation = operationId;
    }
    effect = e;
  }
  const problem = effectProblem(effect);
  if (problem) throw new OpenApiToolError(`${where}: x-agent.effect: ${problem}`);
  const kind = effectKind(effect as ActionEffect);
  if (!API_OPERATION_EFFECTS.includes(kind)) {
    throw new OpenApiToolError(
      `${where}: x-agent.effect ${kind} is a page's effect; an API operation's effect is one of ${API_OPERATION_EFFECTS.join(', ')}`,
    );
  }
  return effect as ActionEffect;
}

/**
 * Read and check an operation's `x-agent`. Returns null when it has none.
 * `where` names the operation in every refusal.
 */
export function readAgentExposure(
  raw: unknown,
  op: { method: HttpMethod; operationId?: string },
  where: string,
): AgentExposure | null {
  if (raw === undefined) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new OpenApiToolError(`${where}: x-agent is an object`);
  const x = raw as Record<string, unknown>;
  for (const key of Object.keys(x)) {
    if (!KEYS.has(key)) throw new OpenApiToolError(`${where}: x-agent has an unknown key "${key}" (${[...KEYS].join(', ')})`);
  }
  const flag = (key: string): boolean => {
    if (x[key] === undefined) return false;
    if (typeof x[key] !== 'boolean') throw new OpenApiToolError(`${where}: x-agent.${key} is true or false`);
    return x[key] as boolean;
  };
  const expose = flag('expose');
  const destructive = flag('destructive');
  const pa = flag('pa');

  if (x.consequence !== undefined && (typeof x.consequence !== 'string' || x.consequence.trim() === '')) {
    throw new OpenApiToolError(`${where}: x-agent.consequence is a non-empty sentence`);
  }
  if (expose && x.effect === undefined) throw new OpenApiToolError(`${where}: x-agent.effect is required on an exposed operation`);
  const effect = x.effect === undefined ? undefined : readEffect(x.effect, op.operationId, where);
  const access = effectAccess(effect);

  if (destructive && access !== 'write') {
    throw new OpenApiToolError(`${where}: x-agent.destructive applies only to a write; this operation's effect is read-only`);
  }
  if (effect && access === 'read' && WRITE_METHODS.has(op.method)) {
    throw new OpenApiToolError(
      `${where}: effect ${effectKind(effect)} is read-only, but ${op.method.toUpperCase()} changes data; declare what it changes`,
    );
  }
  if (pa) {
    if (!expose) throw new OpenApiToolError(`${where}: x-agent.pa needs expose: true`);
    if (access !== 'read') {
      throw new OpenApiToolError(
        `${where}: x-agent.pa is allowed only on a read-only operation (effect view); this one is ${effectKind(effect!)}, a write`,
      );
    }
  }
  return {
    expose,
    ...(effect !== undefined ? { effect } : {}),
    destructive,
    ...(typeof x.consequence === 'string' ? { consequence: x.consequence } : {}),
    pa,
  };
}

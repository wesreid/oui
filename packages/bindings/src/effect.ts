import {
  effectAccess as ouiEffectAccess,
  OUI_EFFECT_ACCESS,
  OUI_EFFECT_KINDS,
  requiresApproval as ouiRequiresApproval,
  type OUIEffectKind,
} from 'oui-spec/spec';
import type {
  ActionEffect,
  ActionEffectKind as ContractEffectKind,
  SimpleEffect,
} from '@ouispec/contract';

/**
 * What using an action does (ADR-0226 §2.6): one vocabulary for a
 * design-system control's binding, a room catalog's entry and a generated API
 * tool, so a page control, a room action and an API call are told apart by
 * what they change, never by where they are declared.
 *
 * | Effect | What it changes | ADR-0210 access |
 * |---|---|---|
 * | `view`, `selection`, `navigate`, `open` | What is shown | read |
 * | `edit` | The document, one undo step | write |
 * | `file` | Imports or exports a file | write |
 * | `mutate` | Backend data, through an API operation | write |
 * | `job` | Starts work that outlives the call, settled on its outcome | write |
 * | `transaction` | An irreversible external act: an order, a payment, a send, a publish | write, approved |
 *
 * A `transaction`, and any `write` declared `destructive`, runs only on an
 * approval the person gave, bound to the call (ADR-0228).
 */

/** How long an approval for an action lasts at most, in minutes (ADR-0228 §2.3). */
export const MAX_APPROVAL_MINUTES = 30;

// The effect's shapes and the job states are the contract's (`action-effect.json`).
export type { ActionEffect, SimpleEffect, JobStatus, JobOutcome, JobSettlement } from '@ouispec/contract';

/**
 * The effect kinds. The vocabulary, what each one may change, and what needs
 * the person's approval are OUI's (`oui-spec`), so the browser that checks an
 * approval and every declaration here read one definition.
 */
export type ActionEffectKind = OUIEffectKind;

// Every kind declared above is one of OUI's: a kind OUI does not know would
// reach the browser as something it cannot check.
type UnknownKinds = Exclude<SimpleEffect | Exclude<ActionEffect, SimpleEffect>['kind'], OUIEffectKind>;
const everyKindIsOUIs: [UnknownKinds] extends [never] ? true : never = true;
void everyKindIsOUIs;
// And the contract's schema lists exactly OUI's kinds.
type Unlisted = Exclude<OUIEffectKind, ContractEffectKind> | Exclude<ContractEffectKind, OUIEffectKind>;
const theSchemaListsOUIsKinds: [Unlisted] extends [never] ? true : never = true;
void theSchemaListsOUIsKinds;

/** Every effect, in the order of the table above. */
export const ACTION_EFFECT_KINDS: readonly ActionEffectKind[] = OUI_EFFECT_KINDS;

/** Whether an effect only changes what is shown, or changes something (ADR-0210 `effect`). */
export const EFFECT_ACCESS: Readonly<Record<ActionEffectKind, 'read' | 'write'>> = OUI_EFFECT_ACCESS;

/**
 * An effect, or its bare kind: what an OUI surface carries for an action
 * (`effect: 'transaction'`), and what any reader of effects accepts.
 */
export type EffectOrKind = ActionEffect | ActionEffectKind;

export function effectKind(effect: EffectOrKind): ActionEffectKind {
  return typeof effect === 'string' ? effect : effect.kind;
}

/** `read` or `write`, as ADR-0210 names it. An action that declares no effect is a `write`: nothing says it only shows. */
export function effectAccess(effect: EffectOrKind | undefined): 'read' | 'write' {
  return ouiEffectAccess(effect === undefined ? undefined : effectKind(effect));
}

/**
 * Whether running the action needs the person's approval of the exact call
 * (ADR-0228 §2.1): a `transaction` always, and a `write` declared destructive.
 * A host's policy may require it of more; it never waives these. OUI's rule.
 */
export function requiresApproval(effect: EffectOrKind | undefined, destructive?: boolean): boolean {
  return ouiRequiresApproval(effect === undefined ? undefined : effectKind(effect), destructive);
}

/**
 * Why a value is not a valid effect, or null. Checks the shape only: whether a
 * route, container or operation it names exists is the generator's to check
 * against the app.
 */
export function effectProblem(value: unknown): string | null {
  if (typeof value === 'string') {
    return (['view', 'selection', 'edit', 'file'] as readonly string[]).includes(value)
      ? null
      : `"${value}" is not an effect: ${ACTION_EFFECT_KINDS.join(', ')}`;
  }
  if (!value || typeof value !== 'object' || typeof (value as { kind?: unknown }).kind !== 'string')
    return `an effect is one of ${ACTION_EFFECT_KINDS.join(', ')}`;
  const e = value as Record<string, unknown>;
  const text = (key: string) => typeof e[key] === 'string' && (e[key] as string).trim() !== '';
  const optionalText = (key: string) => e[key] === undefined || typeof e[key] === 'string';
  const positive = (key: string) => e[key] === undefined || (typeof e[key] === 'number' && (e[key] as number) > 0);
  switch (e.kind) {
    case 'navigate':
      return text('to') ? null : 'a navigate effect names the route it goes `to`';
    case 'open':
      return text('container') ? null : 'an open effect names the `container` it opens';
    case 'mutate':
      return text('operation') ? null : 'a mutate effect names its API `operation`';
    case 'job':
      return optionalText('estimatedDuration') && positive('timeoutMs')
        ? null
        : 'a job effect’s `timeoutMs` is a positive number and its `estimatedDuration` a literal string';
    case 'transaction': {
      if (!optionalText('operation') || e.operation === '') return 'a transaction’s `operation` is an operationId';
      if (!optionalText('estimatedDuration') || !positive('timeoutMs'))
        return 'a transaction’s `timeoutMs` is a positive number and its `estimatedDuration` a literal string';
      const minutes = e.approvalMinutes;
      if (
        minutes !== undefined &&
        !(typeof minutes === 'number' && Number.isInteger(minutes) && minutes >= 1 && minutes <= MAX_APPROVAL_MINUTES)
      )
        return `a transaction’s \`approvalMinutes\` is a whole number from 1 to ${MAX_APPROVAL_MINUTES}`;
      return null;
    }
    default:
      return `"${String(e.kind)}" is not an effect: ${ACTION_EFFECT_KINDS.join(', ')}`;
  }
}

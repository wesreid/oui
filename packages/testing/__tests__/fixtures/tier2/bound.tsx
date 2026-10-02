/**
 * Bound wrappers over the stand-in third-party package, as `oui generate`
 * emits them from `mapping.json` (ADR-0226 §2.3): each accepts `agent`,
 * registers the mapped kind with the app's own callback, returns that
 * callback's result, and renders the third-party component unchanged.
 * `BrokenThirdSelect` hands the value over at the wrong argument.
 */
import type { AgentProp } from '@ouispec/bindings';
import { useAgentBinding, type BindingRunResult } from '@ouispec/bindings/react';

import * as third from './third-party';

export function ThirdSelect({ agent, ...props }: third.ThirdSelectProps & { agent?: AgentProp }) {
  useAgentBinding({
    agent,
    kind: 'choice',
    title: props.label ?? '',
    value: props.value,
    schemaProps: { options: props.data.map(o => ({ value: o.value, title: o.label })) },
    run: ({ value }) => props.onChange?.({ type: 'change' }, value as string) as BindingRunResult,
  });
  return <third.ThirdSelect {...props} />;
}

export function ThirdButton({ agent, ...props }: third.ThirdButtonProps & { agent?: AgentProp }) {
  useAgentBinding({
    agent,
    kind: 'button',
    title: props.children ?? '',
    run: () => props.onClick?.({ type: 'click' }) as BindingRunResult,
  });
  return <third.ThirdButton {...props} />;
}

export function BrokenThirdSelect({ agent, ...props }: third.ThirdSelectProps & { agent?: AgentProp }) {
  useAgentBinding({
    agent,
    kind: 'choice',
    title: props.label ?? '',
    value: props.value,
    schemaProps: { options: props.data.map(o => ({ value: o.value, title: o.label })) },
    run: ({ value }) => props.onChange?.({ type: 'change', value } as never, undefined as never) as BindingRunResult,
  });
  return <third.ThirdSelect {...props} />;
}

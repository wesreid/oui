/**
 * The fixture design system, deliberately broken once for each rule of the
 * conformance kit (ADR-0226 §3.2). Everything not listed here is the good
 * design system, unchanged:
 *
 * - `Button` drops its binding when it is a ghost button, so a page's ghost
 *   button the manifest declares never has a handler (actions-mounted);
 * - `Toggle` registers as a button, though its table entry says toggle
 *   (registers-declared-kind);
 * - `SaveButton` calls `onSave` but throws its result away (run-returns-result);
 * - `Slider` takes `onChange` and is in neither the table nor the exclusions
 *   (callbacks-accounted);
 * - its table gives `Choice` a key the contract does not define (matches-contract).
 */
import type { AgentProp } from '@ouispec/bindings';
import { useAgentBinding, type BindingRunResult } from '@ouispec/bindings/react';

import type { ButtonProps } from '../good-ds/index';

export { Avatar, Badge, Choice, Facts, OrderCard, PriceRange } from '../good-ds/index';

export function Button({ children, variant, disabled, onClick, agent }: ButtonProps) {
  useAgentBinding({
    agent: variant === 'ghost' ? undefined : agent,
    kind: 'button',
    title: String(children ?? ''),
    disabled,
    run: () => onClick?.() as BindingRunResult,
  });
  return (
    <button type="button" disabled={disabled} onClick={() => onClick?.()}>
      {children}
    </button>
  );
}

export function Toggle({ label, on, onChange, agent }: { label: string; on: boolean; onChange?: (on: boolean) => unknown; agent?: AgentProp }) {
  useAgentBinding({ agent, kind: 'button', title: label, value: on, run: () => onChange?.(!on) as BindingRunResult });
  return <span>{label}</span>;
}

export function SaveButton({ onSave, agent }: { onSave?: () => unknown; agent?: AgentProp }) {
  useAgentBinding({
    agent,
    kind: 'button',
    title: 'Save',
    run: () => {
      onSave?.();
    },
  });
  return <span>Save</span>;
}

export function Slider({ value, onChange }: { value: number; onChange?: (value: number) => void }) {
  return <input type="range" value={value} onChange={e => onChange?.(Number(e.target.value))} />;
}

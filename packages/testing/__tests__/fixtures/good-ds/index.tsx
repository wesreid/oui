/**
 * A small tier 1 design system that is not Closure's, written to the contract
 * (ADR-0226 §2.2): each interactive export takes `agent`, registers through
 * `useAgentBinding` with the kind its table declares, and returns what the
 * consumer's callback returned. The kit's acceptance test holds it to every rule.
 */
import type { ReactNode } from 'react';

import {
  registerControlKind,
  slotBinding,
  type AgentProp,
  type AgentSlots,
} from '@ouispec/bindings';
import { useAgentBinding, useAgentBindings, useAgentFacts, type BindingRunResult } from '@ouispec/bindings/react';

import { PRICE_RANGE } from './agent-controls';

registerControlKind(PRICE_RANGE);

type Result = BindingRunResult | Promise<BindingRunResult>;

export interface ButtonProps {
  children?: ReactNode;
  variant?: 'primary' | 'ghost';
  disabled?: boolean;
  onClick?: () => unknown;
  agent?: AgentProp;
}

export function Button({ children, disabled, onClick, agent }: ButtonProps) {
  useAgentBinding({ agent, kind: 'button', title: String(children ?? ''), disabled, run: () => onClick?.() as Result });
  return (
    <button type="button" disabled={disabled} onClick={() => onClick?.()}>
      {children}
    </button>
  );
}

export interface ChoiceProps {
  label: string;
  value: string | null;
  options: readonly { value: string; label: string }[];
  onChange?: (value: string) => unknown;
  agent?: AgentProp;
}

export function Choice({ label, value, options, onChange, agent }: ChoiceProps) {
  useAgentBinding({
    agent,
    kind: 'choice',
    title: label,
    value,
    schemaProps: { options: options.map(o => ({ value: o.value, title: o.label })) },
    run: ({ value: next }) => onChange?.(next as string) as Result,
  });
  return (
    <select aria-label={label} value={value ?? ''} onChange={e => onChange?.(e.target.value)}>
      {options.map(o => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export interface PriceRangeProps {
  label: string;
  min: number;
  max: number;
  onChange?: (range: { low: number; high: number }) => unknown;
  agent?: AgentProp;
}

export function PriceRange({ label, min, max, onChange, agent }: PriceRangeProps) {
  useAgentBinding({
    agent,
    kind: 'x-price-range',
    title: label,
    schemaProps: { min, max },
    run: ({ value }) => onChange?.(value as { low: number; high: number }) as Result,
  });
  return <span>{label}</span>;
}

export interface OrderCardProps {
  title: string;
  onOpen?: () => unknown;
  onCancel?: () => unknown;
  menuItems?: readonly { label: string; onClick: () => unknown; agent?: AgentProp }[];
  agent?: AgentSlots<'open' | 'cancel'>;
}

export function OrderCard({ title, onOpen, onCancel, menuItems = [], agent }: OrderCardProps) {
  useAgentBindings([
    { agent: slotBinding(agent, 'open'), kind: 'button', title: `Open ${title}`, run: () => onOpen?.() as Result },
    { agent: slotBinding(agent, 'cancel'), kind: 'button', title: `Cancel ${title}`, run: () => onCancel?.() as Result },
    ...menuItems.map(item => ({ agent: item.agent, kind: 'button' as const, title: item.label, run: () => item.onClick() as Result })),
  ]);
  return <article>{title}</article>;
}

export interface FactsProps {
  title: string;
  facts: readonly { label: string; value: string }[];
  agent?: AgentProp;
}

export function Facts({ title, facts, agent }: FactsProps) {
  useAgentFacts(agent, title, Object.fromEntries(facts.map(f => [f.label, f.value])));
  return <dl>{facts.map(f => <dd key={f.label}>{f.value}</dd>)}</dl>;
}

/** Shows a trader's photo; tells the page when it has loaded. Not a control. */
export function Avatar({ src, onLoad }: { src: string; onLoad?: () => void }) {
  return <img src={src} alt="" onLoad={onLoad} />;
}

/** Display only: no callbacks, so it need not be listed anywhere. */
export function Badge({ children }: { children?: ReactNode }) {
  return <span>{children}</span>;
}

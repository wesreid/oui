/** The app's own wrapper over a bound control: it forwards its `agent` to the Switch it renders. */
import type { AgentProp } from '@ouispec/bindings';

import { Switch } from './agent/generated/bound/mantine-core';

export interface LabeledSwitchProps {
  label: string;
  on: boolean;
  onToggle: (on: boolean) => void;
  agent?: AgentProp;
}

export function LabeledSwitch({ label, on, onToggle, agent }: LabeledSwitchProps) {
  return <Switch label={label} checked={on} onChange={event => onToggle(event.currentTarget.checked)} agent={agent} />;
}

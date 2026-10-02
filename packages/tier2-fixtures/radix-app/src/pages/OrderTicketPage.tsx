/**
 * An order ticket on Radix primitives (the shadcn/ui base), bound through the
 * generated wrappers: every mapped primitive comes from the bound module,
 * whose namespaces keep every other part (`Select.Trigger`, `Tabs.List`).
 */
import { useState } from 'react';

import { Checkbox, RadioGroup, Select, Switch, Tabs } from '../agent/generated/bound/radix-ui';

export function OrderTicketPage() {
  const [account, setAccount] = useState('cash');
  const [side, setSide] = useState('buy');
  const [panel, setPanel] = useState('ticket');
  const [extended, setExtended] = useState(false);
  const [confirmFill, setConfirmFill] = useState<boolean | 'indeterminate'>(true);

  return (
    <Tabs.Root value={panel} onValueChange={setPanel} aria-label="Panel" agent={{ id: 'ticket.panel', description: 'Which part of the ticket is shown' }}>
      <Tabs.List>
        <Tabs.Trigger value="ticket">Ticket</Tabs.Trigger>
        <Tabs.Trigger value="orders">Open orders</Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content value="ticket">
        <Select.Root
          value={account}
          onValueChange={setAccount}
          name="Account"
          agent={{ id: 'ticket.account', description: 'The account the order trades in' }}
        >
          <Select.Trigger aria-label="Account">
            <Select.Value />
          </Select.Trigger>
          <Select.Portal>
            <Select.Content>
              <Select.Viewport>
                <Select.Item value="cash">
                  <Select.ItemText>Cash</Select.ItemText>
                </Select.Item>
                <Select.Item value="margin">
                  <Select.ItemText>Margin</Select.ItemText>
                </Select.Item>
              </Select.Viewport>
            </Select.Content>
          </Select.Portal>
        </Select.Root>
        <RadioGroup.Root value={side} onValueChange={setSide} aria-label="Side" agent={{ id: 'ticket.side', description: 'Whether the order buys or sells' }}>
          <RadioGroup.Item value="buy" aria-label="Buy" />
          <RadioGroup.Item value="sell" aria-label="Sell" />
        </RadioGroup.Root>
        <Switch.Root
          checked={extended}
          onCheckedChange={setExtended}
          aria-label="Extended hours"
          agent={{ id: 'ticket.extended-hours', description: 'Whether the order may fill outside regular trading hours' }}
        />
        <Checkbox.Root
          checked={confirmFill}
          onCheckedChange={setConfirmFill}
          aria-label="Confirm each fill"
          agent={{ id: 'ticket.confirm-fill', description: 'Whether each fill asks for confirmation' }}
        />
      </Tabs.Content>
    </Tabs.Root>
  );
}

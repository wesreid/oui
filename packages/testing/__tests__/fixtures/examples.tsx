/** Examples of the fixture design system's controls, as a page uses them: what the kit mounts and runs. */
import type { ControlExample } from '../../src/index';
import * as good from './good-ds/index';
import * as broken from './broken-ds/index';

const SIDES = [
  { value: 'buy', label: 'Buy' },
  { value: 'sell', label: 'Sell' },
];

export function examplesFor(ds: typeof good): Record<string, ControlExample> {
  const { Button, Choice, PriceRange, OrderCard, Facts } = ds;
  return {
    Button: ({ agent, on }) => (
      <Button agent={agent()} onClick={on('onClick')}>
        Save
      </Button>
    ),
    Choice: ({ agent, on }) => <Choice label="Side" value="buy" options={SIDES} agent={agent()} onChange={on('onChange')} />,
    PriceRange: ({ agent, on }) => <PriceRange label="Price" min={0} max={500} agent={agent()} onChange={on('onChange')} />,
    OrderCard: ({ agent, slots, on }) => (
      <OrderCard
        title="Order 1"
        agent={slots()}
        onOpen={on('onOpen')}
        onCancel={on('onCancel')}
        menuItems={[{ label: 'Duplicate', onClick: on('onClick'), agent: agent('entries') }]}
      />
    ),
    Facts: ({ agent }) => <Facts title="Order" facts={[{ label: 'Side', value: 'Buy' }]} agent={agent()} />,
  };
}

export const GOOD_EXAMPLES = examplesFor(good);

export const BROKEN_EXAMPLES: Record<string, ControlExample> = {
  ...examplesFor(broken as unknown as typeof good),
  Toggle: ({ agent, on }) => <broken.Toggle label="Live prices" on={false} agent={agent()} onChange={on('onChange')} />,
  SaveButton: ({ agent, on }) => <broken.SaveButton agent={agent()} onSave={on('onSave')} />,
};

/** Not controls: why each is excluded. */
export const EXCLUDED = { Avatar: 'display: reports its own image loading, which no one operates' };

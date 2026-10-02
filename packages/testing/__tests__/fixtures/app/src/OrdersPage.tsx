/** The fixture app's one page, on the fixture design system (`@kit/ds`). */
import { Button, Choice } from '@kit/ds';

const SIDES = [
  { value: 'buy', label: 'Buy' },
  { value: 'sell', label: 'Sell' },
];

export function OrdersPage({ order }: { order?: { id: string } }) {
  return (
    <>
      <Choice
        label="Side"
        value="buy"
        options={SIDES}
        onChange={() => {}}
        agent={{ id: 'orders.side', description: 'Whether the order buys or sells' }}
      />
      <Button onClick={() => {}} agent={{ id: 'orders.place', description: 'Send the order to the exchange', effect: { kind: 'transaction' } }}>
        Place order
      </Button>
      {order && (
        <Button variant="ghost" onClick={() => {}} agent={{ id: 'orders.cancel', description: 'Cancel the open order', destructive: true }}>
          Cancel order
        </Button>
      )}
    </>
  );
}

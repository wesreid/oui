import { Route, Routes } from 'react-router';
import { Button, Period, PriceRange, Tags } from '@fixture/ds';
import { useRoomRegistration } from '@ouispec/bindings/react';
import { LEDGER } from '@fixture/ledger';

const MARKETS = [
  { value: 'us', label: 'US equities' },
  { value: 'eu', label: 'EU equities' },
  { value: 'fx', label: 'Currencies' },
];

/** A product on its own design system: no creative tool anywhere. */
function TradePage() {
  useRoomRegistration(LEDGER, {} as never);
  return (
    <>
      <Tags
        label="Markets"
        options={MARKETS}
        onChange={() => {}}
        agent={{ id: 'trade.markets', description: 'Which markets the screener shows' }}
      />
      <Period label="Period" onChange={() => {}} agent={{ id: 'trade.period', description: 'The dates the history covers' }} />
      <PriceRange
        label="Price"
        min={0}
        max={500}
        unit="USD"
        onChange={() => {}}
        agent={{ id: 'trade.price', description: 'The price band to screen for' }}
      />
      <Button
        onClick={() => {}}
        agent={{
          id: 'trade.place-order',
          description: 'Send the order to the exchange',
          effect: { kind: 'transaction', operation: 'placeOrder', approvalMinutes: 10 },
        }}
      >
        Place order
      </Button>
    </>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/trade" element={<TradePage />} />
    </Routes>
  );
}

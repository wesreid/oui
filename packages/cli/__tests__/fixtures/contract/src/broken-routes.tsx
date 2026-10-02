import { Route, Routes } from 'react-router';
import { Button, Mystery } from '@fixture/ds';

function BrokenPage() {
  return (
    <>
      <Button onClick={() => {}} agent={{ id: 'broken.teleport', description: 'Go somewhere', effect: { kind: 'teleport' } }}>
        Go
      </Button>
      <Button
        onClick={() => {}}
        agent={{ id: 'broken.refund', description: 'Refund the order', effect: { kind: 'transaction', operation: 'refundOrder' } }}
      >
        Refund
      </Button>
      <Button
        onClick={() => {}}
        agent={{ id: 'broken.long', description: 'Wire the funds', effect: { kind: 'transaction', approvalMinutes: 45 } }}
      >
        Wire
      </Button>
      <Mystery onChange={() => {}} agent={{ id: 'broken.mystery', description: 'Something' }} />
    </>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/broken" element={<BrokenPage />} />
    </Routes>
  );
}

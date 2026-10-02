import { OrderTicketPage } from './pages/OrderTicketPage';
import { Route, Routes } from './router';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/ticket" element={<OrderTicketPage />} />
    </Routes>
  );
}

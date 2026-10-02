import { Route, Routes } from 'react-router';
import { OrdersPage } from './OrdersPage';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/orders" element={<OrdersPage />} />
    </Routes>
  );
}

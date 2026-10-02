import { ScreenerPage } from './pages/ScreenerPage';
import { Route, Routes } from './router';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/screener" element={<ScreenerPage />} />
    </Routes>
  );
}

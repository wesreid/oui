/** Routes to a page that imports a mapped primitive straight from radix-ui: the build must refuse it. */
import { DirectImportPage } from './pages/DirectImportPage';
import { Route, Routes } from './router';

export function DirectRoutes() {
  return (
    <Routes>
      <Route path="/direct" element={<DirectImportPage />} />
    </Routes>
  );
}

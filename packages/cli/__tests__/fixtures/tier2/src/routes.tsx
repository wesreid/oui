import { KitPage } from './pages/KitPage';
import { PlainPage } from './pages/PlainPage';

declare function Route(props: { path: string; element: unknown }): null;

export const routes = (
  <>
    <Route path="/kit" element={<KitPage />} />
    <Route path="/plain" element={<PlainPage />} />
  </>
);

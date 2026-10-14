import { SubpathPage } from './pages/SubpathPage';

declare function Route(props: { path: string; element: unknown }): null;

export const routes = <Route path="/subpath" element={<SubpathPage />} />;

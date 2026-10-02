import { DirectPage } from './pages/DirectPage';

declare function Route(props: { path: string; element: unknown }): null;

export const routes = <Route path="/direct" element={<DirectPage />} />;

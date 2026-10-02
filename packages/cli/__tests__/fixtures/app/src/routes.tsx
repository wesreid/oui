import { lazy, Suspense } from 'react';
import { Route, Routes, Navigate } from 'react-router';
import { VoicesPage } from './pages/VoicesPage';
import { UnboundPage } from './pages/UnboundPage';
import { CreateVoicePage } from './pages/CreateVoicePage';

const StudioPage = lazy(() => import('./pages/StudioPage').then(m => ({ default: m.StudioPage })));

/** A redirect that keeps the id: renders only a <Navigate>. */
function RedirectKeepId({ build }: { build: (id: string) => string }) {
  const id = 'x';
  if (!id) return <Navigate to="/voices" replace />;
  return <Navigate to={build(id)} replace />;
}

function LazyRoute({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={null}>{children}</Suspense>;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/voices" element={<VoicesPage />} />
      <Route path="/voices/create" element={<CreateVoicePage />} />
      <Route
        path="/studio"
        element={
          <LazyRoute>
            <StudioPage />
          </LazyRoute>
        }
      />
      <Route path="/unbound" element={<UnboundPage />} />
      <Route path="/old" element={<Navigate to="/voices" />} />
      <Route path="/voice/:id" element={<RedirectKeepId build={id => `/voices?open=${id}`} />} />
      <Route path="*" element={<VoicesPage />} />
    </Routes>
  );
}

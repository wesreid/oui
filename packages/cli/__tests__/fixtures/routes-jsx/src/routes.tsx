import React, { Suspense } from 'react';
import { Navigate, Outlet, Route, Routes } from 'react-router';
import { SettingsLayout } from './SettingsLayout';
import { GeneralSettingsPage } from './pages/GeneralSettingsPage';
import { TeamPage } from './pages/TeamPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { ProjectPage } from './pages/ProjectPage';
import { ProjectEditPage } from './pages/ProjectEditPage';
import { AboutPage } from './pages/AboutPage';
import { NotFoundPage } from './pages/NotFoundPage';

// `React.lazy`, and a default export.
const BillingPage = React.lazy(() => import('./pages/BillingPage'));

const PROJECTS = '/projects';

export function AppRoutes() {
  return (
    <Suspense fallback={null}>
      <Routes>
        <Route path="/settings" element={<SettingsLayout />}>
          <Route index element={<GeneralSettingsPage />} />
          <Route path="billing" element={<BillingPage />} />
          {/* A pathless route groups its children under the parent's path. */}
          <Route element={<Outlet />}>
            <Route path="team/:teamId" element={<TeamPage />} />
          </Route>
          <Route path="old" element={<Navigate to="/settings" replace />} />
        </Route>
        <Route path={PROJECTS}>
          <Route index element={<ProjectsPage />} />
          <Route path=":projectId" element={<ProjectPage />} />
          {/* An absolute child path is used as written. */}
          <Route path="/projects/:projectId/edit" element={<ProjectEditPage />} />
        </Route>
        <Route path="about" element={<AboutPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Suspense>
  );
}

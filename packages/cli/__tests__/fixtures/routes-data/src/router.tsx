import { createBrowserRouter, Navigate } from 'react-router';
import { Root } from './Root';
import { HomePage } from './pages/HomePage';
import { ReportsPage } from './pages/ReportsPage';
import { ReportPage } from './pages/ReportPage';
import { AccountPage } from './pages/AccountPage';
import { AuditPage } from './pages/AuditPage';

// Children held in a constant are read as written in place.
const reportRoutes = [
  { index: true, element: <ReportsPage /> },
  { path: ':reportId', Component: ReportPage },
];

export const router = createBrowserRouter([
  {
    path: '/',
    element: <Root />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'reports', children: reportRoutes },
      { path: 'account', element: <AccountPage /> },
      { path: 'account/audit', Component: AuditPage },
      { path: 'profile', lazy: () => import('./pages/ProfilePage') },
      { path: 'legacy', element: <Navigate to="/" replace /> },
      { path: '*', element: <HomePage /> },
    ],
  },
]);

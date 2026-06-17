import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import './index.css';

const AuthGuard = lazy(() =>
  import('./components/AuthGuard').then((module) => ({ default: module.AuthGuard })),
);
const AdminLayout = lazy(() =>
  import('./components/AdminLayout').then((module) => ({ default: module.AdminLayout })),
);
const LoginPage = lazy(() =>
  import('./pages/LoginPage').then((module) => ({ default: module.LoginPage })),
);
const DashboardPage = lazy(() =>
  import('./pages/DashboardPage').then((module) => ({ default: module.DashboardPage })),
);
const SecurityPage = lazy(() =>
  import('./pages/SecurityPage').then((module) => ({ default: module.SecurityPage })),
);
const ConfigPage = lazy(() =>
  import('./pages/ConfigPage').then((module) => ({ default: module.ConfigPage })),
);
const PromotionsPage = lazy(() =>
  import('./pages/PromotionsPage').then((module) => ({ default: module.PromotionsPage })),
);
const SponsoredLogsPage = lazy(() =>
  import('./pages/SponsoredLogsPage').then((module) => ({ default: module.SponsoredLogsPage })),
);

function RouteFallback() {
  return (
    <div className="auth-loading">
      <div className="auth-loading-spinner" />
    </div>
  );
}

function App() {
  return (
    <HashRouter>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<AuthGuard />}>
            <Route element={<AdminLayout />}>
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/promotions" element={<PromotionsPage />} />
              <Route path="/sponsored-logs" element={<SponsoredLogsPage />} />
              <Route path="/security" element={<SecurityPage />} />
              <Route path="/config" element={<ConfigPage />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </Suspense>
    </HashRouter>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

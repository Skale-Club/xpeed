import { ProblemSyncObserver } from '@/components/ProblemSyncObserver';
import { FuelTrendObserver } from '@/components/FuelTrendObserver';
import React, { Suspense, lazy } from "react";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, createRoutesFromElements, RouterProvider, Route, Outlet, Navigate, useLocation, useNavigate } from "react-router-dom";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { CarsProvider } from "@/contexts/CarsContext";
import { SettingsProvider, useSettings } from "@/contexts/SettingsContext";
import { ModesProvider } from "@/contexts/ModesContext";
import { ModeGate } from "@/components/ModeGate";
import { NAV } from "@/lib/mode-nav";
import { ObdScannerProvider } from "@/contexts/ObdScannerContext";
import PrivateRoute from "@/components/PrivateRoute";
import { PageLoader } from "@/components/PageLoader";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { PageRefreshProvider, usePageRefresh } from '@/contexts/PageRefreshContext';
import { VehicleNotificationsProvider } from '@/contexts/VehicleNotificationsContext';

// Lazy imports
const Index = lazy(() => import("./pages/Index"));
const SessionDetail = lazy(() => import("./pages/SessionDetail"));
const HistoryPage = lazy(() => import("./pages/HistoryPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const CarsPage = lazy(() => import("./pages/CarsPage"));
const OnboardingPage = lazy(() => import("./pages/OnboardingPage"));
const MaintenancePage = lazy(() => import("./pages/MaintenancePage"));
const ScannerPage = lazy(() => import("./pages/ScannerPage"));
const LivePage = lazy(() => import("./pages/LivePage"));
const FuelPage = lazy(() => import("./pages/FuelPage"));
const TrendsPage = lazy(() => import("./pages/TrendsPage"));
const FaultCodesPage = lazy(() => import("./pages/FaultCodesPage"));
const IssuesPage = lazy(() => import("./pages/IssuesPage"));
const SimPage = lazy(() => import("./pages/SimPage"));
const SimComparePage = lazy(() => import("./pages/SimComparePage"));
const SimCollectorPage = lazy(() => import("./pages/SimCollectorPage"));
const SimSessionsPage = lazy(() => import("./pages/SimSessionsPage"));
const AdminPage = lazy(() => import("./pages/AdminPage"));
const SharedReport = lazy(() => import("./pages/SharedReport"));
const LoginPage = lazy(() => import("./pages/LoginPage"));
const OAuthAuthorize = lazy(() => import("./pages/OAuthAuthorize"));
const NotFound = lazy(() => import("./pages/NotFound"));

import { queryClient } from '@/lib/query-client';

// One layout route for every signed-in page, so its providers (cars, the
// Bluetooth OBD connection) stay mounted while the user navigates.
const ProtectedScreen = () => {
  const { revision } = usePageRefresh();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  return <ErrorBoundary key={pathname} onGoHome={() => navigate('/')}>
    <Suspense fallback={<PageLoader />}><Outlet key={revision} /></Suspense>
  </ErrorBoundary>;
};

const AuthenticatedLayout = () => {
 const { user } = useAuth();
 return (
  <PrivateRoute>
    <CarsProvider key={user?.id}>
      <ObdScannerProvider>
        <VehicleNotificationsProvider><ProblemSyncObserver /><FuelTrendObserver /><PageRefreshProvider><ProtectedScreen /></PageRefreshProvider></VehicleNotificationsProvider>
      </ObdScannerProvider>
    </CarsProvider>
  </PrivateRoute>
);
};

// The Scanner is for mechanics and enthusiasts: it is there only when "Advanced
// tools" is on in Settings. Otherwise a link or bookmark lands on the Live panel.
const AdvancedToolsRoute = ({ children }: { children: React.ReactNode }) => {
  const { advancedTools } = useSettings();
  return advancedTools ? <>{children}</> : <Navigate to="/live" replace />;
};

const PublicLayout =({ children }: { children: React.ReactNode }) => (
  <Suspense fallback={<PageLoader />}>
    {children}
  </Suspense>
);

const AppProviders = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <AuthProvider>
        <SettingsProvider>
          <ModesProvider>
            <Toaster />
            <ErrorBoundary><Outlet /></ErrorBoundary>
          </ModesProvider>
        </SettingsProvider>
      </AuthProvider>
    </TooltipProvider>
  </QueryClientProvider>
);

// The Virtual screens that exist; the others are placeholders until they are built.
const SIM_SCREENS: Record<string, React.ReactElement> = {
  "/sim/sessions": <SimSessionsPage />,
  "/sim/compare": <SimComparePage />,
  "/sim/collector": <SimCollectorPage />,
};

const router = createBrowserRouter(createRoutesFromElements(
  <Route element={<AppProviders />}>
    {/* Public Routes */}
    <Route path="/login" element={<PublicLayout><LoginPage /></PublicLayout>} />
    <Route path="/reset-password" element={<Navigate to="/login?entrar" replace />} />
    {/* A new phone number gets an account at sign-in, so sign-up is the same page. */}
    <Route path="/signup" element={<Navigate to="/login?entrar" replace />} />

    {/* Protected Routes */}
    <Route element={<AuthenticatedLayout />}>
      {/* Real: the person's own car. Everyone has it unless they turned it off. */}
      <Route element={<ModeGate mode="real" />}>
        <Route path="/" element={<Index />} />
        <Route path="/session/:id" element={<SessionDetail />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/cars" element={<CarsPage />} />
        <Route path="/scanner" element={<AdvancedToolsRoute><ScannerPage /></AdvancedToolsRoute>} />
        <Route path="/live" element={<LivePage />} />
        <Route path="/fuel" element={<FuelPage />} />
        <Route path="/trends" element={<TrendsPage />} />
        <Route path="/codes" element={<FaultCodesPage />} />
        <Route path="/maintenance" element={<MaintenancePage />} />
        <Route path="/issues" element={<IssuesPage />} />
      </Route>
      {/* Virtual: racing games, only for someone who chose it. */}
      <Route element={<ModeGate mode="virtual" />}>
        {NAV.virtual.map((item) => <Route key={item.to} path={item.to} element={SIM_SCREENS[item.to] ?? <SimPage />} />)}
      </Route>
      {/* Shared by both modes. */}
      <Route path="/onboarding" element={<OnboardingPage />} />
      <Route path="/admin" element={<AdminPage />} />
      <Route path="/settings" element={<SettingsPage />} />
    </Route>

    {/* OAuth 2.1 authorization endpoint */}
    <Route path="/oauth/authorize" element={<PublicLayout><OAuthAuthorize /></PublicLayout>} />

    {/* Public shared diagnostic report */}
    <Route path="/share/:id" element={<PublicLayout><SharedReport /></PublicLayout>} />

    {/* 404 */}
    <Route path="*" element={<PublicLayout><NotFound /></PublicLayout>} />
  </Route>
));
const App = () => <RouterProvider router={router} />;

export default App;

import React, { Suspense, lazy } from "react";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Outlet, Navigate, useLocation, useNavigate } from "react-router-dom";
import { AuthProvider } from "@/contexts/AuthContext";
import { CarsProvider } from "@/contexts/CarsContext";
import { SettingsProvider, useSettings } from "@/contexts/SettingsContext";
import { ObdScannerProvider } from "@/contexts/ObdScannerContext";
import PrivateRoute from "@/components/PrivateRoute";
import { PageLoader } from "@/components/PageLoader";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Analytics } from "@vercel/analytics/react";

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
const IssuesPage = lazy(() => import("./pages/IssuesPage"));
const AdminPage = lazy(() => import("./pages/AdminPage"));
const SharedReport = lazy(() => import("./pages/SharedReport"));
const LoginPage = lazy(() => import("./pages/LoginPage"));
const OAuthAuthorize = lazy(() => import("./pages/OAuthAuthorize"));
const NotFound = lazy(() => import("./pages/NotFound"));

const queryClient = new QueryClient();

// One layout route for every signed-in page, so its providers (cars, the
// Bluetooth OBD connection) stay mounted while the user navigates.
const ProtectedScreen = () => {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  return <ErrorBoundary key={pathname} onGoHome={() => navigate('/')}>
    <Suspense fallback={<PageLoader />}><Outlet /></Suspense>
  </ErrorBoundary>;
};

const AuthenticatedLayout = () => (
  <PrivateRoute>
    <CarsProvider>
      <ObdScannerProvider>
        <ProtectedScreen />
      </ObdScannerProvider>
    </CarsProvider>
  </PrivateRoute>
);

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

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <AuthProvider>
        <SettingsProvider>
          <Toaster />
          <BrowserRouter>
            <ErrorBoundary>
            <Routes>
              {/* Public Routes */}
              <Route path="/login" element={<PublicLayout><LoginPage /></PublicLayout>} />
              {/* A new phone number gets an account at sign-in, so sign-up is the same page. */}
              <Route path="/signup" element={<Navigate to="/login?entrar" replace />} />

              {/* Protected Routes */}
              <Route element={<AuthenticatedLayout />}>
                <Route path="/" element={<Index />} />
                <Route path="/session/:id" element={<SessionDetail />} />
                <Route path="/history" element={<HistoryPage />} />
                <Route path="/cars" element={<CarsPage />} />
                <Route path="/onboarding" element={<OnboardingPage />} />
                <Route path="/scanner" element={<AdvancedToolsRoute><ScannerPage /></AdvancedToolsRoute>} />
                <Route path="/live" element={<LivePage />} />
                <Route path="/maintenance" element={<MaintenancePage />} />
                <Route path="/issues" element={<IssuesPage />} />
                <Route path="/admin" element={<AdminPage />} />
                <Route path="/settings" element={<SettingsPage />} />
              </Route>

              {/* OAuth 2.1 authorization endpoint */}
              <Route path="/oauth/authorize" element={<PublicLayout><OAuthAuthorize /></PublicLayout>} />

              {/* Public shared diagnostic report */}
              <Route path="/share/:id" element={<PublicLayout><SharedReport /></PublicLayout>} />

              {/* 404 */}
              <Route path="*" element={<PublicLayout><NotFound /></PublicLayout>} />
            </Routes>
            </ErrorBoundary>
          </BrowserRouter>
          <Analytics />
        </SettingsProvider>
      </AuthProvider>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;

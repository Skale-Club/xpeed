import React, { Suspense, lazy } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/contexts/AuthContext";
import { CarsProvider } from "@/contexts/CarsContext";
import { SettingsProvider } from "@/contexts/SettingsContext";
import PrivateRoute from "@/components/PrivateRoute";
import { PageLoader } from "@/components/PageLoader";
import { Analytics } from "@vercel/analytics/react";

// Lazy imports
const Index = lazy(() => import("./pages/Index"));
const SessionDetail = lazy(() => import("./pages/SessionDetail"));
const HistoryPage = lazy(() => import("./pages/HistoryPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const CarsPage = lazy(() => import("./pages/CarsPage"));
const OnboardingPage = lazy(() => import("./pages/OnboardingPage"));
const MaintenancePage = lazy(() => import("./pages/MaintenancePage"));
const AdminPage = lazy(() => import("./pages/AdminPage"));
const SharedReport = lazy(() => import("./pages/SharedReport"));
const LoginPage = lazy(() => import("./pages/LoginPage"));
const SignupPage = lazy(() => import("./pages/SignupPage"));
const SetupAdminPage = lazy(() => import("./pages/SetupAdminPage"));
const NotFound = lazy(() => import("./pages/NotFound"));

const queryClient = new QueryClient();

// Wrapper component to provide Cars context only for authenticated routes
const AuthenticatedLayout = ({ children }: { children: React.ReactNode }) => (
  <PrivateRoute>
    <CarsProvider>
      <Suspense fallback={<PageLoader />}>
        {children}
      </Suspense>
    </CarsProvider>
  </PrivateRoute>
);

const PublicLayout = ({ children }: { children: React.ReactNode }) => (
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
          <Sonner />
          <BrowserRouter>
            <Routes>
              {/* Public Routes */}
              <Route path="/login" element={<PublicLayout><LoginPage /></PublicLayout>} />
              <Route path="/signup" element={<PublicLayout><SignupPage /></PublicLayout>} />
              <Route path="/setup-admin" element={<PublicLayout><SetupAdminPage /></PublicLayout>} />
              
              {/* Protected Routes */}
              <Route path="/" element={<AuthenticatedLayout><Index /></AuthenticatedLayout>} />
              <Route path="/session/:id" element={<AuthenticatedLayout><SessionDetail /></AuthenticatedLayout>} />
              <Route path="/history" element={<AuthenticatedLayout><HistoryPage /></AuthenticatedLayout>} />
              <Route path="/cars" element={<AuthenticatedLayout><CarsPage /></AuthenticatedLayout>} />
              <Route path="/onboarding" element={<AuthenticatedLayout><OnboardingPage /></AuthenticatedLayout>} />
              <Route path="/maintenance" element={<AuthenticatedLayout><MaintenancePage /></AuthenticatedLayout>} />
              <Route path="/admin" element={<AuthenticatedLayout><AdminPage /></AuthenticatedLayout>} />
              <Route path="/settings" element={<AuthenticatedLayout><SettingsPage /></AuthenticatedLayout>} />

              {/* Public shared diagnostic report */}
              <Route path="/share/:id" element={<PublicLayout><SharedReport /></PublicLayout>} />

              {/* 404 */}
              <Route path="*" element={<PublicLayout><NotFound /></PublicLayout>} />
            </Routes>
          </BrowserRouter>
          <Analytics />
        </SettingsProvider>
      </AuthProvider>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;

import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/lib/auth";
import { BrandingProvider } from "@/lib/branding";
import LoginPage from "@/pages/LoginPage";
import AttendantDashboard from "@/pages/AttendantDashboard";
import AdminDashboard from "@/pages/AdminDashboard";
import SuperAdminDashboard from "@/pages/SuperAdminDashboard";
import NotFound from "@/pages/not-found";
import Candidatura from "@/pages/Candidatura";
import ForgotPassword from "@/pages/ForgotPassword";
import ResetPassword from "@/pages/ResetPassword";
import VitrinePublica from "@/pages/VitrinePublica";
import AvaliacaoPublica from "@/pages/AvaliacaoPublica";
import { useVisualViewportVar } from "@/hooks/useVisualViewportVar";

const queryClient = new QueryClient();

function AppRoutes() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 rounded-full border-4 border-primary border-t-transparent animate-spin" />
          <p className="text-muted-foreground text-sm">Carregando...</p>
        </div>
      </div>
    );
  }

  return (
    <Switch>
      <Route path="/candidatura/:token">
        <Candidatura />
      </Route>
      <Route path="/vitrine/:slug">
        <VitrinePublica />
      </Route>
      <Route path="/avaliar/:slug">
        <AvaliacaoPublica />
      </Route>
      <Route path="/forgot-password">
        {user ? <Redirect to="/" /> : <ForgotPassword />}
      </Route>
      <Route path="/reset-password/:token">
        {user ? <Redirect to="/" /> : <ResetPassword />}
      </Route>
      <Route path="/login">
        {user ? <Redirect to="/" /> : <LoginPage />}
      </Route>
      <Route path="/admin/{*rest}">
        {!user ? (
          <Redirect to="/login" />
        ) : (user.role === "admin" || user.role === "supervisor") ? (
          <AdminDashboard />
        ) : (
          <Redirect to="/" />
        )}
      </Route>
      <Route path="/admin">
        {!user ? (
          <Redirect to="/login" />
        ) : (user.role === "admin" || user.role === "supervisor") ? (
          <AdminDashboard />
        ) : (
          <Redirect to="/" />
        )}
      </Route>
      <Route path="/">
        {!user
          ? <Redirect to="/login" />
          : user.role === "superadmin"
            ? <SuperAdminDashboard />
            : (user.role === "admin" || user.role === "supervisor")
              ? <AdminDashboard />
              : <AttendantDashboard />}
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  useVisualViewportVar();
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthProvider>
          <BrandingProvider>
            <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
              <AppRoutes />
            </WouterRouter>
            <Toaster />
          </BrandingProvider>
        </AuthProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;

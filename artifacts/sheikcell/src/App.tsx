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
import GlobalChatWidget from "@/components/GlobalChatWidget";

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

// Balão de chat flutuante: fica fora do <Switch> de rotas (sobrevive à
// navegação entre páginas), só aparece autenticado e fora do painel do
// superadmin (gestão de tenants SaaS, sem contexto de loja).
function GlobalChatWidgetGate() {
  const { user } = useAuth();
  if (!user || user.role === "superadmin") return null;
  return <GlobalChatWidget />;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthProvider>
          <BrandingProvider>
            <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
              <AppRoutes />
            </WouterRouter>
            <GlobalChatWidgetGate />
            <Toaster />
          </BrandingProvider>
        </AuthProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;

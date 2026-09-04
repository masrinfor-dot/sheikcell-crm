import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import { api, type User } from "./api";
import ChangePasswordModal from "@/components/ChangePasswordModal";
import { ActivityGuardProvider } from "./activityGuard";
import { toast } from "@/hooks/use-toast";

type AuthCtx = {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  // Atualiza o usuário em cache (ex.: depois de editar o próprio perfil via
  // PATCH /auth/me) sem precisar recarregar a página inteira.
  setUser: (user: User) => void;
};

const AuthContext = createContext<AuthCtx>({
  user: null,
  loading: true,
  login: async () => {},
  logout: async () => {},
  setUser: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.auth.me()
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  // Sessão caiu no servidor (cookie de 24h venceu, ou o limite de 2 sessões
  // simultâneas por usuário derrubou esta aba) enquanto a página ficava
  // aberta — ver o dispatch em lib/api.ts. Sem isso, a pessoa ficava com a
  // tela travada mostrando dados antigos, achando que ainda estava logada,
  // e só descobria ao tentar fazer alguma ação e levar um "Unauthorized" sem
  // explicação nenhuma. Agora desloga de verdade (o roteador já manda pra
  // /login sozinho quando user vira null) e avisa com uma mensagem clara.
  useEffect(() => {
    function handleUnauthorized() {
      setUser((prev) => {
        if (prev) {
          toast({
            title: "Sessão expirada",
            description: "Sua sessão expirou ou foi encerrada em outro dispositivo. Faça login novamente.",
            variant: "destructive",
          });
        }
        return null;
      });
    }
    window.addEventListener("sheikcell:unauthorized", handleUnauthorized);
    return () => window.removeEventListener("sheikcell:unauthorized", handleUnauthorized);
  }, []);

  const login = async (email: string, password: string) => {
    const r = await api.auth.login(email, password);
    setUser(r.user);
  };

  const logout = async () => {
    await api.auth.logout();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, setUser }}>
      <ActivityGuardProvider>
        {children}
      </ActivityGuardProvider>
      {/* Primeiro acesso ou senha resetada: obriga criar senha nova */}
      {user?.mustChangePassword && (
        <ChangePasswordModal forced
          onDone={() => setUser({ ...user, mustChangePassword: false })} />
      )}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);

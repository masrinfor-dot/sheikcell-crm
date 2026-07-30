import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import { api, type User } from "./api";
import ChangePasswordModal from "@/components/ChangePasswordModal";

type AuthCtx = {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthCtx>({
  user: null,
  loading: true,
  login: async () => {},
  logout: async () => {},
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

  const login = async (email: string, password: string) => {
    const r = await api.auth.login(email, password);
    setUser(r.user);
  };

  const logout = async () => {
    await api.auth.logout();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
      {/* Primeiro acesso ou senha resetada: obriga criar senha nova */}
      {user?.mustChangePassword && (
        <ChangePasswordModal forced
          onDone={() => setUser({ ...user, mustChangePassword: false })} />
      )}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);

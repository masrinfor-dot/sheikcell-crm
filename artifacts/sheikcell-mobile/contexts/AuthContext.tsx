import AsyncStorage from "@react-native-async-storage/async-storage";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { api, User } from "@/lib/api";

type AuthState = {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthState>({
  user: null,
  isLoading: true,
  isAuthenticated: false,
  login: async () => {},
  logout: async () => {},
  refresh: async () => {},
});

const USER_STORAGE_KEY = "@sheikcell/user";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const { user: me } = await api.auth.me();
      setUser(me);
      await AsyncStorage.setItem(USER_STORAGE_KEY, JSON.stringify(me));
    } catch {
      setUser(null);
      await AsyncStorage.removeItem(USER_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    const init = async () => {
      setIsLoading(true);
      try {
        const cached = await AsyncStorage.getItem(USER_STORAGE_KEY);
        if (cached) {
          setUser(JSON.parse(cached) as User);
        }
        await refresh();
      } finally {
        setIsLoading(false);
      }
    };
    void init();
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    const { user: me } = await api.auth.login(email, password);
    setUser(me);
    await AsyncStorage.setItem(USER_STORAGE_KEY, JSON.stringify(me));
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.auth.logout();
    } finally {
      setUser(null);
      await AsyncStorage.removeItem(USER_STORAGE_KEY);
    }
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        isAuthenticated: user !== null,
        login,
        logout,
        refresh,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

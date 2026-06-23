import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";

export default function ProfileScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { user, logout } = useAuth();
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const handleLogout = () => {
    Alert.alert("Sair", "Deseja encerrar a sessão?", [
      { text: "Cancelar", style: "cancel" },
      {
        text: "Sair",
        style: "destructive",
        onPress: async () => {
          setIsLoggingOut(true);
          try {
            await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            await logout();
            router.replace("/login");
          } finally {
            setIsLoggingOut(false);
          }
        },
      },
    ]);
  };

  const roleLabel =
    user?.role === "admin" ? "Administrador" : "Atendente";

  const initial = user?.name ? user.name.charAt(0).toUpperCase() : "?";

  const topPad = Platform.OS === "web" ? insets.top + 67 : insets.top;

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View
        style={[
          styles.topBar,
          {
            backgroundColor: colors.card,
            borderBottomColor: colors.border,
            paddingTop: topPad + 16,
          },
        ]}
      >
        <Text style={[styles.title, { color: colors.foreground }]}>Perfil</Text>
      </View>

      <View style={styles.content}>
        <View
          style={[
            styles.avatarCard,
            {
              backgroundColor: colors.card,
              borderColor: colors.border,
              shadowColor: "#000",
            },
          ]}
        >
          <View
            style={[
              styles.avatarCircle,
              { backgroundColor: colors.primary },
            ]}
          >
            <Text style={styles.avatarInitial}>{initial}</Text>
          </View>
          <Text style={[styles.userName, { color: colors.foreground }]}>
            {user?.name ?? "—"}
          </Text>
          <Text style={[styles.userEmail, { color: colors.mutedForeground }]}>
            {user?.email ?? "—"}
          </Text>
          <View
            style={[
              styles.roleBadge,
              {
                backgroundColor:
                  user?.role === "admin" ? colors.primary + "18" : colors.accent + "18",
              },
            ]}
          >
            <Text
              style={[
                styles.roleText,
                {
                  color:
                    user?.role === "admin" ? colors.primary : colors.accent,
                },
              ]}
            >
              {roleLabel}
            </Text>
          </View>
        </View>

        {user?.sector && (
          <View
            style={[
              styles.sectorCard,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
          >
            <View style={styles.sectorRow}>
              <Ionicons
                name="business-outline"
                size={18}
                color={colors.mutedForeground}
              />
              <View style={styles.sectorInfo}>
                <Text style={[styles.sectorLabel, { color: colors.mutedForeground }]}>
                  Setor
                </Text>
                <Text style={[styles.sectorName, { color: colors.foreground }]}>
                  {user.sector.icon} {user.sector.name}
                </Text>
              </View>
            </View>
          </View>
        )}

        <Pressable
          style={({ pressed }) => [
            styles.logoutBtn,
            { borderColor: colors.destructive + "44" },
            pressed && styles.logoutBtnPressed,
          ]}
          onPress={handleLogout}
          disabled={isLoggingOut}
        >
          {isLoggingOut ? (
            <ActivityIndicator size="small" color={colors.destructive} />
          ) : (
            <>
              <Ionicons
                name="log-out-outline"
                size={20}
                color={colors.destructive}
              />
              <Text style={[styles.logoutText, { color: colors.destructive }]}>
                Sair
              </Text>
            </>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: {
    paddingHorizontal: 20,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  title: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
  },
  content: {
    flex: 1,
    padding: 20,
    gap: 14,
  },
  avatarCard: {
    borderRadius: 16,
    padding: 24,
    alignItems: "center",
    borderWidth: 1,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  avatarCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 14,
  },
  avatarInitial: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    color: "#ffffff",
  },
  userName: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    marginBottom: 4,
  },
  userEmail: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    marginBottom: 12,
  },
  roleBadge: {
    paddingHorizontal: 14,
    paddingVertical: 5,
    borderRadius: 999,
  },
  roleText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
  sectorCard: {
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
  },
  sectorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  sectorInfo: { flex: 1 },
  sectorLabel: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginBottom: 2,
  },
  sectorName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
  logoutBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 14,
    borderWidth: 1.5,
    marginTop: 8,
  },
  logoutBtnPressed: { opacity: 0.75 },
  logoutText: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
  },
});

import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Animated, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAuth } from "@/contexts/AuthContext";
import { getBaseUrl } from "@/lib/api";
import { connectChatEvents, type ChatEventsConnection } from "@/lib/chatEvents";

// Aviso em tempo real vindo do agendador (mesmos eventos SSE da Central web):
//  - "schedule_due"    → chegou a hora do retorno agendado ao cliente
//  - "schedule_failed" → uma mensagem agendada falhou no envio
type ScheduleAlert = {
  id: string;
  kind: "retorno" | "failed";
  conversationId: number;
  convName: string;
  content: string;
};

type SchedulePayload = {
  scheduledId: number;
  conversationId: number;
  convName: string;
  content: string;
};

const AUTO_HIDE_MS = 15_000;

/**
 * Escuta o canal SSE do chat (/api/chat/events) enquanto o usuário está
 * logado e mostra um banner tocável para os avisos de retorno agendado e de
 * falha de envio agendado. Tocar no banner abre a conversa do cliente.
 */
export function ScheduleAlerts() {
  const { isAuthenticated } = useAuth();
  const insets = useSafeAreaInsets();
  const [alerts, setAlerts] = useState<ScheduleAlert[]>([]);
  const slideAnim = useRef(new Animated.Value(-160)).current;
  const hideTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    const t = hideTimers.current.get(id);
    if (t) { clearTimeout(t); hideTimers.current.delete(id); }
    setAlerts((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const pushAlert = useCallback((alert: ScheduleAlert) => {
    setAlerts((prev) => {
      if (prev.some((a) => a.id === alert.id)) return prev;
      return [alert, ...prev].slice(0, 3);
    });
    if (Platform.OS !== "web") {
      Haptics.notificationAsync(
        alert.kind === "failed"
          ? Haptics.NotificationFeedbackType.Error
          : Haptics.NotificationFeedbackType.Warning,
      ).catch(() => {});
    }
    // Some sozinho depois de um tempo (o vendedor pode estar digitando).
    const timer = setTimeout(() => dismiss(alert.id), AUTO_HIDE_MS);
    hideTimers.current.set(alert.id, timer);
  }, [dismiss]);

  useEffect(() => {
    if (!isAuthenticated) return;
    let conn: ChatEventsConnection | null = null;
    const onSchedule = (kind: "retorno" | "failed") => (data: unknown) => {
      const p = data as SchedulePayload | null;
      if (!p || typeof p.conversationId !== "number") return;
      pushAlert({
        id: `sched-${kind}-${p.scheduledId}`,
        kind,
        conversationId: p.conversationId,
        convName: p.convName || "Cliente",
        content: p.content ?? "",
      });
    };
    conn = connectChatEvents(getBaseUrl(), {
      schedule_due: onSchedule("retorno"),
      schedule_failed: onSchedule("failed"),
    });
    return () => { conn?.close(); };
  }, [isAuthenticated, pushAlert]);

  // Limpa timers ao desmontar (logout).
  useEffect(() => () => {
    for (const t of hideTimers.current.values()) clearTimeout(t);
    hideTimers.current.clear();
  }, []);

  useEffect(() => {
    Animated.spring(slideAnim, {
      toValue: alerts.length > 0 ? 0 : -160,
      useNativeDriver: true,
      tension: 60,
      friction: 10,
    }).start();
  }, [alerts.length, slideAnim]);

  if (alerts.length === 0) return null;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.overlay,
        { paddingTop: insets.top + 8, transform: [{ translateY: slideAnim }] },
      ]}
    >
      {alerts.map((alert) => {
        const failed = alert.kind === "failed";
        return (
          <Pressable
            key={alert.id}
            testID={`schedule-alert-${alert.id}`}
            onPress={() => {
              dismiss(alert.id);
              router.push({ pathname: "/conversation/[id]", params: { id: String(alert.conversationId) } });
            }}
            style={[styles.banner, failed ? styles.bannerFailed : styles.bannerDue]}
          >
            <View style={styles.bannerBody}>
              <Text style={styles.bannerTitle} numberOfLines={1}>
                {failed
                  ? `⚠️ Mensagem agendada falhou — ${alert.convName}`
                  : `📞 Hora do retorno — ${alert.convName}`}
              </Text>
              {!!alert.content && (
                <Text style={styles.bannerText} numberOfLines={2}>
                  {alert.content}
                </Text>
              )}
              <Text style={styles.bannerHint}>Toque para abrir a conversa</Text>
            </View>
            <Pressable
              onPress={() => dismiss(alert.id)}
              hitSlop={10}
              style={styles.closeBtn}
              testID={`schedule-alert-close-${alert.id}`}
            >
              <Text style={styles.closeText}>✕</Text>
            </Pressable>
          </Pressable>
        );
      })}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 12,
    zIndex: 1000,
    elevation: 1000,
    gap: 8,
  },
  banner: {
    flexDirection: "row",
    alignItems: "flex-start",
    borderRadius: 14,
    padding: 14,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  bannerDue: { backgroundColor: "#1a2e6e" },
  bannerFailed: { backgroundColor: "#b91c1c" },
  bannerBody: { flex: 1, minWidth: 0 },
  bannerTitle: {
    color: "#ffffff",
    fontFamily: "Inter_700Bold",
    fontSize: 14,
    marginBottom: 2,
  },
  bannerText: {
    color: "rgba(255,255,255,0.9)",
    fontFamily: "Inter_400Regular",
    fontSize: 13,
  },
  bannerHint: {
    color: "rgba(255,255,255,0.7)",
    fontFamily: "Inter_500Medium",
    fontSize: 11,
    marginTop: 4,
  },
  closeBtn: { paddingLeft: 10, paddingTop: 2 },
  closeText: { color: "rgba(255,255,255,0.8)", fontSize: 14 },
});

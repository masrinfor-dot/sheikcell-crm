import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import React, { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, type Conversation } from "@/lib/api";
import { useColors } from "@/hooks/useColors";

const STATUS_COLORS: Record<string, string> = {
  open: "#22c55e",
  pending: "#fbbf24",
  resolved: "#9ca3af",
};

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return "agora";
  if (diff < 3600) return `${Math.floor(diff / 60)}min`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

function initials(name: string): string {
  return name
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

const AVATAR_COLORS = ["#3b82f6", "#8b5cf6", "#22c55e", "#f97316", "#ec4899", "#14b8a6"];

export default function ConversasScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const styles = useMemo(() => makeStyles(colors, insets), [colors, insets]);

  const [search, setSearch] = useState("");

  const { data: convs, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ["chat-conversations"],
    queryFn: () => api.chat.conversations(),
    refetchInterval: 15000,
  });

  // Fixadas primeiro (por usuário — o campo `pinned` já vem escopado do
  // servidor), depois pela mensagem mais recente. Espelha o painel web.
  const sorted = useMemo(() => {
    const list = (convs ?? []).filter((c) => {
      if (!search.trim()) return true;
      const q = search.trim().toLowerCase();
      return c.name.toLowerCase().includes(q) || c.phone.includes(q);
    });
    return [...list].sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      const ta = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
      const tb = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
      return tb - ta;
    });
  }, [convs, search]);

  // Fixa/desafixa com atualização otimista: o item pula para o topo na hora e
  // volta atrás se o servidor recusar.
  const pinMutation = useMutation({
    mutationFn: async ({ id, pinned }: { id: number; pinned: boolean }) =>
      pinned ? api.chat.unpin(id) : api.chat.pin(id),
    onMutate: async ({ id, pinned }) => {
      await queryClient.cancelQueries({ queryKey: ["chat-conversations"] });
      const prev = queryClient.getQueryData<Conversation[]>(["chat-conversations"]);
      queryClient.setQueryData<Conversation[]>(["chat-conversations"], (old) =>
        (old ?? []).map((c) => (c.id === id ? { ...c, pinned: !pinned } : c)),
      );
      if (Platform.OS !== "web") {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      }
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(["chat-conversations"], ctx.prev);
      Alert.alert(
        "Não foi possível fixar",
        err instanceof Error ? err.message : "Tente novamente",
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["chat-conversations"] });
    },
  });

  const renderItem = useCallback(
    ({ item }: { item: Conversation }) => {
      const isPinned = !!item.pinned;
      return (
        <Pressable
          style={({ pressed }) => [styles.card, pressed && { opacity: 0.7 }]}
          onPress={() =>
            router.push({ pathname: "/conversation/[id]", params: { id: String(item.id) } })
          }
          onLongPress={() => pinMutation.mutate({ id: item.id, pinned: isPinned })}
        >
          <View style={styles.avatarWrap}>
            {item.avatarUrl ? (
              <Image source={{ uri: item.avatarUrl }} style={styles.avatarImg} />
            ) : (
              <View
                style={[
                  styles.avatar,
                  { backgroundColor: AVATAR_COLORS[item.name.charCodeAt(0) % AVATAR_COLORS.length] },
                ]}
              >
                <Text style={styles.avatarText}>{initials(item.name) || "?"}</Text>
              </View>
            )}
            <View
              style={[
                styles.statusDot,
                { backgroundColor: STATUS_COLORS[item.status] ?? "#d1d5db" },
              ]}
            />
          </View>

          <View style={styles.cardBody}>
            <View style={styles.cardTopRow}>
              <View style={styles.nameRow}>
                {isPinned && (
                  <MaterialCommunityIcons
                    name="pin"
                    size={14}
                    color={colors.primary}
                    style={styles.pinIndicator}
                  />
                )}
                <Text style={styles.name} numberOfLines={1}>
                  {item.name}
                </Text>
              </View>
              <Text style={styles.time}>{timeAgo(item.lastMessageAt)}</Text>
            </View>
            <View style={styles.cardBottomRow}>
              <Text style={styles.preview} numberOfLines={1}>
                {item.lastMessage ?? "Sem mensagens"}
              </Text>
              {item.unreadCount > 0 && (
                <View style={styles.unreadBadge}>
                  <Text style={styles.unreadText}>
                    {item.unreadCount > 99 ? "99+" : item.unreadCount}
                  </Text>
                </View>
              )}
            </View>
          </View>

          <Pressable
            hitSlop={8}
            onPress={() => pinMutation.mutate({ id: item.id, pinned: isPinned })}
            style={({ pressed }) => [styles.pinBtn, pressed && { opacity: 0.5 }]}
          >
            <MaterialCommunityIcons
              name={isPinned ? "pin-off-outline" : "pin-outline"}
              size={20}
              color={isPinned ? colors.primary : colors.mutedForeground}
            />
          </Pressable>
        </Pressable>
      );
    },
    [styles, colors, pinMutation],
  );

  return (
    <View style={styles.root}>
      <View style={styles.topBar}>
        <View>
          <Text style={styles.topBarTitle}>Conversas</Text>
          <Text style={styles.topBarSub}>
            Toque no pino (ou segure a conversa) para fixar no topo
          </Text>
        </View>
        <Pressable
          onPress={() => void refetch()}
          disabled={isFetching}
          style={({ pressed }) => [styles.refreshBtn, pressed && { opacity: 0.6 }]}
        >
          <Ionicons name="refresh" size={22} color={colors.primary} />
        </Pressable>
      </View>

      <View style={styles.searchWrap}>
        <Ionicons name="search" size={16} color={colors.mutedForeground} />
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder="Buscar por nome ou telefone"
          placeholderTextColor={colors.mutedForeground}
          autoCapitalize="none"
        />
        {search.length > 0 && (
          <Pressable hitSlop={8} onPress={() => setSearch("")}>
            <Ionicons name="close-circle" size={16} color={colors.mutedForeground} />
          </Pressable>
        )}
      </View>

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : isError ? (
        <View style={styles.center}>
          <Ionicons name="cloud-offline-outline" size={48} color={colors.mutedForeground} />
          <Text style={styles.emptyTitle}>Erro ao carregar</Text>
          <Pressable style={styles.retryBtn} onPress={() => void refetch()}>
            <Text style={styles.retryText}>Tentar novamente</Text>
          </Pressable>
        </View>
      ) : sorted.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="chatbubbles-outline" size={56} color={colors.mutedForeground} />
          <Text style={styles.emptyTitle}>Nenhuma conversa</Text>
          <Text style={styles.emptySubtitle}>
            {search ? "Nada encontrado para a busca" : "As conversas do WhatsApp aparecem aqui"}
          </Text>
        </View>
      ) : (
        <FlatList
          data={sorted}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderItem}
          refreshControl={
            <RefreshControl
              refreshing={isFetching && !isLoading}
              onRefresh={refetch}
              tintColor={colors.primary}
            />
          }
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

function makeStyles(colors: ReturnType<typeof useColors>, insets: { top: number; bottom: number }) {
  const topPad = Platform.OS === "web" ? insets.top + 67 : insets.top;
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: colors.background,
    },
    topBar: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 20,
      paddingTop: topPad + 16,
      paddingBottom: 12,
      backgroundColor: colors.card,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    topBarTitle: {
      fontSize: 20,
      fontWeight: "700",
      color: colors.foreground,
    },
    topBarSub: {
      fontSize: 12,
      color: colors.mutedForeground,
      marginTop: 2,
    },
    refreshBtn: {
      padding: 8,
    },
    searchWrap: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginHorizontal: 16,
      marginTop: 12,
      marginBottom: 4,
      paddingHorizontal: 12,
      borderRadius: 12,
      backgroundColor: colors.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    searchInput: {
      flex: 1,
      paddingVertical: 10,
      fontSize: 14,
      color: colors.foreground,
    },
    center: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      padding: 24,
    },
    emptyTitle: {
      fontSize: 16,
      fontWeight: "600",
      color: colors.foreground,
      marginTop: 8,
    },
    emptySubtitle: {
      fontSize: 13,
      color: colors.mutedForeground,
      textAlign: "center",
    },
    retryBtn: {
      marginTop: 8,
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderRadius: 10,
      backgroundColor: colors.primary,
    },
    retryText: {
      color: colors.primaryForeground,
      fontWeight: "600",
    },
    listContent: {
      paddingVertical: 8,
      paddingBottom: insets.bottom + 90,
    },
    card: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      backgroundColor: colors.background,
    },
    avatarWrap: {
      position: "relative",
    },
    avatar: {
      width: 44,
      height: 44,
      borderRadius: 22,
      alignItems: "center",
      justifyContent: "center",
    },
    avatarImg: {
      width: 44,
      height: 44,
      borderRadius: 22,
    },
    avatarText: {
      color: "#fff",
      fontWeight: "700",
      fontSize: 14,
    },
    statusDot: {
      position: "absolute",
      bottom: -1,
      right: -1,
      width: 12,
      height: 12,
      borderRadius: 6,
      borderWidth: 2,
      borderColor: colors.background,
    },
    cardBody: {
      flex: 1,
      minWidth: 0,
    },
    cardTopRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 6,
      marginBottom: 2,
    },
    nameRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      flex: 1,
      minWidth: 0,
    },
    pinIndicator: {
      transform: [{ rotate: "45deg" }],
    },
    name: {
      fontSize: 15,
      fontWeight: "600",
      color: colors.foreground,
      flexShrink: 1,
    },
    time: {
      fontSize: 12,
      color: colors.mutedForeground,
    },
    cardBottomRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 6,
    },
    preview: {
      flex: 1,
      fontSize: 13,
      color: colors.mutedForeground,
    },
    unreadBadge: {
      minWidth: 20,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 10,
      backgroundColor: "#22c55e",
      alignItems: "center",
    },
    unreadText: {
      color: "#fff",
      fontSize: 11,
      fontWeight: "700",
    },
    pinBtn: {
      padding: 6,
    },
  });
}

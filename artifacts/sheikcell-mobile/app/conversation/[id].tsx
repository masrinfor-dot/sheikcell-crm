import { Feather } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import React, { useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api, type ChatMessage } from "@/lib/api";
import { useColors } from "@/hooks/useColors";

function msgTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function Bubble({ msg }: { msg: ChatMessage }) {
  const out = msg.direction === "outbound";
  return (
    <View style={[styles.bubbleRow, out ? styles.rowOut : styles.rowIn]}>
      <View style={[styles.bubble, out ? styles.bubbleOut : styles.bubbleIn]}>
        {!out && !!msg.senderName && (
          <Text style={styles.senderName}>{msg.senderName}</Text>
        )}
        <Text style={styles.bubbleText}>{msg.content}</Text>
        <View style={styles.bubbleMeta}>
          <Text style={styles.bubbleTime}>{msgTime(msg.createdAt)}</Text>
          {out && msg.status === "failed" && (
            <Text style={styles.failedText}>Não entregue</Text>
          )}
        </View>
      </View>
    </View>
  );
}

export default function ConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const convId = Number(id);
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const listRef = useRef<FlatList<ChatMessage>>(null);

  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const { data: conv } = useQuery({
    queryKey: ["chat-conversation", convId],
    queryFn: () => api.chat.conversation(convId),
    enabled: Number.isFinite(convId),
  });

  const { data: messages, isLoading } = useQuery({
    queryKey: ["chat-messages", convId],
    queryFn: () => api.chat.messages(convId),
    enabled: Number.isFinite(convId),
    refetchInterval: 8000,
  });

  const send = async () => {
    const content = text.trim();
    if (!content || sending) return;
    setSending(true);
    try {
      await api.chat.sendMessage(convId, content);
      setText("");
      await queryClient.invalidateQueries({ queryKey: ["chat-messages", convId] });
    } catch (err) {
      Alert.alert("Não foi possível enviar", err instanceof Error ? err.message : "Tente novamente");
    } finally {
      setSending(false);
    }
  };

  // FlatList invertida: dados em ordem decrescente, itens novos aparecem embaixo.
  const data = [...(messages ?? [])].reverse();

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View
        style={[
          styles.header,
          { paddingTop: insets.top + 8, backgroundColor: colors.card, borderBottomColor: colors.border },
        ]}
      >
        <Pressable onPress={() => router.back()} hitSlop={10} style={styles.backBtn} testID="conversation-back">
          <Feather name="chevron-left" size={26} color={colors.primary} />
        </Pressable>
        <View style={styles.headerBody}>
          <Text style={[styles.headerTitle, { color: colors.foreground }]} numberOfLines={1}>
            {conv?.name ?? "Conversa"}
          </Text>
          {!!conv?.assignee && (
            <Text style={[styles.headerSub, { color: colors.mutedForeground }]} numberOfLines={1}>
              Atendido por {conv.assignee.name}
            </Text>
          )}
        </View>
      </View>

      {/* Messages */}
      {isLoading ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={data}
          inverted
          keyExtractor={(m) => String(m.id)}
          renderItem={({ item }) => <Bubble msg={item} />}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={{ color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>
                Sem mensagens nesta conversa
              </Text>
            </View>
          }
        />
      )}

      {/* Composer */}
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View
          style={[
            styles.composer,
            {
              paddingBottom: Math.max(insets.bottom, 10),
              backgroundColor: colors.card,
              borderTopColor: colors.border,
            },
          ]}
        >
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Digite uma mensagem…"
            placeholderTextColor={colors.mutedForeground}
            multiline
            style={[styles.input, { backgroundColor: colors.secondary, color: colors.foreground }]}
            testID="conversation-input"
          />
          <Pressable
            onPress={send}
            disabled={sending || !text.trim()}
            style={[
              styles.sendBtn,
              { backgroundColor: sending || !text.trim() ? colors.muted : colors.primary },
            ]}
            testID="conversation-send"
          >
            {sending ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Feather name="send" size={18} color={text.trim() ? "#fff" : colors.mutedForeground} />
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingBottom: 10,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
  },
  backBtn: { padding: 4 },
  headerBody: { flex: 1, minWidth: 0, marginLeft: 4 },
  headerTitle: { fontFamily: "Inter_700Bold", fontSize: 16 },
  headerSub: { fontFamily: "Inter_400Regular", fontSize: 12, marginTop: 1 },
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  listContent: { paddingHorizontal: 12, paddingVertical: 10 },
  empty: { padding: 32, alignItems: "center", transform: [{ scaleY: -1 }] },
  bubbleRow: { marginBottom: 6, flexDirection: "row" },
  rowOut: { justifyContent: "flex-end" },
  rowIn: { justifyContent: "flex-start" },
  bubble: {
    maxWidth: "80%",
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  bubbleOut: { backgroundColor: "#dcf8c6", borderBottomRightRadius: 4 },
  bubbleIn: { backgroundColor: "#ffffff", borderBottomLeftRadius: 4 },
  senderName: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
    color: "#1a2e6e",
    marginBottom: 2,
  },
  bubbleText: { fontFamily: "Inter_400Regular", fontSize: 14, color: "#1f2937" },
  bubbleMeta: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 3, justifyContent: "flex-end" },
  bubbleTime: { fontFamily: "Inter_400Regular", fontSize: 10, color: "#6b7280" },
  failedText: { fontFamily: "Inter_500Medium", fontSize: 10, color: "#dc2626" },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 10,
    borderTopWidth: 1,
  },
  input: {
    flex: 1,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 10,
    maxHeight: 120,
    fontFamily: "Inter_400Regular",
    fontSize: 14,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
});

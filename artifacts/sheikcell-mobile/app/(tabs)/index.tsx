import { Ionicons, MaterialIcons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";
import { api, QueueEntry, Sector } from "@/lib/api";

function waitTime(entry: QueueEntry): string {
  const ms = Date.now() - new Date(entry.createdAt).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return "< 1 min";
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

function StatusBadge({ status }: { status: string }) {
  const colors = useColors();
  const config =
    status === "waiting"
      ? { label: "Aguardando", bg: "#fef3c7", text: "#92400e" }
      : status === "in_progress"
      ? { label: "Em atendimento", bg: "#dbeafe", text: "#1e40af" }
      : { label: "Concluído", bg: "#dcfce7", text: "#166534" };
  return (
    <View style={[badgeStyles.badge, { backgroundColor: config.bg }]}>
      <Text style={[badgeStyles.text, { color: config.text }]}>
        {config.label}
      </Text>
    </View>
  );
}

const badgeStyles = StyleSheet.create({
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  text: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
  },
});

type TransferModalProps = {
  entry: QueueEntry;
  sectors: Sector[];
  onTransfer: (sectorId: number) => void;
  onClose: () => void;
};

function TransferModal({ entry, sectors, onTransfer, onClose }: TransferModalProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const others = sectors.filter((s) => s.id !== entry.sectorId);

  return (
    <View
      style={[
        transferStyles.overlay,
        { paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 0) },
      ]}
    >
      <Pressable style={transferStyles.backdrop} onPress={onClose} />
      <View style={[transferStyles.sheet, { backgroundColor: colors.card, borderRadius: colors.radius + 4 }]}>
        <View style={transferStyles.handle} />
        <Text style={[transferStyles.title, { color: colors.foreground }]}>
          Transferir cliente
        </Text>
        <Text style={[transferStyles.subtitle, { color: colors.mutedForeground }]}>
          {entry.clientName}
        </Text>
        {others.map((s) => (
          <Pressable
            key={s.id}
            style={({ pressed }) => [
              transferStyles.sectorRow,
              { borderColor: colors.border },
              pressed && { opacity: 0.7 },
            ]}
            onPress={() => onTransfer(s.id)}
          >
            <Text style={transferStyles.sectorIcon}>{s.icon}</Text>
            <Text style={[transferStyles.sectorName, { color: colors.foreground }]}>
              {s.name}
            </Text>
            <Ionicons name="chevron-forward" size={16} color={colors.mutedForeground} />
          </Pressable>
        ))}
        <Pressable
          style={[transferStyles.cancelBtn, { borderColor: colors.border }]}
          onPress={onClose}
        >
          <Text style={[transferStyles.cancelText, { color: colors.mutedForeground }]}>
            Cancelar
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const transferStyles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "flex-end",
    zIndex: 100,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  sheet: {
    padding: 24,
    paddingTop: 12,
  },
  handle: {
    width: 40,
    height: 4,
    backgroundColor: "#d1d5db",
    borderRadius: 2,
    alignSelf: "center",
    marginBottom: 16,
  },
  title: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    marginBottom: 16,
  },
  sectorRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    borderBottomWidth: 1,
    gap: 12,
  },
  sectorIcon: { fontSize: 22 },
  sectorName: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_500Medium",
  },
  cancelBtn: {
    marginTop: 16,
    paddingVertical: 12,
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 10,
  },
  cancelText: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
  },
});

export default function QueueScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [transferEntry, setTransferEntry] = useState<QueueEntry | null>(null);

  const sectorId = user?.sectorId ?? undefined;

  const {
    data: entries = [],
    isLoading,
    isError,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ["queue", sectorId],
    queryFn: () =>
      api.queue.list(sectorId ? { sectorId } : undefined),
    refetchInterval: 8000,
    enabled: user !== null,
  });

  const { data: sectors = [] } = useQuery({
    queryKey: ["sectors"],
    queryFn: () => api.sectors.list(),
  });

  const callMutation = useMutation({
    mutationFn: (id: number) => api.queue.call(id),
    onSuccess: () => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      void queryClient.invalidateQueries({ queryKey: ["queue"] });
    },
  });

  const completeMutation = useMutation({
    mutationFn: (id: number) => api.queue.complete(id),
    onSuccess: () => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      void queryClient.invalidateQueries({ queryKey: ["queue"] });
    },
  });

  const transferMutation = useMutation({
    mutationFn: ({ id, targetSectorId }: { id: number; targetSectorId: number }) =>
      api.queue.transfer(id, targetSectorId),
    onSuccess: () => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setTransferEntry(null);
      void queryClient.invalidateQueries({ queryKey: ["queue"] });
    },
  });

  const removeMutation = useMutation({
    mutationFn: (id: number) => api.queue.remove(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["queue"] });
    },
  });

  const handleRemove = useCallback(
    (entry: QueueEntry) => {
      Alert.alert(
        "Cancelar atendimento",
        `Remover ${entry.clientName} da fila?`,
        [
          { text: "Não", style: "cancel" },
          {
            text: "Remover",
            style: "destructive",
            onPress: () => removeMutation.mutate(entry.id),
          },
        ]
      );
    },
    [removeMutation]
  );

  const active = entries.filter(
    (e) => e.status === "waiting" || e.status === "in_progress"
  );
  const waiting = active.filter((e) => e.status === "waiting");
  const inProgress = active.filter((e) => e.status === "in_progress");

  const styles = makeStyles(colors, insets);

  const renderEntry = useCallback(
    ({ item }: { item: QueueEntry }) => {
      const isInProgress = item.status === "in_progress";
      const myEntry = item.attendantId === user?.id;

      return (
        <View
          style={[
            styles.entryCard,
            isInProgress && myEntry && styles.entryCardActive,
          ]}
        >
          <View style={styles.entryHeader}>
            <View style={styles.positionBadge}>
              <Text style={styles.positionText}>{item.position}</Text>
            </View>
            <View style={styles.entryInfo}>
              <Text style={styles.clientName} numberOfLines={1}>
                {item.clientName}
              </Text>
              {item.clientContact && (
                <Text style={styles.clientContact}>{item.clientContact}</Text>
              )}
            </View>
            <StatusBadge status={item.status} />
          </View>

          <View style={styles.entryMeta}>
            <View style={styles.metaItem}>
              <Ionicons name="time-outline" size={13} color={colors.mutedForeground} />
              <Text style={styles.metaText}>{waitTime(item)}</Text>
            </View>
            {item.channel && (
              <View style={styles.metaItem}>
                <Ionicons
                  name={item.channel === "whatsapp" ? "logo-whatsapp" : "phone-portrait-outline"}
                  size={13}
                  color={colors.mutedForeground}
                />
                <Text style={styles.metaText}>{item.channel}</Text>
              </View>
            )}
          </View>

          {item.notes && (
            <Text style={styles.notes} numberOfLines={2}>
              {item.notes}
            </Text>
          )}

          <View style={styles.actionRow}>
            {item.status === "waiting" && (
              <Pressable
                style={({ pressed }) => [styles.actionBtn, styles.callBtn, pressed && styles.btnPressed]}
                onPress={() => callMutation.mutate(item.id)}
                disabled={callMutation.isPending}
              >
                {callMutation.isPending && callMutation.variables === item.id ? (
                  <ActivityIndicator size="small" color={colors.primaryForeground} />
                ) : (
                  <>
                    <Ionicons name="megaphone-outline" size={16} color={colors.primaryForeground} />
                    <Text style={styles.callBtnText}>Chamar</Text>
                  </>
                )}
              </Pressable>
            )}

            {item.status === "in_progress" && (
              <Pressable
                style={({ pressed }) => [styles.actionBtn, styles.completeBtn, pressed && styles.btnPressed]}
                onPress={() => completeMutation.mutate(item.id)}
                disabled={completeMutation.isPending}
              >
                {completeMutation.isPending && completeMutation.variables === item.id ? (
                  <ActivityIndicator size="small" color={colors.primaryForeground} />
                ) : (
                  <>
                    <Ionicons name="checkmark-circle-outline" size={16} color="#fff" />
                    <Text style={styles.completeBtnText}>Finalizar</Text>
                  </>
                )}
              </Pressable>
            )}

            {(item.status === "waiting" || item.status === "in_progress") && (
              <Pressable
                style={({ pressed }) => [styles.iconBtn, pressed && styles.btnPressed]}
                onPress={() => setTransferEntry(item)}
              >
                <MaterialIcons name="swap-horiz" size={20} color={colors.mutedForeground} />
              </Pressable>
            )}

            <Pressable
              style={({ pressed }) => [styles.iconBtn, pressed && styles.btnPressed]}
              onPress={() => handleRemove(item)}
            >
              <Ionicons name="trash-outline" size={18} color={colors.destructive} />
            </Pressable>
          </View>
        </View>
      );
    },
    [colors, user?.id, callMutation, completeMutation, handleRemove]
  );

  return (
    <View style={styles.root}>
      <View style={styles.topBar}>
        <View>
          <Text style={styles.topBarTitle}>
            {user?.sector?.name ?? "Fila de Atendimento"}
          </Text>
          <Text style={styles.topBarSub}>
            {waiting.length} aguardando · {inProgress.length} em atendimento
          </Text>
        </View>
        <Pressable
          onPress={() => void refetch()}
          disabled={isFetching}
          style={({ pressed }) => [styles.refreshBtn, pressed && { opacity: 0.6 }]}
        >
          <Ionicons
            name="refresh"
            size={22}
            color={colors.primary}
            style={isFetching ? styles.spinning : undefined}
          />
        </Pressable>
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
      ) : active.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="checkmark-done-circle-outline" size={56} color={colors.success} />
          <Text style={styles.emptyTitle}>Fila vazia</Text>
          <Text style={styles.emptySubtitle}>Nenhum cliente aguardando</Text>
        </View>
      ) : (
        <FlatList
          data={active}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderEntry}
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

      {transferEntry && (
        <TransferModal
          entry={transferEntry}
          sectors={sectors}
          onTransfer={(targetSectorId) =>
            transferMutation.mutate({ id: transferEntry.id, targetSectorId })
          }
          onClose={() => setTransferEntry(null)}
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
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    topBarTitle: {
      fontSize: 20,
      fontFamily: "Inter_700Bold",
      color: colors.foreground,
    },
    topBarSub: {
      fontSize: 13,
      fontFamily: "Inter_400Regular",
      color: colors.mutedForeground,
      marginTop: 2,
    },
    refreshBtn: {
      padding: 8,
    },
    spinning: {
      opacity: 0.5,
    },
    center: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: 12,
    },
    emptyTitle: {
      fontSize: 18,
      fontFamily: "Inter_600SemiBold",
      color: colors.foreground,
    },
    emptySubtitle: {
      fontSize: 14,
      fontFamily: "Inter_400Regular",
      color: colors.mutedForeground,
    },
    retryBtn: {
      backgroundColor: colors.primary,
      paddingHorizontal: 20,
      paddingVertical: 10,
      borderRadius: colors.radius,
      marginTop: 4,
    },
    retryText: {
      color: colors.primaryForeground,
      fontFamily: "Inter_600SemiBold",
      fontSize: 14,
    },
    listContent: {
      padding: 16,
      gap: 12,
      paddingBottom: 100,
    },
    entryCard: {
      backgroundColor: colors.card,
      borderRadius: colors.radius,
      padding: 16,
      borderWidth: 1,
      borderColor: colors.border,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.04,
      shadowRadius: 4,
      elevation: 2,
    },
    entryCardActive: {
      borderColor: colors.primary,
      borderWidth: 1.5,
    },
    entryHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      marginBottom: 10,
    },
    positionBadge: {
      width: 36,
      height: 36,
      borderRadius: 10,
      backgroundColor: colors.secondary,
      alignItems: "center",
      justifyContent: "center",
    },
    positionText: {
      fontSize: 15,
      fontFamily: "Inter_700Bold",
      color: colors.primary,
    },
    entryInfo: {
      flex: 1,
    },
    clientName: {
      fontSize: 15,
      fontFamily: "Inter_600SemiBold",
      color: colors.foreground,
    },
    clientContact: {
      fontSize: 12,
      fontFamily: "Inter_400Regular",
      color: colors.mutedForeground,
      marginTop: 1,
    },
    entryMeta: {
      flexDirection: "row",
      gap: 12,
      marginBottom: 6,
    },
    metaItem: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
    },
    metaText: {
      fontSize: 12,
      fontFamily: "Inter_400Regular",
      color: colors.mutedForeground,
    },
    notes: {
      fontSize: 12,
      fontFamily: "Inter_400Regular",
      color: colors.mutedForeground,
      fontStyle: "italic",
      marginBottom: 10,
    },
    actionRow: {
      flexDirection: "row",
      gap: 8,
      marginTop: 6,
    },
    actionBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: colors.radius - 2,
    },
    callBtn: {
      backgroundColor: colors.primary,
    },
    callBtnText: {
      color: colors.primaryForeground,
      fontFamily: "Inter_600SemiBold",
      fontSize: 13,
    },
    completeBtn: {
      backgroundColor: colors.success,
    },
    completeBtnText: {
      color: "#fff",
      fontFamily: "Inter_600SemiBold",
      fontSize: 13,
    },
    iconBtn: {
      padding: 8,
      borderRadius: colors.radius - 2,
      borderWidth: 1,
      borderColor: colors.border,
    },
    btnPressed: {
      opacity: 0.7,
    },
  });
}

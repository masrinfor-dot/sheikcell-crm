import { Ionicons } from "@expo/vector-icons";
import React from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { useColors } from "@/hooks/useColors";
import { api, SectorSummary } from "@/lib/api";

function StatCard({
  value,
  label,
  color,
}: {
  value: number;
  label: string;
  color: string;
}) {
  const colors = useColors();
  return (
    <View style={[statStyles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[statStyles.value, { color }]}>{value}</Text>
      <Text style={[statStyles.label, { color: colors.mutedForeground }]}>{label}</Text>
    </View>
  );
}

const statStyles = StyleSheet.create({
  card: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 8,
    alignItems: "center",
    borderWidth: 1,
  },
  value: {
    fontSize: 26,
    fontFamily: "Inter_700Bold",
  },
  label: {
    fontSize: 10,
    fontFamily: "Inter_500Medium",
    marginTop: 2,
    textAlign: "center",
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
});

function SectorCard({ item }: { item: SectorSummary }) {
  const colors = useColors();
  const total = item.waiting + item.inProgress;
  const pct = item.totalAttendants > 0
    ? Math.round((item.busyAttendants / item.totalAttendants) * 100)
    : 0;

  return (
    <View style={[sectorCardStyles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={sectorCardStyles.header}>
        <View
          style={[
            sectorCardStyles.iconWrap,
            { backgroundColor: item.sector.color + "22" },
          ]}
        >
          <Text style={sectorCardStyles.icon}>{item.sector.icon}</Text>
        </View>
        <View style={sectorCardStyles.titleArea}>
          <Text style={[sectorCardStyles.name, { color: colors.foreground }]}>
            {item.sector.name}
          </Text>
          {item.sector.description && (
            <Text
              style={[sectorCardStyles.desc, { color: colors.mutedForeground }]}
              numberOfLines={1}
            >
              {item.sector.description}
            </Text>
          )}
        </View>
        {total > 0 && (
          <View style={sectorCardStyles.urgencyBadge}>
            <Text style={sectorCardStyles.urgencyText}>{total} na fila</Text>
          </View>
        )}
      </View>

      <View style={sectorCardStyles.stats}>
        <StatCard value={item.waiting} label="Aguardando" color="#d97706" />
        <StatCard value={item.inProgress} label="Em atend." color="#1d4ed8" />
        <StatCard value={item.completedToday} label="Hoje" color="#16a34a" />
      </View>

      <View style={[sectorCardStyles.footer, { borderTopColor: colors.border }]}>
        <View style={sectorCardStyles.attendantInfo}>
          <Ionicons name="people-outline" size={14} color={colors.mutedForeground} />
          <Text style={[sectorCardStyles.attendantText, { color: colors.mutedForeground }]}>
            {item.busyAttendants}/{item.totalAttendants} atendentes ocupados
          </Text>
        </View>
        <View style={sectorCardStyles.progressWrap}>
          <View
            style={[
              sectorCardStyles.progressBar,
              { backgroundColor: colors.border },
            ]}
          >
            <View
              style={[
                sectorCardStyles.progressFill,
                {
                  width: `${pct}%` as `${number}%`,
                  backgroundColor: pct > 80 ? "#ef4444" : pct > 50 ? "#f59e0b" : "#22c55e",
                },
              ]}
            />
          </View>
          <Text style={[sectorCardStyles.pctText, { color: colors.mutedForeground }]}>
            {pct}%
          </Text>
        </View>
      </View>
    </View>
  );
}

const sectorCardStyles = StyleSheet.create({
  card: {
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    marginBottom: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 2,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 14,
    gap: 10,
  },
  iconWrap: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  icon: { fontSize: 22 },
  titleArea: { flex: 1 },
  name: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
  },
  desc: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    marginTop: 1,
  },
  urgencyBadge: {
    backgroundColor: "#fef3c7",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  urgencyText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: "#92400e",
  },
  stats: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 12,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 10,
    borderTopWidth: 1,
    gap: 12,
  },
  attendantInfo: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    flex: 1,
  },
  attendantText: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
  },
  progressWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  progressBar: {
    width: 60,
    height: 4,
    borderRadius: 2,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: 2,
  },
  pctText: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
  },
});

export default function AdminScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();

  const {
    data: summaries = [],
    isLoading,
    isError,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ["admin-summary"],
    queryFn: () => api.admin.summary(),
    refetchInterval: 10000,
  });

  const totalWaiting = summaries.reduce((a, s) => a + s.waiting, 0);
  const totalInProgress = summaries.reduce((a, s) => a + s.inProgress, 0);
  const totalToday = summaries.reduce((a, s) => a + s.completedToday, 0);

  const styles = makeStyles(colors, insets);

  return (
    <View style={styles.root}>
      <View style={styles.topBar}>
        <View>
          <Text style={styles.topBarTitle}>Visão Geral</Text>
          <Text style={styles.topBarSub}>
            {summaries.length} setor{summaries.length !== 1 ? "es" : ""}
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

      {!isLoading && summaries.length > 0 && (
        <View style={styles.summaryRow}>
          <View style={styles.summaryItem}>
            <Text style={[styles.summaryValue, { color: "#d97706" }]}>
              {totalWaiting}
            </Text>
            <Text style={styles.summaryLabel}>Aguardando</Text>
          </View>
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <View style={styles.summaryItem}>
            <Text style={[styles.summaryValue, { color: "#1d4ed8" }]}>
              {totalInProgress}
            </Text>
            <Text style={styles.summaryLabel}>Em atend.</Text>
          </View>
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <View style={styles.summaryItem}>
            <Text style={[styles.summaryValue, { color: "#16a34a" }]}>
              {totalToday}
            </Text>
            <Text style={styles.summaryLabel}>Hoje</Text>
          </View>
        </View>
      )}

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
      ) : (
        <FlatList
          data={summaries}
          keyExtractor={(item) => String(item.sector.id)}
          renderItem={({ item }) => <SectorCard item={item} />}
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
    refreshBtn: { padding: 8 },
    summaryRow: {
      flexDirection: "row",
      backgroundColor: colors.card,
      paddingVertical: 14,
      paddingHorizontal: 20,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    summaryItem: {
      flex: 1,
      alignItems: "center",
    },
    summaryValue: {
      fontSize: 28,
      fontFamily: "Inter_700Bold",
    },
    summaryLabel: {
      fontSize: 11,
      fontFamily: "Inter_500Medium",
      color: colors.mutedForeground,
      textTransform: "uppercase",
      letterSpacing: 0.3,
      marginTop: 2,
    },
    divider: {
      width: 1,
      height: "100%",
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
      paddingBottom: 100,
    },
  });
}

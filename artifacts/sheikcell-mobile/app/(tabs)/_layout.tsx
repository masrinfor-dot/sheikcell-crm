import { BlurView } from "expo-blur";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import { Tabs } from "expo-router";
import { Icon, Label, NativeTabs } from "expo-router/unstable-native-tabs";
import { SymbolView } from "expo-symbols";
import { Feather, Ionicons } from "@expo/vector-icons";
import React from "react";
import { Platform, StyleSheet, View, useColorScheme } from "react-native";

import { useAuth } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";

function NativeTabLayoutAttendant() {
  return (
    <NativeTabs>
      <NativeTabs.Trigger name="index">
        <Icon sf={{ default: "list.bullet", selected: "list.bullet" }} />
        <Label>Fila</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="profile">
        <Icon sf={{ default: "person", selected: "person.fill" }} />
        <Label>Perfil</Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}

function NativeTabLayoutAdmin() {
  return (
    <NativeTabs>
      <NativeTabs.Trigger name="admin">
        <Icon sf={{ default: "chart.bar", selected: "chart.bar.fill" }} />
        <Label>Setores</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="index">
        <Icon sf={{ default: "list.bullet", selected: "list.bullet" }} />
        <Label>Fila</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="profile">
        <Icon sf={{ default: "person", selected: "person.fill" }} />
        <Label>Perfil</Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}

function ClassicTabLayout({ isAdmin }: { isAdmin: boolean }) {
  const colors = useColors();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const isIOS = Platform.OS === "ios";
  const isWeb = Platform.OS === "web";

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.mutedForeground,
        tabBarStyle: {
          position: "absolute",
          backgroundColor: isIOS ? "transparent" : colors.background,
          borderTopWidth: isWeb ? 1 : 0,
          borderTopColor: colors.border,
          elevation: 0,
          ...(isWeb ? { height: 84 } : {}),
        },
        tabBarBackground: () =>
          isIOS ? (
            <BlurView
              intensity={100}
              tint={isDark ? "dark" : "light"}
              style={StyleSheet.absoluteFill}
            />
          ) : isWeb ? (
            <View
              style={[
                StyleSheet.absoluteFill,
                { backgroundColor: colors.background },
              ]}
            />
          ) : null,
      }}
    >
      {isAdmin && (
        <Tabs.Screen
          name="admin"
          options={{
            title: "Setores",
            tabBarIcon: ({ color }) =>
              isIOS ? (
                <SymbolView name="chart.bar" tintColor={color} size={22} />
              ) : (
                <Ionicons name="bar-chart-outline" size={22} color={color} />
              ),
          }}
        />
      )}
      <Tabs.Screen
        name="index"
        options={{
          title: "Fila",
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="list.bullet" tintColor={color} size={22} />
            ) : (
              <Feather name="list" size={22} color={color} />
            ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: "Perfil",
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="person" tintColor={color} size={22} />
            ) : (
              <Feather name="user" size={22} color={color} />
            ),
        }}
      />
      {!isAdmin && (
        <Tabs.Screen
          name="admin"
          options={{ href: null }}
        />
      )}
    </Tabs>
  );
}

export default function TabLayout() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin" || user?.role === "supervisor";

  if (isLiquidGlassAvailable()) {
    return isAdmin ? <NativeTabLayoutAdmin /> : <NativeTabLayoutAttendant />;
  }
  return <ClassicTabLayout isAdmin={isAdmin} />;
}

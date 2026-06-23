const BASE = "/api";

async function req<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...opts?.headers },
    ...opts,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}

export type User = {
  id: number;
  name: string;
  email: string;
  role: string;
  sectorId: number | null;
  sector: Sector | null;
};

export type Sector = {
  id: number;
  name: string;
  description: string | null;
  icon: string;
  color: string;
  isActive: boolean;
};

export type QueueEntry = {
  id: number;
  clientName: string;
  clientContact: string | null;
  sectorId: number;
  channel: string;
  status: string;
  attendantId: number | null;
  notes: string | null;
  position: number;
  calledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AttendanceLog = {
  id: number;
  queueEntryId: number;
  clientName: string;
  clientContact: string | null;
  sectorId: number;
  sectorName: string;
  attendantId: number | null;
  attendantName: string | null;
  channel: string;
  outcome: string | null;
  notes: string | null;
  waitTimeSeconds: number | null;
  serviceTimeSeconds: number | null;
  createdAt: string;
};

export type SectorSummary = {
  sector: Sector;
  waiting: number;
  inProgress: number;
  completedToday: number;
  totalAttendants: number;
  busyAttendants: number;
};

export type CrmContact = {
  id: number;
  name: string;
  contact: string | null;
  sectorId: number | null;
  attendantId: number | null;
  status: "potential" | "pending" | "active";
  notes: string | null;
  tags: string | null;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
  sector: Sector | null;
  attendant: { id: number; name: string } | null;
};

export type Conversation = {
  id: number;
  phone: string;
  name: string;
  avatarUrl: string | null;
  channel: string;
  sectorId: number | null;
  assigneeId: number | null;
  status: string;
  labels: string | null;
  unreadCount: number;
  lastMessage: string | null;
  lastMessageAt: string | null;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
  sector: Sector | null;
  assignee: { id: number; name: string } | null;
};

export type RoutingRule = {
  id: number;
  sectorId: number;
  name: string;
  keywords: string;
  priority: number;
  isActive: boolean;
  createdAt: string;
};

export type ClassifyResult = {
  sectorId: number | null;
  ruleName: string | null;
  matchedKeyword: string | null;
};

export type ChatMessage = {
  id: number;
  conversationId: number;
  content: string;
  direction: "inbound" | "outbound";
  type: string;
  status: string;
  senderName: string | null;
  mediaUrl: string | null;
  externalId: string | null;
  createdAt: string;
};

export const api = {
  auth: {
    login: (email: string, password: string) =>
      req<{ user: User }>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
    logout: () => req<{ ok: boolean }>("/auth/logout", { method: "POST" }),
    me: () => req<{ user: User }>("/auth/me"),
  },
  sectors: {
    list: () => req<Sector[]>("/sectors"),
    listAll: () => req<Sector[]>("/sectors/all"),
    create: (data: Partial<Sector>) => req<Sector>("/sectors", { method: "POST", body: JSON.stringify(data) }),
    update: (id: number, data: Partial<Sector>) => req<Sector>(`/sectors/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  },
  queue: {
    list: (params?: { sectorId?: number; status?: string }) => {
      const qs = new URLSearchParams();
      if (params?.sectorId) qs.set("sectorId", String(params.sectorId));
      if (params?.status) qs.set("status", params.status);
      return req<QueueEntry[]>(`/queue?${qs.toString()}`);
    },
    add: (data: { clientName: string; clientContact?: string; sectorId: number; channel?: string; notes?: string }) =>
      req<QueueEntry>("/queue", { method: "POST", body: JSON.stringify(data) }),
    call: (id: number) => req<QueueEntry>(`/queue/${id}/call`, { method: "PATCH" }),
    complete: (id: number) => req<QueueEntry>(`/queue/${id}/complete`, { method: "PATCH" }),
    transfer: (id: number, targetSectorId: number) =>
      req<QueueEntry>(`/queue/${id}/transfer`, { method: "PATCH", body: JSON.stringify({ targetSectorId }) }),
    remove: (id: number) => req<{ ok: boolean }>(`/queue/${id}`, { method: "DELETE" }),
  },
  chat: {
    conversations: (params?: { search?: string; status?: string; label?: string; sectorId?: number }) => {
      const qs = new URLSearchParams();
      if (params?.search) qs.set("search", params.search);
      if (params?.status) qs.set("status", params.status);
      if (params?.label) qs.set("label", params.label);
      if (params?.sectorId) qs.set("sectorId", String(params.sectorId));
      return req<Conversation[]>(`/chat/conversations?${qs.toString()}`);
    },
    messages: (id: number) => req<ChatMessage[]>(`/chat/conversations/${id}/messages`),
    sendMessage: (id: number, content: string) =>
      req<ChatMessage>(`/chat/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ content }) }),
    updateConversation: (id: number, data: Partial<{ status: string; labels: string; sectorId: number; assigneeId: number; name: string; isArchived: boolean }>) =>
      req<Conversation>(`/chat/conversations/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    createConversation: (data: { phone: string; name: string; channel?: string; sectorId?: number }) =>
      req<Conversation>("/chat/conversations", { method: "POST", body: JSON.stringify(data) }),
  },
  routing: {
    rules: () => req<RoutingRule[]>("/routing/rules"),
    create: (data: { sectorId: number; name: string; keywords: string; priority?: number }) =>
      req<RoutingRule>("/routing/rules", { method: "POST", body: JSON.stringify(data) }),
    update: (id: number, data: Partial<{ name: string; keywords: string; priority: number; isActive: boolean; sectorId: number }>) =>
      req<RoutingRule>(`/routing/rules/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    remove: (id: number) => req<{ ok: boolean }>(`/routing/rules/${id}`, { method: "DELETE" }),
    classify: (text: string) => req<ClassifyResult>("/routing/classify", { method: "POST", body: JSON.stringify({ text }) }),
  },
  crm: {
    list: () => req<CrmContact[]>("/crm"),
    create: (data: { name: string; contact?: string; sectorId?: number; attendantId?: number; status?: string; notes?: string; tags?: string }) =>
      req<CrmContact>("/crm", { method: "POST", body: JSON.stringify(data) }),
    update: (id: number, data: Partial<{ name: string; contact: string; sectorId: number; attendantId: number; status: string; notes: string; tags: string; isArchived: boolean }>) =>
      req<CrmContact>(`/crm/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    remove: (id: number) => req<{ ok: boolean }>(`/crm/${id}`, { method: "DELETE" }),
  },
  admin: {
    summary: () => req<SectorSummary[]>("/admin/summary"),
    logs: (params?: { limit?: number; sectorId?: number }) => {
      const qs = new URLSearchParams();
      if (params?.limit) qs.set("limit", String(params.limit));
      if (params?.sectorId) qs.set("sectorId", String(params.sectorId));
      return req<AttendanceLog[]>(`/admin/logs?${qs.toString()}`);
    },
    users: {
      list: () => req<(User & { isActive: boolean; createdAt: string })[]>("/admin/users"),
      create: (data: { name: string; email: string; password: string; role: string; sectorId: number }) =>
        req<User>("/admin/users", { method: "POST", body: JSON.stringify(data) }),
      update: (id: number, data: Partial<{ name: string; email: string; password: string; role: string; sectorId: number; isActive: boolean }>) =>
        req<User>(`/admin/users/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    },
  },
};

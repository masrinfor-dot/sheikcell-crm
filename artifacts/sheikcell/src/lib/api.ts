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

export type InternalConversation = {
  id: number;
  kind: "direct" | "general";
  name: string;
  otherUser: { id: number; name: string; role: string } | null;
  lastMessage: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
};

export type InternalMessage = {
  id: number;
  conversationId: number;
  senderId: number;
  senderName: string;
  content: string;
  createdAt: string;
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
  phone: string | null;
  email: string | null;
  sectorId: number | null;
  attendantId: number | null;
  status: "potential" | "pending" | "active";
  profile: "Novo" | "Regular" | "VIP" | "Inativo";
  isNew: boolean;
  city: string | null;
  serviceStore: string | null;
  attendanceSource: string | null;
  notes: string | null;
  tags: string | null;
  totalPurchases: string;
  customFields: Record<string, string>;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
  sector: Sector | null;
  attendant: { id: number; name: string } | null;
};

export type CrmCustomFieldType = "text" | "number" | "date" | "select" | "textarea";

export type CrmCustomField = {
  id: number;
  name: string;
  type: CrmCustomFieldType;
  options: string | null;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
};

export type CrmPurchase = {
  id: number;
  contactId: number;
  description: string;
  amount: string;
  purchaseDate: string;
  category: string | null;
  notes: string | null;
  createdAt: string;
};

export type CrmInternalNote = {
  id: number;
  contactId: number;
  content: string;
  authorId: number | null;
  authorName: string | null;
  createdAt: string;
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
  participants: { id: number; name: string }[];
};

export type ChatLabel = {
  id: number;
  name: string;
  color: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
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
    suggestReply: (id: number) =>
      req<{ suggestion: string }>(`/chat/conversations/${id}/suggest-reply`, { method: "POST" }),
    sendMedia: (id: number, file: File, caption?: string): Promise<ChatMessage> => {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const base64 = dataUrl.split(",")[1];
          req<ChatMessage>(`/chat/conversations/${id}/media`, {
            method: "POST",
            body: JSON.stringify({ base64, mimetype: file.type, filename: file.name, caption }),
          }).then(resolve).catch(reject);
        };
        reader.onerror = () => reject(new Error("Falha ao ler arquivo"));
        reader.readAsDataURL(file);
      });
    },
    updateConversation: (id: number, data: Partial<{ status: string; labels: string; sectorId: number; assigneeId: number; name: string; isArchived: boolean }>) =>
      req<Conversation>(`/chat/conversations/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    createConversation: (data: { phone: string; name: string; channel?: string; sectorId?: number }) =>
      req<Conversation>("/chat/conversations", { method: "POST", body: JSON.stringify(data) }),
    claimConversation: (id: number) =>
      req<Conversation>(`/chat/conversations/${id}/claim`, { method: "POST" }),
    participants: {
      add: (convId: number, userId: number) =>
        req<{ ok: boolean }>(`/chat/conversations/${convId}/participants`, { method: "POST", body: JSON.stringify({ userId }) }),
      remove: (convId: number, userId: number) =>
        req<{ ok: boolean }>(`/chat/conversations/${convId}/participants/${userId}`, { method: "DELETE" }),
    },
    labels: {
      list: () => req<ChatLabel[]>("/chat/labels"),
      create: (data: { name: string; color?: string; sortOrder?: number }) =>
        req<ChatLabel>("/chat/labels", { method: "POST", body: JSON.stringify(data) }),
      update: (id: number, data: Partial<{ name: string; color: string; sortOrder: number; isActive: boolean }>) =>
        req<ChatLabel>(`/chat/labels/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
      remove: (id: number) => req<{ ok: boolean }>(`/chat/labels/${id}`, { method: "DELETE" }),
    },
  },
  chatUsers: () => req<{ id: number; name: string; role: string }[]>("/chat/users"),
  internalChat: {
    conversations: () => req<InternalConversation[]>("/internal-chat/conversations"),
    startDirect: (userId: number) =>
      req<InternalConversation>("/internal-chat/conversations/direct", { method: "POST", body: JSON.stringify({ userId }) }),
    messages: (id: number) => req<InternalMessage[]>(`/internal-chat/conversations/${id}/messages`),
    send: (id: number, content: string) =>
      req<InternalMessage>(`/internal-chat/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ content }) }),
    markRead: (id: number) => req<{ ok: boolean }>(`/internal-chat/conversations/${id}/read`, { method: "POST" }),
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
    list: (params?: { profile?: string; status?: string; search?: string }) => {
      const qs = new URLSearchParams();
      if (params?.profile) qs.set("profile", params.profile);
      if (params?.status) qs.set("status", params.status);
      if (params?.search) qs.set("search", params.search);
      return req<CrmContact[]>(`/crm?${qs.toString()}`);
    },
    get: (id: number) => req<CrmContact>(`/crm/${id}`),
    create: (data: Partial<Omit<CrmContact, "id" | "createdAt" | "updatedAt" | "sector" | "attendant">>) =>
      req<CrmContact>("/crm", { method: "POST", body: JSON.stringify(data) }),
    update: (id: number, data: Partial<Omit<CrmContact, "id" | "createdAt" | "updatedAt" | "sector" | "attendant">>) =>
      req<CrmContact>(`/crm/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    remove: (id: number) => req<{ ok: boolean }>(`/crm/${id}`, { method: "DELETE" }),
    autoRegister: (data: { name: string; phone?: string; contact?: string; sectorId?: number }) =>
      req<CrmContact & { created: boolean }>("/crm/auto-register", { method: "POST", body: JSON.stringify(data) }),
    purchases: {
      list: (contactId: number) => req<CrmPurchase[]>(`/crm/${contactId}/purchases`),
      create: (contactId: number, data: { description: string; amount?: string | number; purchaseDate?: string; category?: string; notes?: string }) =>
        req<CrmPurchase>(`/crm/${contactId}/purchases`, { method: "POST", body: JSON.stringify(data) }),
      remove: (purchaseId: number) => req<{ ok: boolean }>(`/crm/purchases/${purchaseId}`, { method: "DELETE" }),
    },
    notes: {
      list: (contactId: number) => req<CrmInternalNote[]>(`/crm/${contactId}/notes`),
      create: (contactId: number, content: string) =>
        req<CrmInternalNote>(`/crm/${contactId}/notes`, { method: "POST", body: JSON.stringify({ content }) }),
      remove: (noteId: number) => req<{ ok: boolean }>(`/crm/notes/${noteId}`, { method: "DELETE" }),
    },
    serviceHistory: (contactId: number) => req<AttendanceLog[]>(`/crm/${contactId}/service-history`),
    customFields: {
      list: () => req<CrmCustomField[]>("/crm/custom-fields"),
      create: (data: { name: string; type?: CrmCustomFieldType; options?: string; sortOrder?: number }) =>
        req<CrmCustomField>("/crm/custom-fields", { method: "POST", body: JSON.stringify(data) }),
      update: (id: number, data: Partial<{ name: string; type: CrmCustomFieldType; options: string; sortOrder: number; isActive: boolean }>) =>
        req<CrmCustomField>(`/crm/custom-fields/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
      remove: (id: number) => req<{ ok: boolean }>(`/crm/custom-fields/${id}`, { method: "DELETE" }),
    },
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

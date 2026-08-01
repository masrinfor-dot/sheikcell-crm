const BASE = "/api";
export const API_BASE = BASE;

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

export type VendedorPermissions = Record<string, boolean> | null;

// Chaves de permissão individuais do vendedor (null/ausente = liberado).
export const PERMISSION_KEYS = [
  "ver_potenciais",
  "transferir",
  "finalizar",
  "criar_atendimento",
  "usar_ia",
  "crm",
  "tarefas",
  "enviar_midia",
  "equipe",
  "financeiras",
  "peliculas",
  "avaliacao",
  "treinamentos",
  "planilhas",
] as const;

export const PERMISSION_LABELS: Record<string, string> = {
  ver_potenciais: "Ver e assumir Potenciais (leads novos)",
  transferir: "Transferir conversa para outro setor",
  finalizar: "Finalizar atendimentos",
  criar_atendimento: "Criar novo atendimento manualmente",
  usar_ia: "Usar sugestão de resposta com IA",
  crm: "Acessar o CRM",
  tarefas: "Acessar o quadro de Tarefas",
  enviar_midia: "Enviar fotos, áudios e arquivos",
  equipe: "Aba Equipe (chat interno)",
  financeiras: "Aba Financeiras (bancos)",
  peliculas: "Aba Películas",
  avaliacao: "Aba Avaliação (aparelho usado)",
  treinamentos: "Aba Treinamentos",
  planilhas: "Aba Planilhas",
};

export type User = {
  id: number;
  name: string;
  email: string;
  role: string;
  sectorId: number | null;
  storeName?: string | null;
  mustChangePassword?: boolean;
  adminAccess?: string[] | null;
  accessHours?: { start: string; end: string; days: number[] } | null;
  sector: Sector | null;
  permissions?: VendedorPermissions;
};

// Tem a permissão? (admin sempre tem; vendedor/supervisor: ausência = liberado)
export function can(user: User | null, key: string): boolean {
  if (!user) return false;
  if (user.role === "admin") return true;
  return user.permissions?.[key] !== false;
}

export type InternalConversation = {
  id: number;
  kind: "direct" | "general" | "group";
  name: string;
  otherUser: { id: number; name: string; role: string } | null;
  memberNames?: string[];
  lastMessage: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
};

export type Store = {
  id: number;
  name: string;
  isActive: boolean;
  createdAt: string;
};

export type TeamStatusRow = {
  id: number;
  name: string;
  role: string;
  sectorId: number | null;
  online: boolean;
  lastSeenAt: string | null;
  lastLoginAt: string | null;
};

export type DocumentItem = {
  id: number;
  title: string;
  category: string; // ata | documento | comunicado | contrato
  description: string | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  uploadedBy: number | null;
  uploaderName: string | null;
};

export type InternalMessage = {
  id: number;
  conversationId: number;
  senderId: number;
  senderName: string;
  content: string;
  createdAt: string;
};

export type FinanceVendedorRow = {
  vendedorId: number; nome: string; loja: string | null; ativo: boolean;
  finalizados: number; vendas: number; totalVendido: number; ticketMedio: number;
  conversao: number; orcamentos: number; vaiPensar: number; semInteresse: number;
  emProspeccao: number;
};

export type FinanceSummary = {
  days: number; sectorId: number | null;
  totals: { finalizados: number; vendas: number; totalVendido: number; orcamentos: number; emProspeccao: number; ticketMedio: number; conversao: number };
  vendedores: FinanceVendedorRow[];
};

export type ResultsRankingRow = {
  attendantId: number; name: string; ativo: boolean;
  atendimentos: number; avgServiceSeconds: number;
  vendas: number; totalVendido: number; conversao: number;
  avgRating: number; ratings: number;
};
export type BotQuestion = { question: string; options?: string[] };

export type BotSettings = {
  id: number; enabled: boolean; botName: string; greeting: string;
  questions: BotQuestion[]; knowledgeBase: string;
  doneMessage: string; handoffMessage: string;
  mode: "always" | "off_hours"; hoursStart: string; hoursEnd: string;
  urgencyWords: string; maxPerConversation: number; maxPerDay: number;
  usageToday: number;
};

export type Raffle = {
  id: number; name: string; prize: string;
  sectorIds: number[] | null; vendedorIds: number[] | null; sessionKeys: string[] | null;
  clientTypes: string[] | null;
  periodDays: number | null; onlyResolved: boolean; surveyRespondedOnly: boolean; excludePreviousWinners: boolean;
  winnersCount: number; messageTemplate: string; storeName: string | null;
  recurrence: "once" | "weekly" | "monthly"; dayOfWeek: number | null; dayOfMonth: number | null;
  active: boolean; lastRunKey: string | null; createdAt: string;
};

// Configuração da pesquisa de satisfação (admin/supervisor)
export type SurveySettings = {
  enabled: boolean;
  scaleMax: 5 | 10;
  message: string;
  responseWindowHours: number;
  rewardEnabled: boolean;
  rewardText: string;
  raffleInvite: boolean;
};

export type RaffleWinner = { phone: string; name: string; conversationId: number; sent: boolean; error?: string };

export type RaffleDraw = {
  id: number; raffleId: number; periodKey: string; eligibleCount: number;
  winners: RaffleWinner[]; createdAt: string;
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
  resolutionReason: string | null;
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

export type TaskStatus = "todo" | "doing" | "done";
export type TaskPriority = "baixa" | "media" | "alta";

export type Task = {
  id: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeId: number | null;
  createdById: number | null;
  sectorId: number | null;
  dueDate: string | null;
  position: number;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
  sector: Sector | null;
  assignee: { id: number; name: string } | null;
  createdBy: { id: number; name: string } | null;
  subtaskTotal?: number;
  subtaskDone?: number;
  commentCount?: number;
};

export type TaskComment = {
  id: number; taskId: number; authorId: number | null;
  authorName: string | null; content: string; createdAt: string;
};

export type TaskSubtask = {
  id: number; taskId: number; title: string; isDone: boolean; position: number; createdAt: string;
};

export type QuizQuestion = { id: string; label: string; options: string[]; correct?: number };
export type Training = {
  id: number; title: string; description: string | null;
  type: "text" | "video" | "quiz"; content: string | null;
  quiz: QuizQuestion[] | null; mandatory: boolean;
  targetRoles?: string[]; active?: boolean; createdAt?: string;
  completed?: boolean; myScore?: number | null;
};
export type TrainingCompletion = {
  id: number; userId: number; userName: string | null;
  quizScore: number | null; createdAt: string;
};

export type ChecklistQuestion = { id: string; label: string; type: "text" | "options" | "rating"; options?: string[] };
export type Checklist = {
  id: number; title: string; description: string | null;
  questions: ChecklistQuestion[]; targetRoles: string[];
  recurrence: "daily" | "weekly" | "once"; dayOfWeek: number | null;
  startDate: string | null; mandatory: boolean; active: boolean; createdAt: string;
};
export type PendingChecklist = {
  id: number; title: string; description: string | null;
  questions: ChecklistQuestion[]; mandatory: boolean; periodKey: string;
};
export type ChecklistResponse = {
  id: number; userId: number; userName: string | null;
  periodKey: string; answers: Record<string, string>; createdAt: string;
};

export type TradeInEvaluation = {
  id: number; userId: number | null; userName?: string | null;
  device: string; answers: Record<string, string>;
  brand: string | null; model: string | null; memory: string | null; color: string | null;
  marketPrice: string | null; suggestedPrice: string | null;
  aiSummary: string | null; createdAt: string;
};

export type FilmCompat = {
  id: number; film: string; models: string; notes: string | null;
  createdAt: string; updatedAt: string;
};

export type RhQuestion = { id: string; label: string; type: "text" | "longtext" | "options"; options?: string[] };
export type RhStage = { id: string; title: string; description: string; type: "form" | "video"; enabled: boolean; questions: RhQuestion[] };
export type RhCandidate = {
  id: number; name: string; phone: string; email: string | null;
  status: "novo" | "aprovado" | "reprovado";
  answers: Record<string, Record<string, string>>;
  stagesSnapshot: RhStage[] | null;
  notes: string | null; hasVideo: boolean; createdAt: string;
};

export type SheetLink = {
  id: number; name: string; url: string; position: number; createdAt: string;
};

export type PartnerLink = {
  id: number; name: string; url: string; position: number; createdAt: string;
};

export type AppSettings = {
  alertUnansweredEnabled: boolean;
  alertUnansweredMinutes: number;
};

export type TaskReportBucket = {
  name: string; total: number; todo: number; doing: number; done: number; overdue: number;
};

export type Conversation = {
  id: number;
  phone: string;
  name: string;
  avatarUrl: string | null;
  channel: string;
  sessionKey: string;
  sectorId: number | null;
  assigneeId: number | null;
  status: string;
  labels: string | null;
  unreadCount: number;
  lastMessage: string | null;
  lastMessageDirection: string | null;
  attendanceStartedAt: string | null;
  lastMessageAt: string | null;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
  sector: Sector | null;
  assignee: { id: number; name: string } | null;
  participants: { id: number; name: string }[];
  crmProfile?: string | null;
  pinned?: boolean;
};

export type ScheduledMessage = {
  id: number;
  conversationId: number;
  kind: "mensagem" | "retorno";
  content: string;
  sendAt: string;
  status: string;
  taskId: number | null;
  createdAt: string;
};

export type QuickReply = {
  id: number;
  title: string;
  content: string;
  sectorId: number | null;
  createdAt: string;
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
    changePassword: (currentPassword: string, newPassword: string) =>
      req<{ ok: boolean }>("/auth/change-password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) }),
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
    // Conexões de WhatsApp (números de atendimento) — para etiquetar conversas.
    waSessions: () => req<{ sessionKey: string; displayName: string | null; phoneNumber: string | null }[]>("/chat/wa-sessions"),
    conversations: (params?: { search?: string; status?: string; label?: string; sectorId?: number }) => {
      const qs = new URLSearchParams();
      if (params?.search) qs.set("search", params.search);
      if (params?.status) qs.set("status", params.status);
      if (params?.label) qs.set("label", params.label);
      if (params?.sectorId) qs.set("sectorId", String(params.sectorId));
      return req<Conversation[]>(`/chat/conversations?${qs.toString()}`);
    },
    pinConversation: (id: number) => req<{ ok: boolean }>(`/chat/conversations/${id}/pin`, { method: "POST" }),
    unpinConversation: (id: number) => req<{ ok: boolean }>(`/chat/conversations/${id}/pin`, { method: "DELETE" }),
    messages: (id: number) => req<ChatMessage[]>(`/chat/conversations/${id}/messages`),
    sendMessage: (id: number, content: string) =>
      req<ChatMessage>(`/chat/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ content }) }),
    suggestReply: (id: number) =>
      req<{ suggestion: string }>(`/chat/conversations/${id}/suggest-reply`, { method: "POST" }),
    correctText: (text: string) =>
      req<{ corrected: string }>(`/chat/correct-text`, { method: "POST", body: JSON.stringify({ text }) }),
    sendMedia: (id: number, file: File, caption?: string, opts?: { ptt?: boolean }): Promise<ChatMessage> => {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const base64 = dataUrl.split(",")[1];
          req<ChatMessage>(`/chat/conversations/${id}/media`, {
            method: "POST",
            body: JSON.stringify({ base64, mimetype: file.type, filename: file.name, caption, ptt: opts?.ptt }),
          }).then(resolve).catch(reject);
        };
        reader.onerror = () => reject(new Error("Falha ao ler arquivo"));
        reader.readAsDataURL(file);
      });
    },
    updateConversation: (id: number, data: Partial<{ status: string; labels: string; sectorId: number; assigneeId: number; name: string; isArchived: boolean; resolutionReason: string | null; hadSale: boolean; saleAmount: number; saleDescription: string }>) =>
      req<Conversation>(`/chat/conversations/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    deleteConversation: (id: number) =>
      req<{ ok: boolean }>(`/chat/conversations/${id}`, { method: "DELETE" }),
    createConversation: (data: { phone: string; name: string; channel?: string; sectorId?: number }) =>
      req<Conversation>("/chat/conversations", { method: "POST", body: JSON.stringify(data) }),
    claimConversation: (id: number) =>
      req<Conversation>(`/chat/conversations/${id}/claim`, { method: "POST" }),
    participants: {
      add: (convId: number, userId: number) =>
        req<{ ok: boolean; conversation?: Conversation }>(`/chat/conversations/${convId}/participants`, { method: "POST", body: JSON.stringify({ userId }) }),
      remove: (convId: number, userId: number) =>
        req<{ ok: boolean }>(`/chat/conversations/${convId}/participants/${userId}`, { method: "DELETE" }),
    },
    schedules: {
      list: (convId: number) => req<ScheduledMessage[]>(`/chat/conversations/${convId}/schedules`),
      create: (convId: number, data: { kind: "mensagem" | "retorno"; content: string; sendAt: string }) =>
        req<ScheduledMessage>(`/chat/conversations/${convId}/schedules`, { method: "POST", body: JSON.stringify(data) }),
      cancel: (id: number) => req<{ ok: boolean }>(`/chat/schedules/${id}`, { method: "DELETE" }),
    },
    quickReplies: {
      list: () => req<QuickReply[]>("/chat/quick-replies"),
      create: (data: { title: string; content: string; sectorId?: number | null }) =>
        req<QuickReply>("/chat/quick-replies", { method: "POST", body: JSON.stringify(data) }),
      update: (id: number, data: Partial<{ title: string; content: string; sectorId: number | null }>) =>
        req<QuickReply>(`/chat/quick-replies/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
      remove: (id: number) => req<{ ok: boolean }>(`/chat/quick-replies/${id}`, { method: "DELETE" }),
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
  chatUsers: () => req<{ id: number; name: string; role: string; sectorId: number | null }[]>("/chat/users"),

  internalChat: {
    conversations: () => req<InternalConversation[]>("/internal-chat/conversations"),
    startDirect: (userId: number) =>
      req<InternalConversation>("/internal-chat/conversations/direct", { method: "POST", body: JSON.stringify({ userId }) }),
    createGroup: (name: string, memberIds: number[]) =>
      req<InternalConversation>("/internal-chat/conversations/group", { method: "POST", body: JSON.stringify({ name, memberIds }) }),
    messages: (id: number) => req<InternalMessage[]>(`/internal-chat/conversations/${id}/messages`),
    send: (id: number, content: string) =>
      req<InternalMessage>(`/internal-chat/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ content }) }),
    markRead: (id: number) => req<{ ok: boolean }>(`/internal-chat/conversations/${id}/read`, { method: "POST" }),
    deleteGroup: (id: number) => req<{ ok: boolean }>(`/internal-chat/conversations/${id}`, { method: "DELETE" }),
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
  trainings: {
    pending: () => req<Training[]>("/trainings/pending"),
    list: () => req<Training[]>("/trainings"),
    complete: (id: number, answers?: Record<string, number>) =>
      req<{ ok: boolean; score: number | null }>(`/trainings/${id}/complete`, { method: "POST", body: JSON.stringify({ answers }) }),
    create: (data: Partial<Training>) => req<Training>("/trainings", { method: "POST", body: JSON.stringify(data) }),
    update: (id: number, data: Partial<Training>) => req<Training>(`/trainings/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    remove: (id: number) => req<{ ok: boolean }>(`/trainings/${id}`, { method: "DELETE" }),
    completions: (id: number) => req<TrainingCompletion[]>(`/trainings/${id}/completions`),
  },
  checklists: {
    pending: () => req<PendingChecklist[]>("/checklists/pending"),
    respond: (id: number, answers: Record<string, string>) =>
      req<{ id: number }>(`/checklists/${id}/respond`, { method: "POST", body: JSON.stringify({ answers }) }),
    list: () => req<Checklist[]>("/checklists"),
    create: (data: Partial<Checklist>) => req<Checklist>("/checklists", { method: "POST", body: JSON.stringify(data) }),
    update: (id: number, data: Partial<Checklist>) => req<Checklist>(`/checklists/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    remove: (id: number) => req<{ ok: boolean }>(`/checklists/${id}`, { method: "DELETE" }),
    responses: (id: number) => req<ChecklistResponse[]>(`/checklists/${id}/responses`),
  },
  tradeIn: {
    list: () => req<TradeInEvaluation[]>("/trade-in"),
    evaluate: (data: { device?: string; brand?: string; model?: string; memory?: string; color?: string; answers: Record<string, string> }) =>
      req<{ id: number; device: string; marketPrice: string; suggestedPrice: string; summary: string; createdAt: string }>(
        "/trade-in/evaluate", { method: "POST", body: JSON.stringify(data) }),
  },
  results: {
    summary: (params?: { from?: string; to?: string; sectorId?: number; attendantId?: number }) => {
      const qs = new URLSearchParams();
      if (params?.from) qs.set("from", params.from);
      if (params?.to) qs.set("to", params.to);
      if (params?.sectorId) qs.set("sectorId", String(params.sectorId));
      if (params?.attendantId) qs.set("attendantId", String(params.attendantId));
      return req<ResultsSummary>(`/results/summary?${qs.toString()}`);
    },
  },
  finance: {
    summary: (days: number, sectorId?: number | null) =>
      req<FinanceSummary>(`/finance/summary?days=${days}${sectorId ? `&sectorId=${sectorId}` : ""}`),
  },
  bot: {
    settings: () => req<BotSettings>("/bot/settings"),
    save: (data: Partial<BotSettings>) => req<BotSettings>("/bot/settings", { method: "PUT", body: JSON.stringify(data) }),
    stats: () => req<{ conversations: number; activeFlows: number; usageToday: number }>("/bot/stats"),
    test: (message: string, reset?: boolean) =>
      req<{ replies: string[]; ended?: boolean; reset?: boolean }>("/bot/test", { method: "POST", body: JSON.stringify({ message, reset }) }),
  },
  surveySettings: {
    get: () => req<SurveySettings>("/settings/survey"),
    save: (data: Partial<SurveySettings>) => req<SurveySettings>("/settings/survey", { method: "PATCH", body: JSON.stringify(data) }),
  },
  raffles: {
    list: () => req<Raffle[]>("/raffles"),
    create: (data: Partial<Raffle>) => req<Raffle>("/raffles", { method: "POST", body: JSON.stringify(data) }),
    update: (id: number, data: Partial<Raffle>) => req<Raffle>(`/raffles/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    remove: (id: number) => req<{ ok: boolean }>(`/raffles/${id}`, { method: "DELETE" }),
    eligible: (id: number) => req<{ count: number }>(`/raffles/${id}/eligible`),
    run: (id: number) => req<{ draw: RaffleDraw; eligible: number }>(`/raffles/${id}/run`, { method: "POST" }),
    draws: (id: number) => req<RaffleDraw[]>(`/raffles/${id}/draws`),
    resend: (id: number, drawId: number, phone: string) =>
      req<{ draw: RaffleDraw; sent: boolean }>(`/raffles/${id}/draws/${drawId}/resend`, { method: "POST", body: JSON.stringify({ phone }) }),
  },
  filmCompat: {
    import: (fileData: string, mode: "replace" | "append") =>
      req<{ ok: boolean; imported: number; skipped: number; errors: string[]; mode: string }>(
        "/film-compat/import", { method: "POST", body: JSON.stringify({ fileData, mode }) }),
    list: () => req<FilmCompat[]>("/film-compat"),
    getSheet: () => req<{ url: string }>("/film-compat/sheet"),
    saveSheet: (url: string) => req<{ url: string }>("/film-compat/sheet", { method: "PUT", body: JSON.stringify({ url }) }),
    syncSheet: () => req<{ ok: boolean; imported: number }>("/film-compat/sheet/sync", { method: "POST" }),
    create: (data: { film: string; models: string; notes?: string }) =>
      req<FilmCompat>("/film-compat", { method: "POST", body: JSON.stringify(data) }),
    update: (id: number, data: Partial<{ film: string; models: string; notes: string }>) =>
      req<FilmCompat>(`/film-compat/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    remove: (id: number) => req<{ ok: boolean }>(`/film-compat/${id}`, { method: "DELETE" }),
  },
  rh: {
    publicProcess: (token: string) => req<{ stages: RhStage[] }>(`/rh/public/${token}`),
    publicApply: (token: string, data: {
      name: string; phone: string; email?: string;
      answers: Record<string, Record<string, string>>;
      videoData?: string; videoMime?: string;
    }) => req<{ ok: boolean; id: number }>(`/rh/public/${token}/apply`, { method: "POST", body: JSON.stringify(data) }),
    settings: () => req<{ publicToken: string; stages: RhStage[] }>("/rh/settings"),
    saveSettings: (stages: RhStage[]) => req<{ ok: boolean }>("/rh/settings", { method: "PUT", body: JSON.stringify({ stages }) }),
    regenerateToken: () => req<{ publicToken: string }>("/rh/settings/regenerate-token", { method: "POST" }),
    candidates: () => req<RhCandidate[]>("/rh/candidates"),
    updateCandidate: (id: number, data: { status?: string; notes?: string }) =>
      req<Pick<RhCandidate, "id" | "status" | "notes">>(`/rh/candidates/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    removeCandidate: (id: number) => req<{ ok: boolean }>(`/rh/candidates/${id}`, { method: "DELETE" }),
  },
  sheetLinks: {
    list: () => req<SheetLink[]>("/sheet-links"),
    create: (data: { name: string; url: string }) =>
      req<SheetLink>("/sheet-links", { method: "POST", body: JSON.stringify(data) }),
    update: (id: number, data: Partial<{ name: string; url: string }>) =>
      req<SheetLink>(`/sheet-links/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    remove: (id: number) => req<{ ok: boolean }>(`/sheet-links/${id}`, { method: "DELETE" }),
  },
  partnerLinks: {
    list: () => req<PartnerLink[]>("/partner-links"),
    create: (data: { name: string; url: string }) =>
      req<PartnerLink>("/partner-links", { method: "POST", body: JSON.stringify(data) }),
    update: (id: number, data: Partial<{ name: string; url: string }>) =>
      req<PartnerLink>(`/partner-links/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    remove: (id: number) => req<{ ok: boolean }>(`/partner-links/${id}`, { method: "DELETE" }),
  },
  settings: {
    get: () => req<AppSettings>("/settings"),
    update: (data: Partial<AppSettings>) =>
      req<AppSettings>("/settings", { method: "PATCH", body: JSON.stringify(data) }),
  },
  tasks: {
    list: () => req<Task[]>("/tasks"),
    create: (data: {
      title: string; description?: string; status?: TaskStatus; priority?: TaskPriority;
      assigneeId?: number | null; sectorId?: number | null; dueDate?: string | null;
    }) => req<Task>("/tasks", { method: "POST", body: JSON.stringify(data) }),
    update: (id: number, data: Partial<{
      title: string; description: string; status: TaskStatus; priority: TaskPriority;
      assigneeId: number | null; sectorId: number | null; dueDate: string | null;
      position: number; isArchived: boolean;
    }>) => req<Task>(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    report: () => req<{ bySector: TaskReportBucket[]; byUser: TaskReportBucket[] }>("/tasks/report"),
    comments: (id: number) => req<TaskComment[]>(`/tasks/${id}/comments`),
    addComment: (id: number, content: string) =>
      req<TaskComment>(`/tasks/${id}/comments`, { method: "POST", body: JSON.stringify({ content }) }),
    subtasks: (id: number) => req<TaskSubtask[]>(`/tasks/${id}/subtasks`),
    addSubtask: (id: number, title: string) =>
      req<TaskSubtask>(`/tasks/${id}/subtasks`, { method: "POST", body: JSON.stringify({ title }) }),
    updateSubtask: (id: number, subId: number, data: Partial<{ isDone: boolean; title: string }>) =>
      req<TaskSubtask>(`/tasks/${id}/subtasks/${subId}`, { method: "PATCH", body: JSON.stringify(data) }),
    removeSubtask: (id: number, subId: number) =>
      req<{ ok: boolean }>(`/tasks/${id}/subtasks/${subId}`, { method: "DELETE" }),
    remove: (id: number) => req<{ ok: boolean }>(`/tasks/${id}`, { method: "DELETE" }),
  },
  documents: {
    list: () => req<DocumentItem[]>("/documents"),
    create: (data: { title: string; category: string; description?: string; fileName: string; mimeType: string; data: string }) =>
      req<DocumentItem>("/documents", { method: "POST", body: JSON.stringify(data) }),
    remove: (id: number) => req<{ ok: boolean }>(`/documents/${id}`, { method: "DELETE" }),
    fileUrl: (id: number) => `/api/documents/${id}/file`,
  },
  stores: {
    list: (all?: boolean) => req<Store[]>(`/stores${all ? "?all=1" : ""}`),
    create: (name: string) => req<Store>("/stores", { method: "POST", body: JSON.stringify({ name }) }),
    update: (id: number, data: Partial<{ name: string; isActive: boolean }>) =>
      req<Store>(`/stores/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  },
  teamStatus: {
    list: () => req<TeamStatusRow[]>("/admin/team-status"),
    accessLogs: (userId: number) => req<{ loggedInAt: string }[]>(`/admin/users/${userId}/access-logs`),
  },
  admin: {
    summary: () => req<SectorSummary[]>("/admin/summary"),
    logs: (params?: { limit?: number; sectorId?: number; attendantId?: number; days?: number; outcome?: string; reason?: string; search?: string }) => {
      const qs = new URLSearchParams();
      if (params?.limit) qs.set("limit", String(params.limit));
      if (params?.sectorId) qs.set("sectorId", String(params.sectorId));
      if (params?.attendantId) qs.set("attendantId", String(params.attendantId));
      if (params?.days) qs.set("days", String(params.days));
      if (params?.outcome) qs.set("outcome", params.outcome);
      if (params?.reason) qs.set("reason", params.reason);
      if (params?.search) qs.set("search", params.search);
      return req<AttendanceLog[]>(`/admin/logs?${qs.toString()}`);
    },
    users: {
      list: () => req<(User & { isActive: boolean; createdAt: string })[]>("/admin/users"),
      create: (data: { name: string; email: string; password: string; role: string; sectorId: number; storeName?: string; adminAccess?: string[] | null; accessHours?: { start: string; end: string; days: number[] } | null }) =>
        req<User>("/admin/users", { method: "POST", body: JSON.stringify(data) }),
      update: (id: number, data: Partial<{ name: string; email: string; password: string; role: string; sectorId: number; storeName: string; isActive: boolean; permissions: Record<string, boolean>; adminAccess: string[] | null; accessHours: { start: string; end: string; days: number[] } | null }>) =>
        req<User>(`/admin/users/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
      remove: (id: number, transferToId: number | null) =>
        req<{ ok: boolean; transferredConversations: number }>(`/admin/users/${id}`, { method: "DELETE", body: JSON.stringify({ transferToId }) }),
      deactivate: (id: number, transferToId: number | null) =>
        req<{ ok: boolean; transferredConversations: number }>(`/admin/users/${id}/deactivate`, { method: "POST", body: JSON.stringify({ transferToId }) }),
    },
  },
};

export type ResultsSummary = {
  from: string; to: string; sectorId: number | null; attendantId: number | null;
  totals: {
    atendimentos: number; avgServiceSeconds: number; avgWaitSeconds: number;
    vendas: number; totalVendido: number;
    newLeads: number; recurringLeads: number; repurchaseClients: number;
    avgRating: number; ratings: number;
  };
  ranking: ResultsRankingRow[];
  leadsPorMes: { mes: string; novos: number }[];
  satisfacaoPorSetor: { sectorId: number; sectorName: string; avgRating: number; ratings: number }[];
};

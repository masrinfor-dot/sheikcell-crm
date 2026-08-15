const BASE = "/api";
export const API_BASE = BASE;

// Erro de API com o `code` opcional do corpo da resposta preservado (além da
// mensagem) — usado, por ex., para o front detectar REAUTH_REQUIRED e abrir o
// modal de confirmação de senha em vez de tratar como erro genérico.
export class ApiError extends Error {
  code?: string;
  // Presente quando POST /chat/conversations responde 409 (já existe uma
  // conversa aberta com esse número) — deixa quem chamou abrir a conversa
  // existente em vez de só mostrar o erro.
  conversationId?: number;
  constructor(message: string, code?: string, conversationId?: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.conversationId = conversationId;
  }
}

async function req<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...opts?.headers },
    ...opts,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(
      (err as { error?: string }).error ?? res.statusText,
      (err as { code?: string }).code,
      (err as { conversationId?: number }).conversationId,
    );
  }
  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}

// Lê um File como base64 (mesmo padrão do chat.sendMedia/internalChat.sendMedia)
// pra anexos que não precisam de preview de progresso — usado nos chamados.
function readAsAttachment(file?: File): Promise<{ base64: string; mimetype: string } | undefined> {
  if (!file) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      resolve({ base64: dataUrl.split(",")[1]!, mimetype: file.type });
    };
    reader.onerror = () => reject(new Error("Falha ao ler arquivo"));
    reader.readAsDataURL(file);
  });
}

export type VendedorPermissions = Record<string, boolean> | null;

// Chaves de permissão de AÇÃO do vendedor (null/ausente = liberado).
// Visibilidade de módulo/aba não entra mais aqui — ver moduleAccess no User.
export const PERMISSION_KEYS = [
  "ver_potenciais",
  "transferir",
  "finalizar",
  "criar_atendimento",
  "usar_ia",
  "enviar_midia",
] as const;

export const PERMISSION_LABELS: Record<string, string> = {
  ver_potenciais: "Ver e assumir Potenciais (leads novos)",
  transferir: "Transferir conversa para outro setor",
  finalizar: "Finalizar atendimentos",
  criar_atendimento: "Criar novo atendimento manualmente",
  usar_ia: "Usar sugestão de resposta com IA",
  enviar_midia: "Enviar fotos, áudios e arquivos",
};

export type User = {
  id: number;
  name: string;
  email: string;
  role: string;
  sectorId: number | null;
  storeName?: string | null;
  extension?: string | null;
  mustChangePassword?: boolean;
  adminAccess?: string[] | null;
  // Módulos da loja que este vendedor/supervisor pode ver (e em que nível —
  // "view"/"edit" dão o mesmo acesso completo por enquanto). Ausência de
  // chave = sem acesso àquele módulo. Nunca inclui "chat" (Atendimento).
  moduleAccess?: UserModuleAccess | null;
  accessHours?: { start: string; end: string; days: number[] } | null;
  sector: Sector | null;
  permissions?: VendedorPermissions;
  // Módulos opcionais contratados pela loja (teto do tenant — null pro
  // superadmin, que não pertence a loja nenhuma).
  enabledModules?: string[] | null;
  // Presente quando o superadmin está "entrando como" este usuário.
  impersonatedBy?: { name: string } | null;
};

// Módulos opcionais que uma loja pode ou não ter contratado — mesma lista
// de OPTIONAL_MODULES em lib/db/src/schema/tenants.ts (mantenha em sincronia).
export const OPTIONAL_MODULES = [
  "chat", "crm", "equipe", "financeiro", "diretorio", "tarefas", "resultados", "history",
  "avaliacao", "financeiras", "rh", "treinamentos", "questionarios", "sorteios", "documentos", "robo",
] as const;
export type OptionalModule = typeof OPTIONAL_MODULES[number];

// Módulos que dá pra restringir por USUÁRIO (vendedor/supervisor) — todos
// menos "chat": Atendimento é sempre liberado pra todo mundo da loja, sem
// essa granularidade (mesma decisão do backend, ver lib/moduleAccess.ts).
export type UserGrantableModule = Exclude<OptionalModule, "chat">;
export const USER_GRANTABLE_MODULES = OPTIONAL_MODULES.filter((m): m is UserGrantableModule => m !== "chat");
export type ModuleAccessLevel = "view" | "edit";
export type UserModuleAccess = Partial<Record<UserGrantableModule, ModuleAccessLevel>>;

export const MODULE_LABELS: Record<OptionalModule, string> = {
  chat: "Atendimento",
  crm: "CRM",
  equipe: "Chat Interno",
  financeiro: "Financeiro",
  diretorio: "Diretório da Equipe",
  tarefas: "Tarefas",
  resultados: "Resultados",
  history: "Histórico",
  avaliacao: "Avaliação de Usados",
  financeiras: "Financeiras",
  rh: "RH",
  treinamentos: "Treinamentos",
  questionarios: "Questionários",
  sorteios: "Sorteios",
  documentos: "Documentos",
  robo: "Robô",
};
// "Básico" = o conjunto padrão do CRM (o que antes era núcleo sempre ligado);
// "Completo" = básico + todos os módulos de negócio adicionais.
const BASIC_MODULES: OptionalModule[] = ["chat", "crm", "equipe", "financeiro", "diretorio", "tarefas", "resultados", "history"];
export const MODULE_PACKAGES: Record<"basico" | "completo", OptionalModule[]> = {
  basico: BASIC_MODULES,
  completo: [...OPTIONAL_MODULES],
};

// Tem a permissão? (admin sempre tem; vendedor/supervisor: ausência = liberado)
export function can(user: User | null, key: string): boolean {
  if (!user) return false;
  if (user.role === "admin") return true;
  return user.permissions?.[key] !== false;
}

// Nível de acesso do usuário a um módulo — admin sempre "edit"; loja sem o
// módulo contratado ou usuário sem grant explícito = null (sem acesso).
// Mesma regra do backend (checkModuleAccess em lib/moduleAccess.ts).
export function moduleLevel(user: User | null, m: UserGrantableModule): ModuleAccessLevel | null {
  if (!user) return null;
  if (user.role === "admin") return "edit";
  if (user.enabledModules != null && !user.enabledModules.includes(m)) return null;
  return user.moduleAccess?.[m] ?? null;
}

// Atalho pra gatear botão de criar/editar/excluir: só "edit" pode escrever,
// "view" (ou sem acesso) só navega e lê. Mesma regra do backend
// (requireModuleAccess bloqueia POST/PATCH/PUT/DELETE sem nível "edit").
export function canEditModule(user: User | null, m: UserGrantableModule): boolean {
  return moduleLevel(user, m) === "edit";
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

export type MeetingItem = {
  id: number;
  title: string;
  roomCode: string;
  status: string; // aberta | gravada | transcrita
  transcript: string | null;
  recordingBytes: number | null;
  createdAt: string;
  endedAt: string | null;
  creatorName: string | null;
};

export type InternalMessage = {
  id: number;
  conversationId: number;
  senderId: number;
  senderName: string;
  content: string;
  type: "text" | "image" | "audio" | "doc";
  mediaUrl: string | null;
  transcript: string | null;
  forwarded: boolean;
  replyToId: number | null;
  replyTo: { id: number; senderName: string; content: string; type: "text" | "image" | "audio" | "doc" } | null;
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
  thankYouMessage: string;
  responseWindowHours: number;
  rewardEnabled: boolean;
  rewardText: string;
  raffleInvite: boolean;
  reminderEnabled: boolean;
  reminderHours: number;
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

export type DashboardAttention = {
  waitingTooLong: Array<{ id: number; name: string; sectorName: string | null; waitingMinutes: number | null }>;
  overdueTasks: Array<{ id: number; title: string; assigneeName: string | null; daysOverdue: number | null }>;
  avgServiceSeconds: number | null;
  funnel: { potential: number; active: number };
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
  mediaUrl?: string | null; mediaType?: string | null;
};

export type TaskSubtask = {
  id: number; taskId: number; title: string; isDone: boolean; position: number; createdAt: string;
};

// ── Quadro de Sistema (Dev) ── problemas/atualizações/implementações do
// próprio sheikcell-crm, com responsável e prazo. Aba admin liberável via adminAccess.
export type SystemBoardType = "problema" | "atualizacao" | "implementacao";
export type SystemBoardStatus = "aberto" | "andamento" | "concluido";

export type SystemBoardItem = {
  id: number;
  type: SystemBoardType;
  title: string;
  description: string | null;
  status: SystemBoardStatus;
  priority: TaskPriority;
  responsibleId: number | null;
  createdById: number | null;
  dueDate: string | null;
  position: number;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
  responsible: { id: number; name: string } | null;
  createdBy: { id: number; name: string } | null;
  commentCount?: number;
};

export type SystemBoardComment = {
  id: number; itemId: number; authorId: number | null;
  authorName: string | null; content: string; createdAt: string;
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

// Tabelas de margem da avaliação: 1 = maior, 2 = média, 3 = menor (em %).
export type TradeInMargins = { t1: number; t2: number; t3: number };

// Perguntas do questionário de condições (editáveis pelo admin, por marca).
export type TradeInQuestionOption = { label: string; blocks: boolean };
export type TradeInQuestion = { key: string; label: string; options: TradeInQuestionOption[] };
export type TradeInQuestionsConfig = { apple: TradeInQuestion[]; android: TradeInQuestion[] };

export type RhQuestion = { id: string; label: string; type: "text" | "longtext" | "options"; options?: string[] };
export type RhStage = { id: string; title: string; description: string; type: "form" | "video"; enabled: boolean; questions: RhQuestion[] };
export type RhCandidate = {
  id: number; name: string; phone: string; email: string | null;
  status: "novo" | "aprovado" | "reprovado";
  answers: Record<string, Record<string, string>>;
  stagesSnapshot: RhStage[] | null;
  notes: string | null; hasVideo: boolean; createdAt: string;
};

export type PartnerLink = {
  id: number; name: string; url: string; position: number; createdAt: string;
};

export type Branding = {
  companyName: string | null;
  logoDataUrl: string | null;
  primaryColor: string | null;
};

export type AppSettings = {
  alertUnansweredEnabled: boolean;
  alertUnansweredMinutes: number;
  outboundHourlyLimit: number;
  outboundDailyLimit: number;
  branding: Branding;
};

export type OutboundUsage = {
  hourly: { used: number; limit: number };
  daily: { used: number; limit: number };
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

export type ChatNotification = {
  id: number;
  kind: "retorno" | "failed";
  scheduledId: number | null;
  conversationId: number;
  convName: string;
  content: string;
  read: boolean;
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

export type ChatMessage = {
  id: number;
  conversationId: number;
  content: string;
  direction: "inbound" | "outbound";
  type: string;
  status: string;
  senderName: string | null;
  // Telefone de quem enviou DENTRO de uma conversa de grupo (participante),
  // diferente do "phone" da conversa (que é o JID do grupo em si). Só
  // preenchido pra mensagens de grupo — permite abrir uma conversa 1:1 com
  // aquele participante direto a partir do balão.
  senderPhone?: string | null;
  mediaUrl: string | null;
  transcript: string | null;
  externalId: string | null;
  createdAt: string;
  editedAt?: string | null;
  deletedAt?: string | null;
  reactions?: Array<{ emoji: string; senderName: string | null }>;
  replyToId?: number | null;
  replyTo?: { id: number; senderName: string | null; content: string; type: string } | null;
};

export type SaasContract = {
  id: number;
  tenantId: number;
  plan: string;
  monthlyValueCents: number;
  startDate: string | null;
  renewalDate: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  tenantName?: string;
};

export type SaasInvoice = {
  id: number;
  tenantId: number;
  tenantName: string;
  description: string;
  amountCents: number;
  dueDate: string;
  status: "pendente" | "paga" | "cancelada";
  overdue: boolean;
  paidAt: string | null;
  createdAt: string;
};

export type TicketStatus = "aberto" | "em_analise" | "em_andamento" | "resolvido" | "fechado";
export type TicketCategory = "bug" | "duvida" | "melhoria";
export type TicketPriority = "baixa" | "normal" | "alta" | "urgente";

export type SaasTicket = {
  id: number;
  tenantId: number;
  tenantName?: string;
  title: string;
  description: string | null;
  status: TicketStatus;
  priority: TicketPriority;
  category: TicketCategory;
  openedByUserId: number | null;
  storeName: string | null;
  firstRespondedAt: string | null;
  createdAt: string;
  resolvedAt: string | null;
  // Explicação da solução aplicada — preenchida ao marcar como "resolvido",
  // fica visível permanentemente (não é limpa se o status mudar depois).
  resolutionNote: string | null;
};

export type TicketMessage = {
  id: number;
  ticketId: number;
  authorType: "tenant" | "superadmin";
  authorUserId: number | null;
  authorName: string;
  content: string | null;
  mediaUrl: string | null;
  mediaType: string | null;
  createdAt: string;
};

export type SaasOverview = {
  mrrCents: number;
  paidMonthCents: number;
  paidMonthCount: number;
  paidTotalCents: number;
  overdueCents: number;
  overdueCount: number;
  pendingCents: number;
  pendingCount: number;
  openTickets: number;
  newContractsMonth: number;
  renewalsMonthCount: number;
};

export type TenantSummary = {
  id: number;
  name: string;
  isActive: boolean;
  saasStatus: "ativo" | "inadimplente" | "cancelado";
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  cpfCnpj: string | null;
  enabledModules: OptionalModule[];
  overdueCount: number;
  contract: SaasContract | null;
  createdAt: string;
  userCount: number;
  conversationCount: number;
  whatsappCount: number;
  admins: { id: number; name: string; email: string; isActive: boolean }[];
};
export const api = {
  superadmin: {
    listTenants: () => req<{ tenants: TenantSummary[] }>("/superadmin/tenants"),
    createTenant: (data: {
      name: string; adminName?: string; adminEmail?: string; adminPassword?: string;
      contactName?: string; contactPhone?: string; contactEmail?: string;
      cpfCnpj?: string; enabledModules?: OptionalModule[];
    }) =>
      req<{ tenant: TenantSummary }>("/superadmin/tenants", { method: "POST", body: JSON.stringify(data) }),
    impersonate: (tenantId: number, userId: number) =>
      req<{ ok: boolean }>(`/superadmin/tenants/${tenantId}/impersonate/${userId}`, { method: "POST" }),
    updateTenant: (id: number, data: {
      name?: string; isActive?: boolean; saasStatus?: "ativo" | "cancelado";
      contactName?: string | null; contactPhone?: string | null; contactEmail?: string | null;
      enabledModules?: OptionalModule[];
    }) =>
      req<{ tenant: TenantSummary }>(`/superadmin/tenants/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    upsertTenantAdmin: (id: number, data: { name?: string; email: string; password: string }) =>
      req<{ admin: { id: number; name: string; email: string } | null }>(`/superadmin/tenants/${id}/admin`, { method: "POST", body: JSON.stringify(data) }),
    saasOverview: () => req<SaasOverview>("/superadmin/saas/overview"),
    listContracts: () => req<{ contracts: SaasContract[] }>("/superadmin/saas/contracts"),
    saveContract: (tenantId: number, data: {
      plan?: string; monthlyValueCents?: number; startDate?: string | null;
      renewalDate?: string | null; notes?: string | null; isActive?: boolean;
    }) => req<{ contract: SaasContract }>(`/superadmin/tenants/${tenantId}/contract`, { method: "PUT", body: JSON.stringify(data) }),
    getContractTemplate: () => req<{ template: string }>("/superadmin/saas/contract-template"),
    saveContractTemplate: (template: string) =>
      req<{ ok: boolean }>("/superadmin/saas/contract-template", { method: "PUT", body: JSON.stringify({ template }) }),
    listInvoices: () => req<{ invoices: SaasInvoice[] }>("/superadmin/saas/invoices"),
    createInvoice: (data: { tenantId: number; description?: string; amountCents: number; dueDate: string }) =>
      req<{ invoice: SaasInvoice }>("/superadmin/saas/invoices", { method: "POST", body: JSON.stringify(data) }),
    generateInvoices: (month?: string) =>
      req<{ created: number; month: string }>("/superadmin/saas/invoices/generate", { method: "POST", body: JSON.stringify({ month }) }),
    setInvoiceStatus: (id: number, status: "pendente" | "paga" | "cancelada") =>
      req<{ invoice: SaasInvoice }>(`/superadmin/saas/invoices/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }),
    deleteInvoice: (id: number) =>
      req<{ ok: boolean }>(`/superadmin/saas/invoices/${id}`, { method: "DELETE" }),
    listTickets: (params?: { status?: TicketStatus; priority?: TicketPriority; category?: TicketCategory; tenantId?: number }) => {
      const qs = new URLSearchParams();
      if (params?.status) qs.set("status", params.status);
      if (params?.priority) qs.set("priority", params.priority);
      if (params?.category) qs.set("category", params.category);
      if (params?.tenantId) qs.set("tenantId", String(params.tenantId));
      const q = qs.toString();
      return req<{ tickets: SaasTicket[] }>(`/superadmin/saas/tickets${q ? `?${q}` : ""}`);
    },
    createTicket: (data: { tenantId: number; title: string; description?: string }) =>
      req<{ ticket: SaasTicket }>("/superadmin/saas/tickets", { method: "POST", body: JSON.stringify(data) }),
    updateTicket: (id: number, data: { status?: TicketStatus; priority?: TicketPriority; category?: TicketCategory; title?: string; description?: string; resolutionNote?: string }) =>
      req<{ ticket: SaasTicket }>(`/superadmin/saas/tickets/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    ticketMessages: (id: number) => req<{ messages: TicketMessage[] }>(`/superadmin/saas/tickets/${id}/messages`),
    replyTicket: (id: number, content: string) =>
      req<{ message: TicketMessage }>(`/superadmin/saas/tickets/${id}/messages`, { method: "POST", body: JSON.stringify({ content }) }),
  },
  tickets: {
    list: () => req<{ tickets: SaasTicket[] }>("/tickets"),
    create: (data: { title: string; description?: string; category?: TicketCategory; priority?: TicketPriority }, file?: File): Promise<{ ticket: SaasTicket }> =>
      readAsAttachment(file).then((attachment) =>
        req<{ ticket: SaasTicket }>("/tickets", { method: "POST", body: JSON.stringify({ ...data, attachment }) })),
    messages: (id: number) => req<{ ticket: SaasTicket; messages: TicketMessage[] }>(`/tickets/${id}/messages`),
    reply: (id: number, content: string, file?: File): Promise<{ message: TicketMessage }> =>
      readAsAttachment(file).then((attachment) =>
        req<{ message: TicketMessage }>(`/tickets/${id}/messages`, { method: "POST", body: JSON.stringify({ content, attachment }) })),
  },
  auth: {
    login: (email: string, password: string) =>
      req<{ user: User }>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
    logout: () => req<{ ok: boolean }>("/auth/logout", { method: "POST" }),
    me: () => req<{ user: User }>("/auth/me"),
    changePassword: (currentPassword: string, newPassword: string) =>
      req<{ ok: boolean }>("/auth/change-password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) }),
    stopImpersonation: () => req<{ ok: boolean }>("/auth/stop-impersonation", { method: "POST" }),
    forgotPassword: (email: string) =>
      req<{ ok: boolean; message: string }>("/auth/forgot-password", { method: "POST", body: JSON.stringify({ email }) }),
    resetPassword: (token: string, newPassword: string, confirmNewPassword: string) =>
      req<{ ok: boolean }>("/auth/reset-password", { method: "POST", body: JSON.stringify({ token, newPassword, confirmNewPassword }) }),
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
    // Paginação por cursor: devolve o bloco de mensagens + flag de "tem mais
    // antigas" (cabeçalho X-Has-More). Sem `before`, é o bloco mais recente.
    messagesPage: async (id: number, before?: number): Promise<{ messages: ChatMessage[]; hasMore: boolean }> => {
      const qs = before != null ? `?before=${before}` : "";
      const res = await fetch(`${BASE}/chat/conversations/${id}/messages${qs}`, {
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error((err as { error?: string }).error ?? res.statusText);
      }
      const messages = (await res.json()) as ChatMessage[];
      return { messages, hasMore: res.headers.get("X-Has-More") === "1" };
    },
    sendMessage: (id: number, content: string, replyToId?: number) =>
      req<ChatMessage>(`/chat/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ content, replyToId }) }),
    sendNote: (id: number, content: string) =>
      req<ChatMessage>(`/chat/conversations/${id}/notes`, { method: "POST", body: JSON.stringify({ content }) }),
    suggestReply: (id: number) =>
      req<{ suggestion: string }>(`/chat/conversations/${id}/suggest-reply`, { method: "POST" }),
    transcribe: (messageId: number) =>
      req<{ transcript: string }>(`/chat/messages/${messageId}/transcribe`, { method: "POST" }),
    correctText: (text: string) =>
      req<{ corrected: string }>(`/chat/correct-text`, { method: "POST", body: JSON.stringify({ text }) }),
    sendMedia: (id: number, file: File, caption?: string, opts?: { ptt?: boolean; replyToId?: number }): Promise<ChatMessage> => {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const base64 = dataUrl.split(",")[1];
          req<ChatMessage>(`/chat/conversations/${id}/media`, {
            method: "POST",
            body: JSON.stringify({ base64, mimetype: file.type, filename: file.name, caption, ptt: opts?.ptt, replyToId: opts?.replyToId }),
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
    outboundUsage: (assigneeId?: number) =>
      req<OutboundUsage>(`/chat/outbound-usage${assigneeId ? `?assigneeId=${assigneeId}` : ""}`),
    createConversation: (data: { phone: string; name: string; channel?: string; sectorId?: number; assigneeId?: number }) =>
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
    // Avisos persistentes do sino (retorno vencido / falha de envio agendado):
    // sobrevivem a vendedor offline e são carregados ao abrir a Central.
    notifications: {
      unread: () => req<ChatNotification[]>("/chat/notifications"),
      markRead: (conversationId?: number) =>
        req<{ ok: boolean }>("/chat/notifications/read", {
          method: "POST",
          body: JSON.stringify(conversationId != null ? { conversationId } : {}),
        }),
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
    send: (id: number, content: string, replyToId?: number) =>
      req<InternalMessage>(`/internal-chat/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ content, replyToId }) }),
    markRead: (id: number) => req<{ ok: boolean }>(`/internal-chat/conversations/${id}/read`, { method: "POST" }),
    deleteGroup: (id: number) => req<{ ok: boolean }>(`/internal-chat/conversations/${id}`, { method: "DELETE" }),
    deleteGeneral: () => req<{ ok: boolean }>("/internal-chat/general", { method: "DELETE" }),
    groupMembers: (id: number) => req<{ id: number; name: string; role: string }[]>(`/internal-chat/conversations/${id}/members`),
    updateGroup: (id: number, data: { name?: string; memberIds?: number[] }) =>
      req<InternalConversation & { members?: { id: number; name: string }[] }>(
        `/internal-chat/conversations/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    sendMedia: (id: number, file: File, caption?: string, replyToId?: number): Promise<InternalMessage> => {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const base64 = dataUrl.split(",")[1];
          req<InternalMessage>(`/internal-chat/conversations/${id}/media`, {
            method: "POST",
            body: JSON.stringify({ base64, mimetype: file.type, filename: file.name, caption, replyToId }),
          }).then(resolve).catch(reject);
        };
        reader.onerror = () => reject(new Error("Falha ao ler arquivo"));
        reader.readAsDataURL(file);
      });
    },
    transcribe: (messageId: number) =>
      req<{ transcript: string }>(`/internal-chat/messages/${messageId}/transcribe`, { method: "POST" }),
    forward: (messageId: number, conversationIds: number[]) =>
      req<{ ok: boolean; sent: { conversationId: number; message: InternalMessage }[] }>(
        `/internal-chat/messages/${messageId}/forward`, { method: "POST", body: JSON.stringify({ conversationIds }) }),
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
    basePrice: (data: { brand: string; model: string; memory?: string; color?: string; marginTable?: 1 | 2 | 3 }) =>
      req<{ device: string; marketPrice: string; basePrice: string }>(
        "/trade-in/base-price", { method: "POST", body: JSON.stringify(data) }),
    evaluate: (data: { device?: string; brand?: string; model?: string; memory?: string; color?: string; marginTable?: 1 | 2 | 3; basePrice?: string; answers: Record<string, string> }) =>
      req<{ id: number; device: string; marketPrice: string; suggestedPrice: string; summary: string; createdAt: string }>(
        "/trade-in/evaluate", { method: "POST", body: JSON.stringify(data) }),
    margins: () => req<TradeInMargins>("/trade-in/margins"),
    saveMargins: (data: Partial<TradeInMargins>) =>
      req<TradeInMargins>("/trade-in/margins", { method: "PATCH", body: JSON.stringify(data) }),
    questions: () => req<TradeInQuestionsConfig>("/trade-in/questions"),
    saveQuestions: (data: TradeInQuestionsConfig) =>
      req<TradeInQuestionsConfig>("/trade-in/questions", { method: "PUT", body: JSON.stringify(data) }),
    resetQuestions: () => req<TradeInQuestionsConfig>("/trade-in/questions", { method: "DELETE" }),
  },
  results: {
    summary: (params?: { from?: string; to?: string; sectorId?: number; attendantId?: number; store?: string }) => {
      const qs = new URLSearchParams();
      if (params?.from) qs.set("from", params.from);
      if (params?.to) qs.set("to", params.to);
      if (params?.sectorId) qs.set("sectorId", String(params.sectorId));
      if (params?.attendantId) qs.set("attendantId", String(params.attendantId));
      if (params?.store) qs.set("store", params.store);
      return req<ResultsSummary>(`/results/summary?${qs.toString()}`);
    },
    reviews: (params?: { limit?: number; sectorId?: number; attendantId?: number }) => {
      const qs = new URLSearchParams();
      if (params?.limit) qs.set("limit", String(params.limit));
      if (params?.sectorId) qs.set("sectorId", String(params.sectorId));
      if (params?.attendantId) qs.set("attendantId", String(params.attendantId));
      return req<{ reviews: SurveyReview[] }>(`/results/reviews?${qs.toString()}`);
    },
  },
  teamDirectory: {
    list: () => req<TeamContact[]>("/team-directory"),
    favorite: (userId: number) => req<{ ok: boolean }>(`/team-directory/${userId}/favorite`, { method: "POST" }),
    unfavorite: (userId: number) => req<{ ok: boolean }>(`/team-directory/${userId}/favorite`, { method: "DELETE" }),
  },
  finance: {
    summary: (days: number, sectorId?: number | null, store?: string | null) =>
      req<FinanceSummary>(`/finance/summary?days=${days}${sectorId ? `&sectorId=${sectorId}` : ""}${store ? `&store=${encodeURIComponent(store)}` : ""}`),
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
    branding: {
      update: (data: Partial<Branding>) =>
        req<Branding>("/settings/branding", { method: "PATCH", body: JSON.stringify(data) }),
    },
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
    addComment: (id: number, content: string, attachment?: { base64: string; mimetype: string }) =>
      req<TaskComment>(`/tasks/${id}/comments`, { method: "POST", body: JSON.stringify({ content, mediaBase64: attachment?.base64, mediaMimetype: attachment?.mimetype }) }),
    subtasks: (id: number) => req<TaskSubtask[]>(`/tasks/${id}/subtasks`),
    addSubtask: (id: number, title: string) =>
      req<TaskSubtask>(`/tasks/${id}/subtasks`, { method: "POST", body: JSON.stringify({ title }) }),
    updateSubtask: (id: number, subId: number, data: Partial<{ isDone: boolean; title: string; position: number }>) =>
      req<TaskSubtask>(`/tasks/${id}/subtasks/${subId}`, { method: "PATCH", body: JSON.stringify(data) }),
    removeSubtask: (id: number, subId: number) =>
      req<{ ok: boolean }>(`/tasks/${id}/subtasks/${subId}`, { method: "DELETE" }),
    remove: (id: number) => req<{ ok: boolean }>(`/tasks/${id}`, { method: "DELETE" }),
    notifications: {
      unread: () => req<{ taskIds: number[] }>("/tasks/notifications/unread"),
      markRead: (id: number) => req<{ ok: boolean }>(`/tasks/${id}/notifications/read`, { method: "POST" }),
    },
  },
  systemBoard: {
    list: () => req<SystemBoardItem[]>("/system-board"),
    create: (data: {
      type: SystemBoardType; title: string; description?: string; status?: SystemBoardStatus;
      priority?: TaskPriority; responsibleId?: number | null; dueDate?: string | null;
    }) => req<SystemBoardItem>("/system-board", { method: "POST", body: JSON.stringify(data) }),
    update: (id: number, data: Partial<{
      type: SystemBoardType; title: string; description: string; status: SystemBoardStatus;
      priority: TaskPriority; responsibleId: number | null; dueDate: string | null;
      position: number; isArchived: boolean;
    }>) => req<SystemBoardItem>(`/system-board/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    comments: (id: number) => req<SystemBoardComment[]>(`/system-board/${id}/comments`),
    addComment: (id: number, content: string) =>
      req<SystemBoardComment>(`/system-board/${id}/comments`, { method: "POST", body: JSON.stringify({ content }) }),
    remove: (id: number) => req<{ ok: boolean }>(`/system-board/${id}`, { method: "DELETE" }),
  },
  documents: {
    list: () => req<DocumentItem[]>("/documents"),
    create: (data: { title: string; category: string; description?: string; fileName: string; mimeType: string; data: string }) =>
      req<DocumentItem>("/documents", { method: "POST", body: JSON.stringify(data) }),
    remove: (id: number) => req<{ ok: boolean }>(`/documents/${id}`, { method: "DELETE" }),
    fileUrl: (id: number) => `/api/documents/${id}/file`,
  },
  meetings: {
    list: () => req<MeetingItem[]>("/meetings"),
    create: (title: string) => req<MeetingItem>("/meetings", { method: "POST", body: JSON.stringify({ title }) }),
    uploadRecording: (id: number, data: { mimeType: string; data: string }) =>
      req<{ transcript: string }>(`/meetings/${id}/recording`, { method: "POST", body: JSON.stringify(data) }),
    generate: (id: number, kind: "ata" | "resumo" | "tarefas") =>
      req<DocumentItem>(`/meetings/${id}/generate`, { method: "POST", body: JSON.stringify({ kind }) }),
    remove: (id: number) => req<{ ok: boolean }>(`/meetings/${id}`, { method: "DELETE" }),
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
    dashboardAttention: () => req<DashboardAttention>("/admin/dashboard-attention"),
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
      create: (data: { name: string; email: string; password: string; role: string; sectorId: number; storeName?: string; extension?: string; adminAccess?: string[] | null; moduleAccess?: UserModuleAccess | null; accessHours?: { start: string; end: string; days: number[] } | null; allowedSessionKeys?: string[] | null }) =>
        req<User>("/admin/users", { method: "POST", body: JSON.stringify(data) }),
      update: (id: number, data: Partial<{ name: string; email: string; password: string; role: string; sectorId: number; storeName: string; extension: string; isActive: boolean; permissions: Record<string, boolean>; adminAccess: string[] | null; moduleAccess: UserModuleAccess | null; accessHours: { start: string; end: string; days: number[] } | null; allowedSessionKeys: string[] | null }>) =>
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

export type TeamContact = {
  id: number;
  name: string;
  email: string;
  role: string;
  extension: string | null;
  storeName: string | null;
  sectorId: number | null;
  sectorName: string | null;
  favorited: boolean;
};

export type SurveyReview = {
  id: number; // protocolo do atendimento
  clientName: string;
  clientContact: string | null;
  sectorName: string;
  attendantName: string | null;
  satisfactionRating: number;
  resolutionReason: string | null;
  createdAt: string;
};

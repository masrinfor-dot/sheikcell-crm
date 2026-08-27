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

// timeoutMs é opcional — usado só por chamadas que dependem de uma IA externa
// (ex.: importação de lista, busca de fotos), onde sem ele um proxy/rede
// travada deixa o spinner girando pra sempre em vez de mostrar um erro.
// Chamadas normais (sem timeoutMs) mantêm o comportamento de sempre.
async function req<T>(path: string, opts?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const { timeoutMs, ...init } = opts ?? {};
  const controller = timeoutMs ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      credentials: "include",
      headers: { "Content-Type": "application/json", ...init.headers },
      ...init,
      ...(controller ? { signal: controller.signal } : {}),
    });
  } catch (err) {
    if (controller?.signal.aborted) throw new ApiError("Tempo esgotado — tente novamente.");
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  "relatorios", "tvbox", "rotinas", "vitrine",
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
  relatorios: "Relatórios",
  tvbox: "TV Box",
  rotinas: "Rotinas e Produtividade",
  vitrine: "Vitrine Aparelhos",
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
  pinnedMessage: { id: number; senderName: string; content: string; type: "text" | "image" | "audio" | "doc" } | null;
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

// ─── Vitrine Aparelhos ───────────────────────────────────────────────────────
// Selo de qualidade padrão SheikCell — mesma lista/critério de
// CATALOG_CONDITION_CRITERIA em lib/db/src/schema/catalog.ts (mantenha em sincronia).
export type CatalogCondition = "excelente" | "muito_bom" | "bom" | "outlet";
export const CATALOG_CONDITIONS: { value: CatalogCondition; label: string }[] = [
  { value: "excelente", label: "Excelente" },
  { value: "muito_bom", label: "Muito Bom" },
  { value: "bom", label: "Bom" },
  { value: "outlet", label: "Outlet" },
];

export const CATALOG_CONDITION_CRITERIA: Record<
  CatalogCondition,
  { label: string; criteria: { label: string; text: string }[] }
> = {
  excelente: {
    label: "Excelente",
    criteria: [
      { label: "Tela", text: "Poucos ou nenhum sinal de uso, como pequenos riscos" },
      { label: "Lateral", text: "Pode apresentar arranhões imperceptíveis" },
      { label: "Traseira", text: "Pode apresentar pequeno desgaste ou arranhão, mas nada aparente" },
      { label: "Bateria", text: "Os aparelhos possuem no mínimo 80% da capacidade da bateria" },
      { label: "Acessórios", text: "Não acompanha acessórios" },
    ],
  },
  muito_bom: {
    label: "Muito Bom",
    criteria: [
      { label: "Tela", text: "Alguns sinais de uso, como pequenos riscos" },
      { label: "Lateral", text: "Pode apresentar pequenos amassados" },
      { label: "Traseira", text: "Pode apresentar arranhões leves" },
      { label: "Bateria", text: "Os aparelhos possuem no mínimo 80% da capacidade da bateria" },
      { label: "Acessórios", text: "Não acompanha acessórios" },
    ],
  },
  bom: {
    label: "Bom",
    criteria: [
      { label: "Tela", text: "Sinais de uso mais nítidos, como riscos" },
      { label: "Lateral", text: "Pode apresentar amassados, partes descascadas ou arranhões" },
      { label: "Traseira", text: "Pode apresentar riscos e arranhões nítidos" },
      { label: "Bateria", text: "Os aparelhos possuem no mínimo 80% da capacidade da bateria" },
      { label: "Acessórios", text: "Não acompanha acessórios" },
    ],
  },
  outlet: {
    label: "Outlet",
    criteria: [
      { label: "Tela", text: "Pode apresentar manchas fortes, sombras (efeito fantasma) e/ou riscos na tela" },
      { label: "Lateral", text: "Pode apresentar pequenos amassados, partes descascadas ou arranhões" },
      { label: "Traseira", text: "Pode apresentar riscos e arranhões nítidos" },
      { label: "Bateria", text: "Os aparelhos possuem no mínimo 80% da capacidade da bateria" },
      { label: "Leitor de Digital/Facial", text: "Pode não funcionar" },
      { label: "Acessórios", text: "Não acompanha acessórios" },
    ],
  },
};

export type CatalogPhoto = { id: number; storedName: string; sourceUrl?: string | null; sortOrder: number };

// Categoria/aba personalizável (Celulares > Samsung/Apple, Peças de
// celular...) — a loja cria/edita/apaga livremente. parentId null = aba
// principal; parentId preenchido = subcategoria.
export type CatalogCategory = { id: number; name: string; parentId: number | null; sortOrder: number };

// Variante de armazenamento/memória — cada família de produto (modelo +
// condição + cores) pode ter várias, com preço/estoque próprios.
export type CatalogProductVariant = {
  id: number;
  productId: number;
  storage: string | null;
  // Cor específica dessa combinação (null = variante não distingue cor —
  // usa as cores do produto só como informação, ver CatalogProduct.colors).
  color: string | null;
  costPrice: string | null;
  costIncludesInvoice: boolean;
  marginPercentOverride: string | null;
  salePrice: string | null;
  // Preço de atacado — calculado a partir do custo (margem de atacado
  // própria ou padrão da loja), com opção de digitar um valor exato pra
  // sobrescrever. Só sai na vitrine pública pra quem desbloqueou com o
  // código de acesso (ver api.catalog.getWholesaleCode).
  wholesalePrice: string | null;
  wholesaleMarginPercentOverride: string | null;
  stockQty: number;
  sortOrder: number;
};

// Input de variante enviado pro backend (form de cadastro/edição) — id
// presente = atualiza a variante existente; ausente = cria uma nova.
export type CatalogVariantInput = {
  id?: number;
  storage: string | null;
  color: string | null;
  costPrice: number | null;
  costIncludesInvoice: boolean;
  marginPercentOverride: number | null;
  salePrice?: number | null;
  wholesalePrice?: number | null;
  wholesaleMarginPercentOverride?: number | null;
  stockQty: number;
};

export type CatalogProduct = {
  id: number;
  model: string;
  condition: CatalogCondition;
  colors: string[];
  description: string | null;
  status: "active" | "inactive" | "sold";
  categoryId: number | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  photos: CatalogPhoto[];
  variants: CatalogProductVariant[];
};

export type CatalogPricingSettings = {
  defaultMarginPercent: number;
  invoiceCostPercent: number;
  cardFeeTable: Record<string, number>;
  wholesaleMarginPercent: number;
};

export type CatalogPublicVariant = {
  id: number; storage: string | null; color: string | null; salePrice: string | null; inStock: boolean;
  wholesalePrice: string | null;
};

export type CatalogPublicProduct = {
  id: number;
  model: string;
  condition: CatalogCondition;
  colors: string[];
  description: string | null;
  categoryId: number | null;
  photos: number[];
  variants: CatalogPublicVariant[];
};

export type CatalogImportVariant = { storage: string | null; color: string | null; costPrice: number | null };

export type CatalogImportItem = {
  model: string;
  condition: CatalogCondition;
  colors: string[];
  variants: CatalogImportVariant[];
  status: "approved" | "pending";
  issue: string | null;
  rawLine: string;
  // Categoria sugerida pela IA. categoryId = já existe, aplicada direto.
  // categoryPath = sugestão nova (ex.: ["Celulares","Samsung"]), sem id
  // ainda — precisa de autorização do lojista antes de criar (ver o banner
  // "categorias novas sugeridas" na tela de importação).
  categoryId: number | null;
  categoryPath: string[] | null;
};

export type CatalogPhotoSearchResult = { title: string; imageUrl: string; thumbnailUrl: string; sourceUrl: string };

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

// Extras fora das colunas fixas: nome/tamanho real de documento (o mediaUrl
// salvo usa nome aleatório) e preview de link (OG tags), buscado sob demanda
// só pra mensagens de texto que a própria equipe escreve.
export type MessageMetadata = {
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  linkPreview?: {
    url: string;
    title?: string;
    description?: string;
    image?: string;
    siteName?: string;
  } | null;
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
  metadata?: MessageMetadata | null;
  createdAt: string;
  editedAt?: string | null;
  deletedAt?: string | null;
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
  // Check-ins de ponto via WhatsApp sinalizados (duas fotos em pouco tempo do
  // mesmo colaborador) — precisam de revisão manual do admin.
  pontoFlagged: Array<{ id: number; employeeName: string; kind: string; at: string; flagReason: string | null }>;
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
  createdById: number | null;
  sectorId: number | null;
  dueDate: string | null;
  // Agenda: cliente vinculado ao compromisso, duração e alerta prévio.
  contactId: number | null;
  durationMinutes: number | null;
  alertMinutesBefore: number | null;
  position: number;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
  sector: Sector | null;
  assignees: { id: number; name: string }[];
  createdBy: { id: number; name: string } | null;
  contact: { id: number; name: string; contact: string | null } | null;
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

// Agenda: lembrete de compromisso (dueDate + alertMinutesBefore), gerado
// automaticamente pelo servidor e entregue em tempo real via SSE
// ("task_reminder") + listado aqui pra quem perdeu o evento (offline).
export type TaskReminder = {
  id: number; taskId: number; title: string; dueDate: string; read: boolean; createdAt: string;
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

// Rotinas e Produtividade (RH) — checklists operacionais agendados,
// separado de Checklist/Questionários acima (ver lib/db/src/schema/rotinas.ts).
export type RoutineQuestionType = "yes_no" | "done_not_done" | "text" | "number" | "value" | "photo" | "document" | "observation";
// Fase 3.5: lista fixa de motivo quando a resposta é negativa numa pergunta
// requiresJustificationOnNo (mesmos códigos validados no backend, rotinas.ts).
export const ROUTINE_NO_REASONS: { value: string; label: string }[] = [
  { value: "falta_tempo", label: "Falta de tempo" },
  { value: "dependencia_colega", label: "Dependência de outro colaborador" },
  { value: "dependencia_gerente", label: "Dependência do gerente" },
  { value: "falta_produto_peca", label: "Falta de produto/peça" },
  { value: "problema_sistema", label: "Problema no sistema" },
  { value: "problema_equipamento", label: "Problema em equipamento" },
  { value: "cliente_nao_respondeu", label: "Cliente não respondeu" },
  { value: "nao_foi_possivel_executar", label: "Não foi possível executar" },
  { value: "outro", label: "Outro" },
];
export type RoutineAlertLevel = "critico" | "atencao";
export type RoutineChecklistQuestion = {
  id: number; checklistId: number; orderIndex: number; label: string;
  type: RoutineQuestionType; required: boolean; requiresEvidence: boolean; evidenceType: "photo" | "document" | null;
  requiresJustificationOnNo: boolean; alertLevel: RoutineAlertLevel | null;
};
export type RoutineChecklistScope = {
  id: number; checklistId: number;
  storeId: number | null; sectorId: number | null; jobFunction: string | null; userId: number | null;
};
// "continuous" = devido o expediente inteiro, sem horário fixo (Fase 3.5).
export type RoutineRecurrence = "daily" | "weekdays" | "specific_days" | "weekly" | "monthly" | "specific_date" | "continuous";
export type RoutineChecklist = {
  id: number; name: string; message: string | null; scheduledTime: string | null;
  // Rotinas com mais de um horário por dia (ex.: conferência de caixa
  // 3x/dia) — null/vazio pro caso normal de horário único (scheduledTime
  // sozinho já resolve). Preenchido com 2+ horários quando o admin
  // configura múltiplos horários pro mesmo checklist.
  scheduledTimes: string[] | null;
  recurrence: RoutineRecurrence; recurrenceDays: number[] | null; specificDate: string | null;
  toleranceMinutes: number; mandatory: boolean; active: boolean; version: number;
  createdByUserId: number | null; createdAt: string; updatedAt: string;
  questionCount?: number; scopeCount?: number;
};
export type RoutineChecklistFull = RoutineChecklist & { questions: RoutineChecklistQuestion[]; scopes: RoutineChecklistScope[] };
export type RoutineScopeOptions = {
  stores: { id: number; name: string }[]; sectors: { id: number; name: string }[]; users: { id: number; name: string }[];
  employees: { id: number; name: string }[];
};
// Fechamento mensal (Fase 5) — snapshot congelado, mesmo padrão de
// TimeBankClosure (rh_dp.ts). Fase 6: enriquecido com loja/setor (relatório
// por loja) e aprovação do supervisor (approvedAt/approvedByUserId).
export type RoutineClosure = {
  id: number; employeeId: number; employeeName: string; periodMonth: string;
  totalDue: number; totalAnswered: number; totalOnTime: number; totalWithPendency: number; totalUrgentBypass: number;
  pontoBeforeEntry: number; pontoAfterEntry: number; pontoNoRecord: number;
  closedAt: string;
  storeId: number | null; storeName: string | null; sectorId: number | null; sectorName: string | null;
  approvedAt: string | null; approvedByUserId: number | null;
};
// Fase 6: pesos do score de produtividade — configurável, ver
// computeRoutineScore no backend (rotinas.ts) pra fórmula documentada.
export type RoutineScoreWeights = { weightOnTime: number; weightNoPendency: number; weightNoUrgentAbuse: number };
export type RoutineRankingRow = {
  employeeId: number; employeeName: string; storeId: number | null; storeName: string | null; sectorName: string | null; jobFunction: string | null;
  totalDue: number; totalAnswered: number; approved: boolean;
  score: number; onTimeRate: number; noPendencyRate: number; noUrgentAbuseRate: number;
};
export type RoutineRanking = { periodMonth: string; weights: RoutineScoreWeights; ranking: RoutineRankingRow[] };
export type RoutinePendingPendency = { id: number; userId: number; userName: string | null; periodKey: string; answers: Record<string, RoutineAnswerValue> };
export type RoutinePendingBypass = { id: number; userId: number; userName: string | null; createdAt: string };
export type RoutineReviewPending = { periodMonth: string; pendencies: RoutinePendingPendency[]; urgentBypasses: RoutinePendingBypass[] };
// Painel consolidado (Fase 7) — não recalcula nada, junta fechamento (Fase
// 5) + review de pendência (Fase 6) sob filtro comum.
export type RoutineDashboardStatus = "pendente" | "em_dia" | "pendencia_nao_justificada";
export type RoutineDashboardRow = {
  employeeId: number; employeeName: string; periodMonth: string;
  storeId: number | null; storeName: string | null; sectorId: number | null; sectorName: string | null; jobFunction: string | null;
  totalDue: number; totalAnswered: number; totalOnTime: number; totalWithPendency: number; totalUrgentBypass: number;
  approved: boolean; status: RoutineDashboardStatus; score: number | null;
};
// Alerta automático (Fase 7) — checklist obrigatório atrasado, ou resposta
// negativa em pergunta alertLevel="critico".
export type RoutineAlert = {
  id: number; recipientUserId: number; employeeUserId: number; employeeName: string;
  checklistId: number | null; checklistName: string; kind: "atraso" | "critico"; message: string; read: boolean; createdAt: string;
};
// Checklist "devido agora" pro usuário logado (Fase 2) — versão enxuta de
// RoutineChecklistQuestion, só o que o modal de resposta precisa mostrar.
export type PendingRoutineQuestion = {
  id: number; label: string; type: RoutineQuestionType; required: boolean; requiresEvidence: boolean; evidenceType: "photo" | "document" | null;
  requiresJustificationOnNo: boolean; alertLevel: RoutineAlertLevel | null;
};
export type PendingRoutine = {
  id: number; name: string; message: string | null; mandatory: boolean; periodKey: string;
  // "" pro checklist de horário único (comportamento de sempre); quando o
  // checklist tem múltiplos horários (Rotinas com mais de um horário por
  // dia), vira o "HH:MM" da ocorrência específica pendente — precisa ser
  // reenviado em respond() pra identificar qual ocorrência está sendo
  // respondida (um mesmo checklist pode aparecer mais de uma vez na lista
  // de pendentes, uma por horário ainda não respondido).
  occurrenceTime: string;
  questions: PendingRoutineQuestion[];
};
// Justificativa estruturada (Fase 3.5) gravada quando a resposta é negativa
// numa pergunta requiresJustificationOnNo — senão o valor é uma string simples.
export type RoutineNoJustification = { value: string; motivo: string; pendencia: string | null; comunicarA: string | null };
export type RoutineAnswerValue = string | RoutineNoJustification;
// Evidência anexada a uma pergunta de uma resposta (Fase 4) — o arquivo em
// si sai por GET /rotinas/evidence/:id/file.
export type RoutineEvidence = {
  id: number; responseId: number; questionId: number; fileName: string; mimeType: string; sizeBytes: number; createdAt: string;
};
export type RoutineResponse = {
  id: number; userId: number; userName: string | null; periodKey: string;
  userStoreId: number | null; storeName: string | null; sectorName: string | null;
  answers: Record<string, RoutineAnswerValue>; questionsSnapshot: PendingRoutineQuestion[];
  evidence: RoutineEvidence[];
  reauthAt: string; createdAt: string;
};
// Upload de evidência (Fase 4) — base64, mesmo padrão de documents.ts.
export type RoutineEvidenceUpload = { fileName: string; mimeType: string; data: string };

export type TradeInEvaluation = {
  id: number; userId: number | null; userName?: string | null;
  device: string; answers: Record<string, string>;
  brand: string | null; model: string | null; memory: string | null; color: string | null;
  marketPrice: string | null; suggestedPrice: string | null;
  aiSummary: string | null; createdAt: string;
  // Preenchidos só ao fechar o negócio (etapa 4).
  sellerCustomerName?: string | null; sellerCpf?: string | null;
  imei?: string | null; finalAgreedPrice?: string | null; closedAt?: string | null;
};

// Tabelas de margem da avaliação: 1 = maior, 2 = média, 3 = menor (em %).
export type TradeInMargins = { t1: number; t2: number; t3: number };

// Perguntas do questionário de condições (editáveis pelo admin, por marca).
export type TradeInQuestionOption = { label: string; blocks: boolean };
export type TradeInQuestion = { key: string; label: string; options: TradeInQuestionOption[] };
export type TradeInQuestionsConfig = { apple: TradeInQuestion[]; android: TradeInQuestion[] };

export type RhQuestion = { id: string; label: string; type: "text" | "longtext" | "options"; options?: string[] };
export type RhStage = { id: string; title: string; description: string; type: "form" | "video"; enabled: boolean; questions: RhQuestion[]; maxVideoSeconds?: number | null };
export type RhCandidate = {
  id: number; name: string; phone: string; email: string | null;
  status: "novo" | "aprovado" | "reprovado";
  answers: Record<string, Record<string, string>>;
  stagesSnapshot: RhStage[] | null;
  notes: string | null; hasVideo: boolean; createdAt: string;
};

// ── RH: Departamento Pessoal ────────────────────────────────────────────────
export type Employee = {
  id: number;
  userId: number | null;
  name: string;
  birthDate: string | null;
  phone: string | null;
  email: string | null;
  cpf: string | null;
  rg: string | null;
  role: string | null;
  jobFunction: string | null;
  admissionDate: string | null;
  contractType: "clt" | "pj" | "estagio" | null;
  salaryCents: number | null;
  storeId: number | null;
  shiftId: number | null;
  isActive: boolean;
  createdAt: string;
  userName?: string | null;
  storeName?: string | null;
  shiftName?: string | null;
};

export type WorkShift = {
  id: number;
  name: string;
  type: "fixed" | "flexible";
  startTime: string | null;
  endTime: string | null;
  breakStart: string | null;
  breakEnd: string | null;
  weekdays: number[];
  expectedMinutesPerDay: number | null;
};

export type TimeBankClosure = {
  id: number;
  employeeId: number;
  employeeName: string;
  periodMonth: string; // "YYYY-MM"
  workedMinutes: number;
  expectedMinutes: number;
  adjustmentMinutes: number;
  balanceMinutes: number;
  closedAt: string;
};

export type TimeClockEntry = {
  id: number;
  employeeId: number;
  employeeName?: string | null;
  kind: "in" | "break_start" | "break_end" | "out";
  at: string;
  source: "self" | "admin" | "whatsapp";
  proofUrl?: string | null;
  flagged?: boolean;
  flagReason?: string | null;
};

export type TimeBankDay = {
  date: string;
  workedMinutes: number;
  expectedMinutes: number;
  complete: boolean;
  entries: { kind: string; at: string }[];
};

export type TimeBankResult = {
  workedMinutes: number;
  expectedMinutes: number;
  adjustmentMinutes: number;
  balanceMinutes: number;
  days: TimeBankDay[];
};

export type TimeBankSummaryRow = {
  employeeId: number;
  employeeName: string;
  workedMinutes: number;
  expectedMinutes: number;
  adjustmentMinutes: number;
  balanceMinutes: number;
};

export type LeaveRecord = {
  id: number;
  employeeId: number;
  employeeName?: string | null;
  kind: "ferias" | "atestado" | "falta_justificada" | "falta_injustificada" | "outro";
  startDate: string;
  endDate: string;
  notes: string | null;
  createdAt?: string;
};

export type PartnerLink = {
  id: number; name: string; url: string; position: number; createdAt: string;
};

export type TvBoxClientStatus = "ativo" | "suspenso" | "cancelado";
export type TvBoxInvoiceStatus = "pendente" | "pago" | "cancelado";

export type TvBoxInvoice = {
  id: number;
  clientId: number;
  description: string;
  amountCents: number;
  dueDate: string;
  billingMonth: string | null;
  status: TvBoxInvoiceStatus;
  paidAt: string | null;
  reminderSentAt: string | null;
  lastChargeSentAt: string | null;
  createdAt: string;
  overdue: boolean;
};

export type TvBoxClient = {
  id: number;
  name: string;
  phone: string;
  monthlyValueCents: number;
  dueDay: number;
  status: TvBoxClientStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  pendingInvoice: TvBoxInvoice | null;
  overdue: boolean;
  daysLate: number;
};

export type TvBoxOverview = {
  activeClients: number;
  pendingCents: number;
  pendingCount: number;
  overdueCents: number;
  overdueCount: number;
};

export type TvBoxSettings = {
  enabled: boolean;
  reminderDaysBefore: number;
  overdueMessageIntervalDays: number;
  reminderMessageTemplate: string;
  chargeMessageTemplate: string;
};

export type Branding = {
  companyName: string | null;
  logoDataUrl: string | null;
  primaryColor: string | null;
};

// Nunca inclui a chave em si — só o suficiente pra loja reconhecer qual
// chave está salva (últimos 4 caracteres) e se está em uso.
export type AiCredentialsStatus = {
  hasKey: boolean;
  last4: string | null;
  useOwnKey: boolean;
};

export type MySession = {
  sid: string;
  isCurrent: boolean;
  device: string;
  browser: string;
  ip: string | null;
  loginAt: string | null;
  expiresAt: string;
};

export type AuditedSession = MySession & {
  userId: number | null;
  userName: string;
  role: string | null;
  tenantName: string | null;
};

export type AppSettings = {
  alertUnansweredEnabled: boolean;
  alertUnansweredMinutes: number;
  outboundHourlyLimit: number;
  outboundDailyLimit: number;
  attendantNameVisibleToCustomer: boolean;
  finalizeReasons: string[];
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
  lastMessageSenderName: string | null;
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
  // Id do usuário do sistema que enviou (só preenchido em mensagens outbound) —
  // usado só pra decidir quem pode editar/apagar a mensagem.
  senderId?: number | null;
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
  metadata?: MessageMetadata | null;
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
  // Nome de quem abriu o chamado — só vem preenchido na listagem do
  // superadmin (join com users); a tela do lojista não usa este campo.
  openedByUserName?: string | null;
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
    sessions: () => req<{ sessions: AuditedSession[] }>("/superadmin/sessions"),
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
    // Auto-edição de nome/e-mail do próprio usuário logado — sempre a
    // própria conta (o servidor nunca aceita id vindo daqui).
    updateProfile: (data: Partial<{ name: string; email: string }>) =>
      req<{ user: User }>("/auth/me", { method: "PATCH", body: JSON.stringify(data) }),
    changePassword: (currentPassword: string, newPassword: string) =>
      req<{ ok: boolean }>("/auth/change-password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) }),
    verifyPassword: (password: string) =>
      req<{ ok: boolean; verifiedForSeconds: number }>("/auth/verify-password", { method: "POST", body: JSON.stringify({ password }) }),
    stopImpersonation: () => req<{ ok: boolean }>("/auth/stop-impersonation", { method: "POST" }),
    forgotPassword: (email: string) =>
      req<{ ok: boolean; message: string }>("/auth/forgot-password", { method: "POST", body: JSON.stringify({ email }) }),
    resetPassword: (token: string, newPassword: string, confirmNewPassword: string) =>
      req<{ ok: boolean }>("/auth/reset-password", { method: "POST", body: JSON.stringify({ token, newPassword, confirmNewPassword }) }),
    sessions: {
      list: () => req<{ sessions: MySession[] }>("/auth/sessions"),
      end: (sid: string) => req<{ ok: boolean }>(`/auth/sessions/${encodeURIComponent(sid)}`, { method: "DELETE" }),
      endOthers: () => req<{ ok: boolean }>("/auth/sessions/end-others", { method: "POST" }),
    },
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
    editMessage: (messageId: number, content: string) =>
      req<ChatMessage>(`/chat/messages/${messageId}`, { method: "PATCH", body: JSON.stringify({ content }) }),
    deleteMessage: (messageId: number) =>
      req<ChatMessage>(`/chat/messages/${messageId}`, { method: "DELETE" }),
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
    editMessage: (messageId: number, content: string) =>
      req<InternalMessage>(`/internal-chat/messages/${messageId}`, { method: "PATCH", body: JSON.stringify({ content }) }),
    deleteMessage: (messageId: number) =>
      req<InternalMessage>(`/internal-chat/messages/${messageId}`, { method: "DELETE" }),
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
    pin: (conversationId: number, messageId: number) =>
      req<{ ok: boolean; pinnedMessage: InternalConversation["pinnedMessage"] }>(
        `/internal-chat/conversations/${conversationId}/pin`, { method: "POST", body: JSON.stringify({ messageId }) }),
    unpin: (conversationId: number) =>
      req<{ ok: boolean }>(`/internal-chat/conversations/${conversationId}/pin`, { method: "DELETE" }),
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
  rotinas: {
    list: () => req<RoutineChecklist[]>("/rotinas/checklists"),
    get: (id: number) => req<RoutineChecklistFull>(`/rotinas/checklists/${id}`),
    create: (data: Partial<RoutineChecklistFull>) => req<RoutineChecklistFull>("/rotinas/checklists", { method: "POST", body: JSON.stringify(data) }),
    update: (id: number, data: Partial<RoutineChecklistFull>) => req<RoutineChecklistFull>(`/rotinas/checklists/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    remove: (id: number) => req<{ ok: boolean }>(`/rotinas/checklists/${id}`, { method: "DELETE" }),
    jobFunctions: () => req<string[]>("/rotinas/job-functions"),
    scopeOptions: () => req<RoutineScopeOptions>("/rotinas/scope-options"),
    pending: () => req<PendingRoutine[]>("/rotinas/pending"),
    // occurrenceTime: "" (padrão) pro checklist de horário único; pra quem
    // tem múltiplos horários, passe o mesmo occurrenceTime que veio no item
    // de pending() (senão o backend responde 404 — não está pendente pra
    // aquela ocorrência).
    respond: (id: number, answers: Record<string, RoutineAnswerValue>, evidence?: Record<string, RoutineEvidenceUpload>, occurrenceTime?: string) =>
      req<{ id: number }>(`/rotinas/checklists/${id}/respond`, { method: "POST", body: JSON.stringify({ answers, evidence, occurrenceTime }) }),
    responses: (id: number) => req<RoutineResponse[]>(`/rotinas/checklists/${id}/responses`),
    evidenceFileUrl: (evidenceId: number) => `${API_BASE}/rotinas/evidence/${evidenceId}/file`,
    closures: (params?: { employeeId?: number; periodMonth?: string }) => {
      const q = new URLSearchParams();
      if (params?.employeeId) q.set("employeeId", String(params.employeeId));
      if (params?.periodMonth) q.set("periodMonth", params.periodMonth);
      const qs = q.toString();
      return req<RoutineClosure[]>(`/rotinas/closures${qs ? `?${qs}` : ""}`);
    },
    runClosure: (month?: string) => req<{ ok: boolean; month: string; created: number }>("/rotinas/closures/run", { method: "POST", body: JSON.stringify({ month }) }),
    removeClosure: (id: number) => req<{ ok: boolean }>(`/rotinas/closures/${id}`, { method: "DELETE" }),
    scoreWeights: () => req<RoutineScoreWeights>("/rotinas/score-weights"),
    updateScoreWeights: (w: Partial<RoutineScoreWeights>) => req<RoutineScoreWeights>("/rotinas/score-weights", { method: "PATCH", body: JSON.stringify(w) }),
    ranking: (params?: { periodMonth?: string; storeId?: number }) => {
      const q = new URLSearchParams();
      if (params?.periodMonth) q.set("periodMonth", params.periodMonth);
      if (params?.storeId) q.set("storeId", String(params.storeId));
      const qs = q.toString();
      return req<RoutineRanking>(`/rotinas/ranking${qs ? `?${qs}` : ""}`);
    },
    reviewPending: (periodMonth?: string) => req<RoutineReviewPending>(`/rotinas/review/pending${periodMonth ? `?periodMonth=${periodMonth}` : ""}`),
    reviewResponse: (id: number, status: "approved" | "contested", note?: string) =>
      req(`/rotinas/responses/${id}/review`, { method: "POST", body: JSON.stringify({ status, note }) }),
    reviewUrgentBypass: (id: number, status: "approved" | "contested", note?: string) =>
      req(`/rotinas/urgent-bypasses/${id}/review`, { method: "POST", body: JSON.stringify({ status, note }) }),
    approveClosure: (id: number) => req<RoutineClosure>(`/rotinas/closures/${id}/approve`, { method: "POST" }),
    dashboard: (params?: { periodMonth?: string; storeId?: number; sectorId?: number; jobFunction?: string; status?: RoutineDashboardStatus }) => {
      const q = new URLSearchParams();
      if (params?.periodMonth) q.set("periodMonth", params.periodMonth);
      if (params?.storeId) q.set("storeId", String(params.storeId));
      if (params?.sectorId) q.set("sectorId", String(params.sectorId));
      if (params?.jobFunction) q.set("jobFunction", params.jobFunction);
      if (params?.status) q.set("status", params.status);
      const qs = q.toString();
      return req<{ periodMonth: string; rows: RoutineDashboardRow[] }>(`/rotinas/dashboard${qs ? `?${qs}` : ""}`);
    },
    alerts: () => req<RoutineAlert[]>("/rotinas/alerts"),
    markAlertRead: (id: number) => req<RoutineAlert>(`/rotinas/alerts/${id}/read`, { method: "POST" }),
    runAlerts: () => req<{ ok: boolean; created: number }>("/rotinas/alerts/run", { method: "POST" }),
    urgentBypass: (id: number) => req<{ ok: boolean; bypassUntil: string }>(`/rotinas/checklists/${id}/urgent-bypass`, { method: "POST" }),
  },
  tradeIn: {
    list: () => req<TradeInEvaluation[]>("/trade-in"),
    basePrice: (data: { brand: string; model: string; memory?: string; color?: string; marginTable?: 1 | 2 | 3 }) =>
      req<{ device: string; marketPrice: string; basePrice: string }>(
        "/trade-in/base-price", { method: "POST", body: JSON.stringify(data) }),
    evaluate: (data: { device?: string; brand?: string; model?: string; memory?: string; color?: string; marginTable?: 1 | 2 | 3; basePrice?: string; answers: Record<string, string> }) =>
      req<{ id: number; device: string; marketPrice: string; suggestedPrice: string; summary: string; createdAt: string }>(
        "/trade-in/evaluate", { method: "POST", body: JSON.stringify(data) }),
    close: (id: number, data: { sellerCustomerName: string; sellerCpf: string; imei: string; finalAgreedPrice: string }) =>
      req<TradeInEvaluation>(`/trade-in/${id}/close`, { method: "PATCH", body: JSON.stringify(data) }),
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
    activity: (params?: { from?: string; to?: string; sectorId?: number; attendantId?: number; store?: string }) => {
      const qs = new URLSearchParams();
      if (params?.from) qs.set("from", params.from);
      if (params?.to) qs.set("to", params.to);
      if (params?.sectorId) qs.set("sectorId", String(params.sectorId));
      if (params?.attendantId) qs.set("attendantId", String(params.attendantId));
      if (params?.store) qs.set("store", params.store);
      return req<DailyActivity>(`/results/activity?${qs.toString()}`);
    },
    unresolved: (params?: { sectorId?: number; attendantId?: number; store?: string; thresholdHours?: number }) => {
      const qs = new URLSearchParams();
      if (params?.sectorId) qs.set("sectorId", String(params.sectorId));
      if (params?.attendantId) qs.set("attendantId", String(params.attendantId));
      if (params?.store) qs.set("store", params.store);
      if (params?.thresholdHours) qs.set("thresholdHours", String(params.thresholdHours));
      return req<UnresolvedSummary>(`/results/unresolved?${qs.toString()}`);
    },
    satisfactionBreakdown: (params?: { from?: string; to?: string; sectorId?: number; attendantId?: number; store?: string }) => {
      const qs = new URLSearchParams();
      if (params?.from) qs.set("from", params.from);
      if (params?.to) qs.set("to", params.to);
      if (params?.sectorId) qs.set("sectorId", String(params.sectorId));
      if (params?.attendantId) qs.set("attendantId", String(params.attendantId));
      if (params?.store) qs.set("store", params.store);
      return req<SatisfactionBreakdown>(`/results/satisfaction-breakdown?${qs.toString()}`);
    },
  },
  relatorios: {
    vendedores: (params?: { from?: string; to?: string; sectorId?: number; store?: string }) => {
      const qs = new URLSearchParams();
      if (params?.from) qs.set("from", params.from);
      if (params?.to) qs.set("to", params.to);
      if (params?.sectorId) qs.set("sectorId", String(params.sectorId));
      if (params?.store) qs.set("store", params.store);
      return req<{ from: string; to: string; rows: VendorConsolidatedRow[] }>(`/relatorios/vendedores?${qs.toString()}`);
    },
    lojas: (params?: { from?: string; to?: string; sectorId?: number }) => {
      const qs = new URLSearchParams();
      if (params?.from) qs.set("from", params.from);
      if (params?.to) qs.set("to", params.to);
      if (params?.sectorId) qs.set("sectorId", String(params.sectorId));
      return req<{ from: string; to: string; rows: StoreConsolidatedRow[] }>(`/relatorios/lojas?${qs.toString()}`);
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
  rhDp: {
    me: {
      get: () => req<Employee>("/rh-dp/me"),
      punch: () => req<TimeClockEntry>("/rh-dp/me/punch", { method: "POST" }),
      timeBank: (from?: string, to?: string) =>
        req<TimeBankResult>(`/rh-dp/me/time-bank?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) })}`),
      clockStatus: () => req<{ needsClockIn: boolean }>("/rh-dp/me/clock-status"),
    },
    employees: {
      list: () => req<Employee[]>("/rh-dp/employees"),
      create: (data: Partial<Employee>) => req<Employee>("/rh-dp/employees", { method: "POST", body: JSON.stringify(data) }),
      update: (id: number, data: Partial<Employee>) => req<Employee>(`/rh-dp/employees/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
      remove: (id: number) => req<{ ok: boolean }>(`/rh-dp/employees/${id}`, { method: "DELETE" }),
      punch: (id: number, data: { kind: TimeClockEntry["kind"]; at?: string }) =>
        req<TimeClockEntry>(`/rh-dp/employees/${id}/punch`, { method: "POST", body: JSON.stringify(data) }),
      // Lança/edita/limpa o dia inteiro (até 4 seções) numa chamada só —
      // cada seção omitida/vazia remove a batida existente daquele tipo.
      setDay: (id: number, data: { date: string; in?: string | null; break_start?: string | null; break_end?: string | null; out?: string | null }) =>
        req<{ ok: boolean; date: string } & Partial<Record<"in" | "break_start" | "break_end" | "out", string>>>(
          `/rh-dp/employees/${id}/day`, { method: "PUT", body: JSON.stringify(data) },
        ),
      timeBank: (id: number, from?: string, to?: string) =>
        req<TimeBankResult>(`/rh-dp/employees/${id}/time-bank?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) })}`),
      addAdjustment: (id: number, data: { minutes: number; reason: string }) =>
        req<{ id: number }>(`/rh-dp/employees/${id}/time-bank/adjustments`, { method: "POST", body: JSON.stringify(data) }),
    },
    timeClockEntries: {
      remove: (id: number) => req<{ ok: boolean }>(`/rh-dp/time-clock-entries/${id}`, { method: "DELETE" }),
      // Admin conferiu uma batida sinalizada (duas fotos em pouco tempo via
      // WhatsApp) e decidiu manter como está — some da lista de pendências.
      review: (id: number) => req<TimeClockEntry>(`/rh-dp/time-clock-entries/${id}/review`, { method: "POST" }),
    },
    // Linha oficial de check-in de ponto por WhatsApp (uma por tenant).
    settings: {
      get: () => req<{ pontoCheckInSessionKey: string | null }>("/rh-dp/settings"),
      update: (pontoCheckInSessionKey: string | null) =>
        req<{ pontoCheckInSessionKey: string | null }>("/rh-dp/settings", { method: "PATCH", body: JSON.stringify({ pontoCheckInSessionKey }) }),
    },
    shifts: {
      list: () => req<WorkShift[]>("/rh-dp/shifts"),
      create: (data: Partial<WorkShift>) => req<WorkShift>("/rh-dp/shifts", { method: "POST", body: JSON.stringify(data) }),
      update: (id: number, data: Partial<WorkShift>) => req<WorkShift>(`/rh-dp/shifts/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
      remove: (id: number) => req<{ ok: boolean }>(`/rh-dp/shifts/${id}`, { method: "DELETE" }),
    },
    leaves: {
      list: () => req<LeaveRecord[]>("/rh-dp/leave-records"),
      create: (data: { employeeId: number; kind: LeaveRecord["kind"]; startDate: string; endDate: string; notes?: string }) =>
        req<LeaveRecord>("/rh-dp/leave-records", { method: "POST", body: JSON.stringify(data) }),
      remove: (id: number) => req<{ ok: boolean }>(`/rh-dp/leave-records/${id}`, { method: "DELETE" }),
    },
    reports: {
      timesheet: (from?: string, to?: string, employeeId?: number) =>
        req<TimeClockEntry[]>(`/rh-dp/reports/timesheet?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}), ...(employeeId ? { employeeId: String(employeeId) } : {}) })}`),
      timeBankSummary: (from?: string, to?: string) =>
        req<TimeBankSummaryRow[]>(`/rh-dp/reports/time-bank-summary?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) })}`),
      leaves: (from?: string, to?: string) =>
        req<LeaveRecord[]>(`/rh-dp/reports/leaves?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) })}`),
    },
    closures: {
      list: (month?: string) => req<TimeBankClosure[]>(`/rh-dp/closures?${new URLSearchParams({ ...(month ? { month } : {}) })}`),
      run: (month?: string) => req<{ ok: boolean; month: string; created: number }>("/rh-dp/closures/run", { method: "POST", body: JSON.stringify({ month }) }),
      remove: (id: number) => req<{ ok: boolean }>(`/rh-dp/closures/${id}`, { method: "DELETE" }),
    },
  },
  partnerLinks: {
    list: () => req<PartnerLink[]>("/partner-links"),
    create: (data: { name: string; url: string }) =>
      req<PartnerLink>("/partner-links", { method: "POST", body: JSON.stringify(data) }),
    update: (id: number, data: Partial<{ name: string; url: string }>) =>
      req<PartnerLink>(`/partner-links/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    remove: (id: number) => req<{ ok: boolean }>(`/partner-links/${id}`, { method: "DELETE" }),
  },
  tvbox: {
    clients: {
      list: () => req<TvBoxClient[]>("/tvbox/clients"),
      create: (data: { name: string; phone: string; monthlyValueCents: number; dueDay: number; notes?: string }) =>
        req<TvBoxClient>("/tvbox/clients", { method: "POST", body: JSON.stringify(data) }),
      update: (id: number, data: Partial<{
        name: string; phone: string; monthlyValueCents: number; dueDay: number; status: TvBoxClientStatus; notes: string;
      }>) => req<TvBoxClient>(`/tvbox/clients/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    },
    invoices: {
      list: (clientId?: number) => req<TvBoxInvoice[]>(`/tvbox/invoices${clientId ? `?clientId=${clientId}` : ""}`),
      update: (id: number, status: TvBoxInvoiceStatus) =>
        req<TvBoxInvoice>(`/tvbox/invoices/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }),
      generate: () => req<{ created: number }>("/tvbox/invoices/generate", { method: "POST" }),
    },
    overview: () => req<TvBoxOverview>("/tvbox/overview"),
    settings: {
      get: () => req<TvBoxSettings>("/tvbox/settings"),
      update: (data: Partial<TvBoxSettings>) =>
        req<TvBoxSettings>("/tvbox/settings", { method: "PATCH", body: JSON.stringify(data) }),
    },
  },
  settings: {
    get: () => req<AppSettings>("/settings"),
    update: (data: Partial<AppSettings>) =>
      req<AppSettings>("/settings", { method: "PATCH", body: JSON.stringify(data) }),
    branding: {
      update: (data: Partial<Branding>) =>
        req<Branding>("/settings/branding", { method: "PATCH", body: JSON.stringify(data) }),
    },
    finalizeReasons: {
      update: (reasons: string[]) =>
        req<{ finalizeReasons: string[] }>("/settings/finalize-reasons", { method: "PATCH", body: JSON.stringify({ reasons }) }),
    },
    ai: {
      get: () => req<AiCredentialsStatus>("/settings/ai"),
      save: (data: { apiKey?: string; useOwnKey?: boolean }) =>
        req<AiCredentialsStatus>("/settings/ai", { method: "PATCH", body: JSON.stringify(data) }),
      remove: () => req<AiCredentialsStatus>("/settings/ai", { method: "DELETE" }),
    },
  },
  tasks: {
    list: () => req<Task[]>("/tasks"),
    create: (data: {
      title: string; description?: string; status?: TaskStatus; priority?: TaskPriority;
      assigneeIds?: number[]; sectorId?: number | null; dueDate?: string | null;
      contactId?: number | null; durationMinutes?: number | null; alertMinutesBefore?: number | null;
    }) => req<Task>("/tasks", { method: "POST", body: JSON.stringify(data) }),
    update: (id: number, data: Partial<{
      title: string; description: string; status: TaskStatus; priority: TaskPriority;
      assigneeIds: number[]; sectorId: number | null; dueDate: string | null;
      position: number; isArchived: boolean;
      contactId: number | null; durationMinutes: number | null; alertMinutesBefore: number | null;
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
    reminders: {
      unread: () => req<TaskReminder[]>("/tasks/reminders/unread"),
      markRead: (id: number) => req<{ ok: boolean }>(`/tasks/reminders/${id}/read`, { method: "POST" }),
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
  catalog: {
    list: () => req<{ settings: CatalogPricingSettings; products: CatalogProduct[] }>("/catalog/products"),
    create: (data: Record<string, unknown>) => req<CatalogProduct>("/catalog/products", { method: "POST", body: JSON.stringify(data) }),
    update: (id: number, data: Record<string, unknown>) => req<CatalogProduct>(`/catalog/products/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    remove: (id: number) => req<{ ok: boolean }>(`/catalog/products/${id}`, { method: "DELETE" }),
    bulkRemove: (ids: number[]) => req<{ ok: boolean; deleted: number }>("/catalog/products/bulk-delete", { method: "POST", body: JSON.stringify({ ids }) }),
    addPhoto: (productId: number, file: File) => readAsAttachment(file).then((att) =>
      req<CatalogPhoto>(`/catalog/products/${productId}/photos`, { method: "POST", body: JSON.stringify({ mimeType: att?.mimetype, data: att?.base64 }) })),
    removePhoto: (productId: number, photoId: number) => req<{ ok: boolean }>(`/catalog/products/${productId}/photos/${photoId}`, { method: "DELETE" }),
    photoUrl: (photoId: number) => `/api/catalog-public/photos/${photoId}/file`,
    photoSearch: (q: string) => req<{ results: CatalogPhotoSearchResult[] }>(`/catalog/photo-search?q=${encodeURIComponent(q)}`),
    addPhotoFromUrl: (productId: number, url: string) =>
      req<CatalogPhoto>(`/catalog/products/${productId}/photos/from-url`, { method: "POST", body: JSON.stringify({ url }) }),
    pricingSettings: () => req<CatalogPricingSettings>("/catalog/pricing-settings"),
    savePricingSettings: (data: CatalogPricingSettings) => req<CatalogPricingSettings>("/catalog/pricing-settings", { method: "PUT", body: JSON.stringify(data) }),
    simulatePrice: (data: { costPrice: number; costIncludesInvoice?: boolean; marginPercentOverride?: number | null; wholesaleMarginPercentOverride?: number | null }) =>
      req<{ salePrice: number | null; wholesalePrice: number | null; settings: CatalogPricingSettings }>("/catalog/pricing-settings/simulate", { method: "POST", body: JSON.stringify(data) }),
    getSlug: () => req<{ slug: string | null }>("/catalog/slug"),
    setSlug: (slug: string) => req<{ slug: string | null }>("/catalog/slug", { method: "PUT", body: JSON.stringify({ slug }) }),
    getWhatsapp: () => req<{ whatsapp: string | null }>("/catalog/whatsapp"),
    setWhatsapp: (whatsapp: string) => req<{ whatsapp: string | null }>("/catalog/whatsapp", { method: "PUT", body: JSON.stringify({ whatsapp }) }),
    getWhatsappWholesale: () => req<{ whatsapp: string | null }>("/catalog/whatsapp-wholesale"),
    setWhatsappWholesale: (whatsapp: string) => req<{ whatsapp: string | null }>("/catalog/whatsapp-wholesale", { method: "PUT", body: JSON.stringify({ whatsapp }) }),
    getWholesaleCode: () => req<{ hasCode: boolean; code: string | null }>("/catalog/wholesale-code"),
    setWholesaleCode: (code: string) => req<{ hasCode: boolean; code: string | null }>("/catalog/wholesale-code", { method: "PUT", body: JSON.stringify({ code }) }),
    categories: () => req<{ categories: CatalogCategory[] }>("/catalog/categories"),
    createCategory: (data: { name: string; parentId?: number | null }) => req<CatalogCategory>("/catalog/categories", { method: "POST", body: JSON.stringify(data) }),
    updateCategory: (id: number, data: { name?: string; parentId?: number | null; sortOrder?: number }) =>
      req<CatalogCategory>(`/catalog/categories/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    removeCategory: (id: number) => req<{ ok: boolean }>(`/catalog/categories/${id}`, { method: "DELETE" }),
    // timeoutMs um pouco acima do pior caso do backend (25s da chamada à IA
    // + 1 retry ≈ até 50s) — sem isso, uma rede/proxy travados deixavam o
    // botão "Analisar" girando pra sempre sem nunca mostrar erro.
    importParse: (rawText: string) => req<{ items: CatalogImportItem[]; newCategoryPaths: string[][] }>("/catalog/import/parse", { method: "POST", body: JSON.stringify({ rawText }), timeoutMs: 55_000 }),
    // timeoutMs maior que importParse: além de gravar os produtos, agora
    // também tenta buscar 1 foto por produto na internet (melhor esforço,
    // com timeout próprio por produto — ver autoAttachPhotosOnImport no backend).
    importConfirm: (items: CatalogImportItem[]) => req<{ imported: number; products: CatalogProduct[]; photosAttached?: number }>("/catalog/import/confirm", { method: "POST", body: JSON.stringify({ items }), timeoutMs: 90_000 }),
    public: (slug: string, code?: string) =>
      req<{
        storeName: string; whatsapp: string | null; whatsappWholesale: string | null; hasWholesale: boolean; wholesaleUnlocked: boolean;
        categories: CatalogCategory[]; products: CatalogPublicProduct[];
      }>(`/catalog-public/${slug}${code ? `?code=${encodeURIComponent(code)}` : ""}`),
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
    atendimentos: number; avgServiceSeconds: number; avgWaitSeconds: number; avgFirstResponseSeconds: number;
    vendas: number; totalVendido: number;
    newLeads: number; recurringLeads: number; repurchaseClients: number;
    avgRating: number; ratings: number;
  };
  ranking: ResultsRankingRow[];
  leadsPorMes: { mes: string; novos: number }[];
  satisfacaoPorSetor: { sectorId: number; sectorName: string; avgRating: number; ratings: number }[];
};

export type DailyActivity = {
  from: string; to: string;
  series: { dia: string; iniciados: number; finalizados: number }[];
};

export type UnresolvedSummary = {
  thresholdHours: number;
  count: number;
  items: {
    conversationId: number; clientName: string; sectorName: string | null;
    attendantName: string | null; status: string; ageHours: number;
  }[];
};

export type SatisfactionBreakdown = {
  avgPercent: number;
  ratings: number;
  buckets: { faixa: string; count: number }[];
};

export type VendorConsolidatedRow = {
  attendantId: number; name: string; ativo: boolean;
  atendimentos: number; iniciados: number; finalizados: number; naoResolvidos: number;
  vendas: number; totalVendido: number; conversao: number; avgSatisfactionPercent: number;
};

export type StoreConsolidatedRow = {
  storeId: number | null; name: string;
  atendimentos: number; iniciados: number; finalizados: number; naoResolvidos: number;
  vendas: number; totalVendido: number; conversao: number; avgSatisfactionPercent: number;
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

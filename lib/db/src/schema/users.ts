import { pgTable, serial, integer, text, timestamp, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sectorsTable } from "./sectors";
import { storesTable } from "./stores";
import type { OptionalModule } from "./tenants";

// Sub-perfis do superadmin (Painel do Sistema — Fase 1, gap pendente): um
// superadmin restrito só enxerga/mexe nos escopos aqui listados. "tenants"
// = lojas (criar/suspender/planos), "billing" = financeiro SaaS (contratos/
// mensalidades), "support" = chamados. Ações mais sensíveis (entrar como,
// auditoria/sessões globais, gerenciar a própria equipe do superadmin)
// SEMPRE exigem acesso completo (superadminScopes null), nunca liberam só
// com um escopo — ver requireFullSuperadmin em middlewares/auth.ts.
export const SUPERADMIN_SCOPES = ["tenants", "billing", "support"] as const;
export type SuperadminScope = typeof SUPERADMIN_SCOPES[number];

export const usersTable = pgTable("users", {
  // tenant_id=0 é reservado pro Super Admin (role "superadmin") — ele não
  // pertence a nenhuma loja real (lojas começam em 1), então nunca bate com
  // nenhuma query "WHERE tenant_id = <loja>" espalhada pelo backend. Ver
  // migration 0050_superadmin_no_tenant.sql.
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("vendedor"), // "vendedor" | "vendedor_chefe" | "supervisor" | "admin" | "superadmin"
  // Setor PRIMÁRIO (compatibilidade com todo código antigo que só entende um
  // setor por vendedor — roteamento de conversa nova, quick replies, etc.).
  // Sempre mantido em sincronia com sectorIds[0] pela rota de usuários (ver
  // artifacts/api-server/src/routes/admin.ts) — nunca editado direto sem
  // também atualizar sectorIds.
  sectorId: integer("sector_id").references(() => sectorsTable.id),
  // Vendedor em mais de um setor (pedido 17/09: "colocar vendedores com mais
  // de um setor") — lista completa dos setores deste vendedor, mesmo padrão
  // já usado em whatsapp_sessions.defaultSectorIds. Vazio = nenhum setor
  // (equivalente a sectorId null). Filtros de visibilidade (fila de
  // atendimento, CRM, respostas rápidas) passam a considerar "está em
  // ALGUM destes setores" em vez de comparar contra um único sectorId — ver
  // req.session.userSectorIds. sectorId acima continua existindo só como o
  // "setor de exibição/roteamento padrão" (o primeiro da lista).
  sectorIds: jsonb("sector_ids").$type<number[]>().notNull().default([]),
  // Loja da rede a que o vendedor pertence (texto livre; ex.: "Loja Centro")
  storeName: text("store_name"),
  // Mesma loja acima, mas como FK de verdade — mantido lado a lado com
  // storeName (nunca substituído) pra relatórios poderem agrupar por loja
  // sem depender de JOIN por nome de texto livre. Populado junto com
  // storeName sempre que ele é definido/editado (ver rotas de usuário).
  storeId: integer("store_id").references(() => storesTable.id),
  // Ramal/número interno (opcional) — mostrado no Diretório interno de contatos.
  extension: text("extension"),
  // Obriga trocar a senha no próximo login (primeiro acesso ou senha resetada pelo admin)
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  // Função de admin liberada pra não-admin gerenciar a conexão do WhatsApp
  // (única coisa que sobrou aqui — os demais módulos migraram pra
  // moduleAccess abaixo). Mantido como array por compatibilidade com dados
  // antigos, mas hoje só aceita ["whatsapp"].
  adminAccess: jsonb("admin_access").$type<string[] | null>(),
  // Módulos da loja que este vendedor/supervisor pode ver, e em que nível
  // (por enquanto "view" e "edit" dão o mesmo acesso completo à tela — o
  // bloqueio real de escrita em nível "view" é uma fase futura).
  // null/chave ausente = SEM acesso àquele módulo (fail closed) — admin
  // ignora isto (sempre tem edit em tudo).
  // "chat" (Atendimento) é a ÚNICA exceção, com semântica invertida: chave
  // ausente = LIBERADO (compatibilidade com todas as contas já existentes,
  // que nunca tiveram essa opção), e o único jeito de restringir é gravar
  // "none" explicitamente. Só um admin (nunca supervisor) pode definir essa
  // chave — ver a rota de usuários no api-server, sempre atrás de
  // requireAdmin. Ver lib/moduleAccess.ts (backend) pra a checagem em runtime.
  moduleAccess: jsonb("module_access").$type<
    | (Partial<Record<Exclude<OptionalModule, "chat">, "view" | "edit">> & { chat?: "none" | "view" | "edit" })
    | null
  >(),
  // Horário de acesso (só vendedor): fora dele o login/uso é bloqueado.
  // null = sem restrição. days: 0=domingo ... 6=sábado
  accessHours: jsonb("access_hours").$type<{ start: string; end: string; days: number[] } | null>(),
  isActive: boolean("is_active").notNull().default(true),
  // Linhas de WhatsApp (session_key de whatsapp_sessions) que este vendedor
  // pode ver/responder. null = sem restrição (todas as linhas da loja).
  // Só tem efeito para role "vendedor".
  allowedSessionKeys: jsonb("allowed_session_keys").$type<string[] | null>(),
  // Permissões de AÇÃO do vendedor (null = todas liberadas — fail open).
  // Chaves: ver_potenciais, transferir, finalizar, criar_atendimento,
  // usar_ia, enviar_midia — todas boolean. Visibilidade de módulo/aba não
  // entra mais aqui, ver moduleAccess acima. Admin ignora isto.
  permissions: jsonb("permissions").$type<Record<string, boolean> | null>(),
  // Fila de atendimento do Chat Interno (pedido 09/09): quando true, este
  // usuário só pode "assumir" UMA conversa em modo fila por vez em toda a
  // loja — precisa "concluir" a atual antes de assumir outra. Default false
  // (comportamento de sempre, sem restrição) — é uma restrição opcional que
  // o admin liga por pessoa, não uma permissão de "pode fazer algo" como as
  // de `permissions` acima, por isso é uma coluna própria em vez de entrar
  // nesse jsonb (lá, chave ausente = liberado; aqui teria que ser o oposto).
  internalChatSingleTask: boolean("internal_chat_single_task").notNull().default(false),
  // Fila de atendimento REAL (Central de Atendimento + aba "Fila" legada),
  // pedido 10/09: quando true, este vendedor deixa de ver o pool geral
  // (potenciais/pendentes/fila livre do setor) — só vê o que um
  // vendedor_chefe/supervisor/admin direcionou especificamente pra ele
  // (assigneeId/targetUserId = ele), um atendimento por vez, em ordem de
  // fila (o mais antigo direcionado primeiro). Default false (comportamento
  // de sempre, sem restrição) — mesmo padrão de coluna própria de
  // internalChatSingleTask acima (aqui também não cabe em `permissions`,
  // que é fail-open — esta é fail-closed por natureza).
  queueRestrictToAssigned: boolean("queue_restrict_to_assigned").notNull().default(false),
  // Fila do Central de Atendimento por ORDEM, sem direcionamento manual
  // (pedido 14/09: "só fazer um atendimento por vez... só conseguem
  // iniciar após seguir a fila"). Diferente de queueRestrictToAssigned
  // acima (que exige um vendedor_chefe/supervisor/admin direcionar cada
  // atendimento na mão): aqui o vendedor se auto-serve, só que travado em
  // 1 por vez e em ordem — enquanto tiver pelo menos 1 atendimento aberto
  // (assigneeId = ele, não resolvido), o pool de Potenciais/Pendentes do
  // setor fica escondido; com zero abertos, só o mais antigo do pool
  // aparece (não dá pra escolher a dedo). Quem já tinha vários abertos
  // ANTES de ligar a opção continua vendo e trabalhando todos eles
  // normalmente — a trava só entra pra pegar um NOVO além dos que já tem.
  // Default false (comportamento de sempre). Só tem efeito para role
  // "vendedor" (mesmo padrão de queueRestrictToAssigned).
  chatQueueSingleTask: boolean("chat_queue_single_task").notNull().default(false),
  // Rodízio da fila com auto-atribuição (pedido 14/09): registra a última
  // vez que este vendedor RECEBEU um atendimento novo pela fila (seja
  // auto-atribuído ou pego por ele mesmo no /claim) — usado só pra escolher,
  // entre vários vendedores ociosos do mesmo setor, quem está "há mais
  // tempo esperando" e deve receber o próximo primeiro. null = nunca
  // recebeu nada pela fila ainda (entra na frente de todo mundo).
  chatQueueLastAssignedAt: timestamp("chat_queue_last_assigned_at", { withTimezone: true }),
  // Só tem efeito quando role="superadmin". null (padrão) = acesso completo
  // — todo superadmin já existente continua exatamente como sempre foi.
  // Um array restringe esse membro da equipe aos escopos ali listados (ver
  // SUPERADMIN_SCOPES acima). Ignorado para qualquer outra role.
  superadminScopes: jsonb("superadmin_scopes").$type<SuperadminScope[] | null>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;

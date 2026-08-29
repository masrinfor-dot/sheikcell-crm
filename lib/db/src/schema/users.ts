import { pgTable, serial, integer, text, timestamp, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sectorsTable } from "./sectors";
import { storesTable } from "./stores";
import type { OptionalModule } from "./tenants";

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
  role: text("role").notNull().default("vendedor"), // "vendedor" | "supervisor" | "admin" | "superadmin"
  sectorId: integer("sector_id").references(() => sectorsTable.id),
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

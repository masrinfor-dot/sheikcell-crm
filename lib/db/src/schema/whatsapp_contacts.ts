import { pgTable, serial, text, integer, timestamp, boolean, uniqueIndex, index } from "drizzle-orm/pg-core";

// Agenda de Contatos do WhatsApp (pedido 25/09: "puxar histórico de conversa
// e contatos igual o WhatsApp Web" — fase 1, só contatos). Sincronizada via
// Baileys (app-state sync: o MESMO mecanismo que o WhatsApp Web usa pra se
// popular quando você abre o app — roda continuamente, não só na primeira
// conexão, então funciona nas linhas já conectadas hoje, sem precisar
// reparear/escanear QR de novo). Um registro por (loja, linha, jid): a
// agenda salva em CADA número de WhatsApp é separada (contato pode existir
// em mais de uma linha, com nomes diferentes). Isto NÃO é o CRM
// (crm_contacts segue sendo o cadastro de cliente/atendimento) — é o
// catálogo bruto da agenda de cada linha, pra consulta/busca e, numa fase
// seguinte, vincular ao CRM.
export const whatsappContactsTable = pgTable("whatsapp_contacts", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  sessionKey: text("session_key").notNull(),
  jid: text("jid").notNull(),               // formato completo, ex.: 5511999999999@s.whatsapp.net
  phone: text("phone").notNull(),           // só os dígitos, extraído do jid
  name: text("name"),                       // nome salvo na agenda desta linha (Contact.name)
  pushName: text("push_name"),              // nome que o próprio contato define no perfil (Contact.notify)
  verifiedName: text("verified_name"),      // conta comercial verificada
  avatarUrl: text("avatar_url"),
  isBusiness: boolean("is_business").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantSessionJidUniq: uniqueIndex("whatsapp_contacts_tenant_session_jid_uniq").on(t.tenantId, t.sessionKey, t.jid),
  tenantPhoneIdx: index("whatsapp_contacts_tenant_phone_idx").on(t.tenantId, t.phone),
}));

export type WhatsappContact = typeof whatsappContactsTable.$inferSelect;

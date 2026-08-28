import { pgTable, serial, text, timestamp, jsonb, integer } from "drizzle-orm/pg-core";

// Processo seletivo de RH configurável pelo admin.
// rh_settings: linha única com o token do link público e as etapas
// (pré-entrevista, teste de perfil, prova escrita, vídeo) editáveis.
export const rhSettingsTable = pgTable("rh_settings", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  publicToken: text("public_token").notNull(),
  // [{ id, title, description, type: 'form'|'video', enabled,
  //    questions: [{ id, label, type: 'text'|'longtext'|'options', options?: string[] }] }]
  stages: jsonb("stages").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const rhCandidatesTable = pgTable("rh_candidates", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  email: text("email"),
  status: text("status").notNull().default("novo"), // novo | pre_aprovado | aprovado | reprovado
  // { [stageId]: { [questionId]: string } }
  answers: jsonb("answers").notNull(),
  // Cópia das etapas no momento da candidatura — assim editar o processo
  // depois não bagunça a leitura das respostas antigas.
  stagesSnapshot: jsonb("stages_snapshot"),
  videoData: text("video_data"), // base64 do vídeo gravado
  videoMime: text("video_mime"),
  notes: text("notes"), // anotações internas do admin
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

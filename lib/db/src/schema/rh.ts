import { pgTable, serial, text, timestamp, jsonb, integer, boolean } from "drizzle-orm/pg-core";

// Processo seletivo de RH configurável pelo admin.
// rh_settings: linha única com o token do link público. `stages` aqui é o
// processo "legado" (sem cargos) — continua servindo de fallback pra loja
// que nunca configurou nenhum cargo em rh_positions (ver abaixo): o link
// público existente não muda, ele só passa a mostrar a etapa de escolha de
// vaga quando a loja cadastra pelo menos 1 cargo.
export const rhSettingsTable = pgTable("rh_settings", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  publicToken: text("public_token").notNull(),
  // [{ id, title, description, type: 'form'|'video', enabled,
  //    questions: [{ id, label, type: 'text'|'longtext'|'options', options?: string[] }] }]
  stages: jsonb("stages").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// rh_positions: cargos/vagas configuráveis pelo admin (ex.: Vendedor,
// Administrativo, Gerente, Estoque), cada um com seu próprio processo
// seletivo (mesmo formato de `stages` de rh_settings). Quando a loja tem
// pelo menos 1 cargo ativo, a página pública passa a pedir que o candidato
// escolha 1 (nunca vários) antes de ver o questionário — o questionário
// mostrado é o daquele cargo específico.
export const rhPositionsTable = pgTable("rh_positions", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  name: text("name").notNull(), // ex: "Vendedor"
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  stages: jsonb("stages").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const rhCandidatesTable = pgTable("rh_candidates", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  email: text("email"),
  // CPF só com dígitos (11 caracteres), obrigatório pra candidatura nova —
  // `null` cobre só candidaturas de antes desta feature. É a chave que
  // impede a mesma pessoa repetir o processo (índice único parcial em
  // migrations/0067, por loja, ignorando linhas antigas com cpf nulo).
  cpf: text("cpf"),
  // Cargo escolhido pelo candidato — `null` = candidatura do processo
  // legado (loja sem nenhum cargo configurado em rh_positions).
  // positionName é uma cópia congelada do nome (igual ao espírito de
  // stagesSnapshot): renomear/excluir o cargo depois não apaga o histórico.
  positionId: integer("position_id"),
  positionName: text("position_name"),
  status: text("status").notNull().default("novo"), // novo | pre_aprovado | aprovado | reprovado
  // { [stageId]: { [questionId]: string } }
  answers: jsonb("answers").notNull(),
  // Cópia das etapas no momento da candidatura — assim editar o processo
  // depois não bagunça a leitura das respostas antigas.
  stagesSnapshot: jsonb("stages_snapshot"),
  videoData: text("video_data"), // base64 do vídeo gravado
  videoMime: text("video_mime"),
  notes: text("notes"), // anotações internas do admin
  // Perfil comportamental (Analítico/Dominante/Apoiador/Inovador) calculado
  // automaticamente na hora da candidatura, a partir das opções marcadas com
  // perfil em perguntas type:"options" (ver optionProfiles em RhQuestion,
  // artifacts/api-server/src/routes/rh.ts). null = nenhuma pergunta da
  // candidatura tinha perfil configurado (processo sem "teste de perfil").
  profileResult: text("profile_result"),
  profileScores: jsonb("profile_scores"), // { analitico, dominante, apoiador, inovador }
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

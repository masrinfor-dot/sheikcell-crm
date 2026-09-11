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
  // Cidade/bairro do candidato — campos livres, opcionais (preenchidos no
  // formulário público desde 08/09; candidatura antiga fica null). Servem
  // pro filtro "Cidade"/"Bairro" na lista de candidatos (RH.tsx) — útil pra
  // loja com processo seletivo pra vaga de uma unidade/região específica.
  city: text("city"),
  neighborhood: text("neighborhood"),
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
  // Pipeline (pedido 11/09, reorganizado): novo | pre_aprovado |
  // entrevista_online | entrevista_presencial | teste_loja | aprovado |
  // banco_talentos | reprovado | contratado. "teste_loja" manteve a chave
  // antiga (só o rótulo virou "Teste de campo" na reorganização) pra não
  // invalidar candidatos que já estavam nesse status. Ver STATUS_META em
  // RH.tsx pros rótulos/ordem exibidos.
  // "contratado" é setado AUTOMATICAMENTE quando a contratação do
  // colaborador vinculado (employees.candidateId) é finalizada — ver
  // finalize-hiring/reopen-hiring em employeeHiring.ts. Não junta infra
  // nova, só espelha o hiringStatus "ativo" que já existia.
  // "banco_talentos" (aprovado mas vaga com quadro cheio) e "reprovado" são
  // saídas que podem acontecer em qualquer etapa, fora da sequência
  // principal — aprovado, mas sem vaga disponível agora; fica guardado e
  // pode ser contratado depois (Iniciar contratação funciona a partir dele).
  status: text("status").notNull().default("novo"),
  // Motivo do status atual (ex: "Foi bem na entrevista", "Falta de conta
  // bancária") — escolhido de uma lista pré-definida por status (ver
  // STATUS_REASON_OPTIONS em RH.tsx) ou texto livre ("Outro"). null =
  // mudança de status sem motivo registrado (ex: candidaturas antigas).
  statusReason: text("status_reason"),
  // { [stageId]: { [questionId]: string } }
  answers: jsonb("answers").notNull(),
  // Anotações da entrevista online (Google Meet) feita com o candidato —
  // { [questionId]: string }, preenchido em tempo real durante a ligação a
  // partir do roteiro fixo (INTERVIEW_SCRIPT em RH.tsx). null = entrevista
  // ainda não realizada/anotada.
  interviewNotes: jsonb("interview_notes"),
  // Checklist do teste prático na loja (pedido 11/09: "criar teste na loja
  // com checklist de produtividade, adaptação, trabalho em equipe,
  // disposição, confirmação do perfil etc") — { [itemId]: "bom" | "regular"
  // | "fraco" }, ver STORE_TEST_CHECKLIST em RH.tsx. null = teste ainda não
  // avaliado.
  storeTestChecklist: jsonb("store_test_checklist"),
  // Observações livres do avaliador sobre o teste na loja (além do
  // checklist com nota por item acima). null = sem observação.
  storeTestNotes: text("store_test_notes"),
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

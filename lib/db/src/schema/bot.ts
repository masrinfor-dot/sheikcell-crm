import { pgTable, serial, text, integer, timestamp, jsonb, boolean, primaryKey } from "drizzle-orm/pg-core";

// Robô de pré-atendimento: configuração única (linha singleton).
export const botSettingsTable = pgTable("bot_settings", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  botName: text("bot_name").notNull().default("Assistente"),
  greeting: text("greeting").notNull().default("Olá! 👋 Sou o assistente virtual. Vou te fazer algumas perguntas rápidas para agilizar seu atendimento."),
  // [{ question: string, options?: string[] }]
  questions: jsonb("questions").notNull(),
  knowledgeBase: text("knowledge_base").notNull().default(""),
  doneMessage: text("done_message").notNull().default("Perfeito, obrigado! 🙌 Já vou te passar para um de nossos vendedores. Enquanto isso, pode me perguntar qualquer dúvida."),
  handoffMessage: text("handoff_message").notNull().default("Certo! Um atendente vai falar com você já já. 😉"),
  // always = sempre até um vendedor assumir; off_hours = só fora do expediente
  mode: text("mode").notNull().default("always"),
  hoursStart: text("hours_start").notNull().default("08:00"),
  hoursEnd: text("hours_end").notNull().default("18:00"),
  // Palavras que pulam o robô direto para humano (separadas por vírgula)
  urgencyWords: text("urgency_words").notNull().default("reclamação, reclamar, urgente, advogado, procon"),
  maxPerConversation: integer("max_per_conversation").notNull().default(5),
  maxPerDay: integer("max_per_day").notNull().default(200),
  // "Tempo de resposta digitando" (pedido 16/09) — segundos que o robô
  // espera, simulando "digitando...", antes de mandar cada resposta gerada
  // por IA. Por cima do "humanPacing" que a ponte do WhatsApp já faz sozinha
  // por tamanho de texto (ver whatsapp-bridge/lib/waConnection.ts) — este
  // aqui é um atraso extra, configurável por loja, pra não parecer robótico
  // respondendo instantâneo. 0 = sem atraso extra (só o da ponte).
  typingDelaySeconds: integer("typing_delay_seconds").notNull().default(5),
  // "Aprender com atendimentos" (pedido 16/09): liga/desliga a geração
  // automática de sugestões de melhoria pra base de conhecimento, analisadas
  // pela IA a cada atendimento finalizado que passou por um humano. Começa
  // ligado — o admin desliga manualmente quando achar a base madura o
  // suficiente. Ver kbSuggestionsTable.
  learningEnabled: boolean("learning_enabled").notNull().default(true),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Sugestões de melhoria da base de conhecimento, geradas pela IA a partir de
// atendimentos humanos finalizados (aprendizado) ou digitadas manualmente
// pelo admin na caixa acima da base — nunca entram na base sozinhas: o admin
// aprova (mescla via IA) ou rejeita cada uma.
export const kbSuggestionsTable = pgTable("kb_suggestions", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  // Sem FK: sugestão é um fato histórico que deve sobreviver à exclusão da
  // conversa de origem (mesmo padrão de attendance_logs.conversationId).
  conversationId: integer("conversation_id"),
  suggestion: text("suggestion").notNull(),
  reasoning: text("reasoning"),
  status: text("status").notNull().default("pending"), // pending | approved | rejected
  reviewedBy: integer("reviewed_by"),
  reviewedAt: timestamp("reviewed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Estado do robô por conversa.
export const botStatesTable = pgTable("bot_states", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull().unique(),
  stage: integer("stage").notNull().default(0), // 0=nada enviado; 1..N=aguardando resposta da pergunta N; N+1=triagem concluída (modo dúvidas)
  answers: jsonb("answers").notNull(), // string[]
  aiReplies: integer("ai_replies").notNull().default(0),
  active: boolean("active").notNull().default(true),
  summary: text("summary"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Contador diário de respostas de IA (controle de custo).
export const botUsageTable = pgTable(
  "bot_usage",
  {
    tenantId: integer("tenant_id").notNull().default(1),
    day: text("day").notNull(), // YYYY-MM-DD (America/Sao_Paulo)
    count: integer("count").notNull().default(0),
  },
  // Um contador por loja por dia (multi-tenant)
  (t) => [primaryKey({ columns: [t.tenantId, t.day] })],
);

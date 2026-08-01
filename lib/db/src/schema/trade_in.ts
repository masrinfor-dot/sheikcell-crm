import { pgTable, serial, text, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Avaliações de compra de celulares usados (estilo Trocafone): o vendedor
// descreve o aparelho e o estado, a IA pesquisa preços e sugere valor.
export const tradeInEvaluationsTable = pgTable("trade_in_evaluations", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  device: text("device").notNull(),            // ex.: "iPhone 13 128GB" (texto composto p/ IA e exibição)
  // Campos estruturados p/ filtros do histórico (marca/modelo/memória/cor).
  brand: text("brand"),
  model: text("model"),
  memory: text("memory"),
  color: text("color"),
  answers: jsonb("answers").notNull(),         // respostas do questionário de estado
  marketPrice: text("market_price"),           // faixa de preço de mercado (texto, ex.: "R$ 2.100 – R$ 2.600")
  suggestedPrice: text("suggested_price"),     // sugestão de valor de compra
  aiSummary: text("ai_summary"),               // justificativa da IA
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

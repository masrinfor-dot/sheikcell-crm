import { pgTable, serial, text, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Avaliações de compra de celulares usados (estilo Trocafone): o vendedor
// descreve o aparelho e o estado, a IA pesquisa preços e sugere valor.
export const tradeInEvaluationsTable = pgTable("trade_in_evaluations", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  device: text("device").notNull(),            // ex.: "iPhone 13 128GB" (texto composto p/ IA e exibição)
  // Campos estruturados p/ filtros do histórico (marca/modelo/memória/cor).
  brand: text("brand"),
  model: text("model"),
  memory: text("memory"),
  color: text("color"),
  // Nome do cliente informado já na simulação (etapas 1-3), antes de fechar o
  // negócio — opcional, só de referência/busca; não é o mesmo campo que
  // sellerCustomerName (esse sim é o nome "oficial" gravado ao fechar).
  customerName: text("customer_name"),
  answers: jsonb("answers").notNull(),         // respostas do questionário de estado
  marketPrice: text("market_price"),           // faixa de preço de mercado (texto, ex.: "R$ 2.100 – R$ 2.600")
  suggestedPrice: text("suggested_price"),     // sugestão de valor de compra
  aiSummary: text("ai_summary"),               // justificativa da IA
  createdAt: timestamp("created_at").notNull().defaultNow(),
  // Preenchidos só ao fechar o negócio (etapa 4) — uma avaliação pode nunca ser fechada.
  sellerCustomerName: text("seller_customer_name"), // nome de quem está vendendo o aparelho pra loja
  sellerCpf: text("seller_cpf"),
  imei: text("imei"),
  finalAgreedPrice: text("final_agreed_price"),     // valor final negociado (pode diferir do suggestedPrice)
  closedAt: timestamp("closed_at"),
  // Nota de compra completa (sub-fluxo pedido pelo usuário, "tudo de uma
  // vez"): dados pessoais além de nome/CPF, e fotos de documento/aparelho
  // pra comprovar a compra. Cada avaliação já é uma compra independente —
  // várias compras do mesmo cliente são só várias avaliações fechadas com o
  // mesmo CPF, sem precisar de nenhuma tabela nova.
  sellerRg: text("seller_rg"),
  sellerAddress: text("seller_address"),
  sellerPhone: text("seller_phone"),
  documentPhotos: jsonb("document_photos").$type<string[]>().notNull().default([]),
  devicePhotos: jsonb("device_photos").$type<string[]>().notNull().default([]),
});

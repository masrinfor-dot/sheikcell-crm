import { pgTable, serial, text, integer, timestamp, jsonb, numeric } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Avaliações de compra de celulares usados (estilo Trocafone): o vendedor
// descreve o aparelho e o estado, a IA pesquisa preços e sugere valor.
export const tradeInEvaluationsTable = pgTable("trade_in_evaluations", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  // "staff" = avaliação feita por alguém da loja (padrão, sempre foi assim).
  // "public_lead" = veio do formulário público da vitrine (cliente avaliou o
  // próprio aparelho sem login e deixou contato) — ver rota pública em
  // routes/tradeIn.ts (tradeInPublicRouter). Só muda a origem pra exibição/
  // filtro no histórico; o resto do fluxo (fechar negócio etc.) é idêntico.
  source: text("source").notNull().default("staff"),
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
  sellerNeighborhood: text("seller_neighborhood"), // bairro — separado do endereço livre, pra facilitar leitura na nota
  sellerPhone: text("seller_phone"),
  documentPhotos: jsonb("document_photos").$type<string[]>().notNull().default([]),
  devicePhotos: jsonb("device_photos").$type<string[]>().notNull().default([]),
  // Forma de pagamento ao cliente vendedor (Dinheiro/Pix/Cartão/Transferência —
  // texto livre, a loja pode digitar outra) + dados do Pix quando for o caso
  // (chave e titular podem ser de terceiro, ex.: familiar do vendedor) + foto
  // do comprovante (mesmo padrão de documentPhotos/devicePhotos).
  paymentMethod: text("payment_method"),
  pixKey: text("pix_key"),
  pixKeyHolder: text("pix_key_holder"), // titular da chave Pix (pode ser diferente do vendedor)
  paymentProofPhotos: jsonb("payment_proof_photos").$type<string[]>().notNull().default([]),
});
export type TradeInEvaluation = typeof tradeInEvaluationsTable.$inferSelect;

// "Tabela de valores base" (lista fixa) da Avaliação de Usados — pedido do
// lojista (06/09): pra modelo/armazenamento cadastrado aqui, o valor da
// avaliação PÚBLICA (cliente avaliando o próprio aparelho, sem login, ver
// tradeInPublicRouter) é calculado na hora por fórmula determinística
// (baseValue × margem da loja × desconto por defeito) em vez de depender de
// uma chamada de IA a cada visitante — mais rápido, sem custo de IA, e sem
// depender de limite de uso. Modelo que não está aqui continua caindo na IA
// (com limite por IP, ver COOLDOWN público em routes/tradeIn.ts).
export const tradeInBaseValuesTable = pgTable("trade_in_base_values", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  brand: text("brand").notNull(),   // ex.: "Apple", "Samsung" — comparado sem acento/maiúscula
  model: text("model").notNull(),   // ex.: "iPhone 13" — comparado sem acento/maiúscula
  // Armazenamento — null = vale pra qualquer armazenamento desse modelo
  // (usado quando o valor não varia por memória, ou como uma entrada "pega
  // tudo" de reserva).
  storage: text("storage"),
  // Valor de referência pra um aparelho em ESTADO PERFEITO (sem os descontos
  // do questionário) — o mesmo papel do "marketPrice"/"basePrice" que a IA
  // estimaria, só que fixo, digitado pelo lojista.
  baseValue: numeric("base_value").notNull(),
  notes: text("notes"), // observação livre do lojista (opcional)
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export type TradeInBaseValue = typeof tradeInBaseValuesTable.$inferSelect;

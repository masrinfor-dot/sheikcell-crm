import { pgTable, serial, text, integer, timestamp, numeric, jsonb, boolean } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Vitrine de Aparelhos — catálogo de produtos (módulo opcional "vitrine").
// Cada VARIANTE (armazenamento) tem custo, margem e preço de venda: o preço
// de venda é calculado a partir do custo + margem de lucro bruto + taxa de
// cartão da forma de pagamento de referência + custo de nota fiscal (ver
// lib/catalogPricing.ts), mas fica sempre gravado aqui e pode ser
// sobrescrito manualmente depois — o cálculo é só o ponto de partida.

// Selo de qualidade padrão SheikCell — 4 graus, cada um com critério fixo
// (tela, lateral, traseira, bateria, acessórios; Outlet também cobre o
// leitor de digital/facial). Mostrado tanto no cadastro quanto na vitrine
// pública, pra o cliente final saber exatamente o que esperar do aparelho.
export const CATALOG_CONDITIONS = ["novo", "excelente", "muito_bom", "bom", "outlet"] as const;
export type CatalogCondition = (typeof CATALOG_CONDITIONS)[number];

export const CATALOG_CONDITION_CRITERIA: Record<
  CatalogCondition,
  { label: string; criteria: { label: string; text: string }[] }
> = {
  novo: {
    label: "Novo",
    criteria: [
      { label: "Tela", text: "Lacrado de fábrica, nunca utilizado — sem nenhum sinal de uso" },
      { label: "Lateral", text: "Lacrado de fábrica, sem nenhum sinal de uso" },
      { label: "Traseira", text: "Lacrado de fábrica, sem nenhum sinal de uso" },
      { label: "Bateria", text: "100% da capacidade da bateria" },
      { label: "Acessórios", text: "Acompanha todos os acessórios originais de fábrica, lacrados" },
    ],
  },
  excelente: {
    label: "Excelente",
    criteria: [
      { label: "Tela", text: "Poucos ou nenhum sinal de uso, como pequenos riscos" },
      { label: "Lateral", text: "Pode apresentar arranhões imperceptíveis" },
      { label: "Traseira", text: "Pode apresentar pequeno desgaste ou arranhão, mas nada aparente" },
      { label: "Bateria", text: "Os aparelhos possuem no mínimo 80% da capacidade da bateria" },
      { label: "Acessórios", text: "Não acompanha acessórios" },
    ],
  },
  muito_bom: {
    label: "Muito Bom",
    criteria: [
      { label: "Tela", text: "Alguns sinais de uso, como pequenos riscos" },
      { label: "Lateral", text: "Pode apresentar pequenos amassados" },
      { label: "Traseira", text: "Pode apresentar arranhões leves" },
      { label: "Bateria", text: "Os aparelhos possuem no mínimo 80% da capacidade da bateria" },
      { label: "Acessórios", text: "Não acompanha acessórios" },
    ],
  },
  bom: {
    label: "Bom",
    criteria: [
      { label: "Tela", text: "Sinais de uso mais nítidos, como riscos" },
      { label: "Lateral", text: "Pode apresentar amassados, partes descascadas ou arranhões" },
      { label: "Traseira", text: "Pode apresentar riscos e arranhões nítidos" },
      { label: "Bateria", text: "Os aparelhos possuem no mínimo 80% da capacidade da bateria" },
      { label: "Acessórios", text: "Não acompanha acessórios" },
    ],
  },
  outlet: {
    label: "Outlet",
    criteria: [
      { label: "Tela", text: "Pode apresentar manchas fortes, sombras (efeito fantasma) e/ou riscos na tela" },
      { label: "Lateral", text: "Pode apresentar pequenos amassados, partes descascadas ou arranhões" },
      { label: "Traseira", text: "Pode apresentar riscos e arranhões nítidos" },
      { label: "Bateria", text: "Os aparelhos possuem no mínimo 80% da capacidade da bateria" },
      { label: "Leitor de Digital/Facial", text: "Pode não funcionar" },
      { label: "Acessórios", text: "Não acompanha acessórios" },
    ],
  },
};

// Categoria/aba personalizável (ex.: "Celulares" > "Samsung"/"Apple", "Peças
// de celular") — a loja cria/edita/apaga livremente, sem lista fixa no
// código. parentId null = categoria de topo (aba principal); parentId
// preenchido = subcategoria (sub-aba, mostrada quando a aba principal está
// selecionada na vitrine pública). Só 2 níveis são usados na UI hoje, mas o
// schema não impede aninhar mais.
export const catalogCategoriesTable = pgTable("catalog_categories", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  parentId: integer("parent_id"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type CatalogCategory = typeof catalogCategoriesTable.$inferSelect;

// Um "produto" é a FAMÍLIA do aparelho (modelo + condição + cores +
// descrição + fotos). Cada variação de armazenamento/memória vira uma linha
// em catalog_product_variants, com preço e estoque próprios — assim
// "iPhone 15 Pro Max" com 256GB e 512GB é UM cadastro só, com duas
// variantes, em vez de dois cards duplicados na vitrine.
export const catalogProductsTable = pgTable("catalog_products", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  model: text("model").notNull(), // ex.: "iPhone 15 Pro Max"
  condition: text("condition").notNull().default("bom"), // ver CATALOG_CONDITIONS
  colors: jsonb("colors").$type<string[]>().notNull().default([]),
  description: text("description"),
  status: text("status").notNull().default("active"), // active | inactive | sold
  categoryId: integer("category_id").references(() => catalogCategoriesTable.id, { onDelete: "set null" }),
  sortOrder: integer("sort_order").notNull().default(0),
  // Lista de características (armazenamento, RAM, tela, câmera, bateria...)
  // gerada por IA a partir do modelo/condição/cores, editável à mão pelo
  // lojista depois — mostrada na vitrine pública como "Principais
  // características" (mesma ideia da "Ficha técnica gerada por IA" da Lu, do
  // Magalu). Null/vazio = a vitrine pública não mostra essa seção.
  aiCharacteristics: jsonb("ai_characteristics").$type<string[]>(),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type CatalogProduct = typeof catalogProductsTable.$inferSelect;

// Variante de armazenamento de um produto — formação de preço própria (ver
// lib/catalogPricing.ts). costPrice normalmente vem da lista do fornecedor
// (importação por IA) ou é digitado na mão.
export const catalogProductVariantsTable = pgTable("catalog_product_variants", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull().references(() => catalogProductsTable.id, { onDelete: "cascade" }),
  storage: text("storage"), // ex.: "256GB" (texto livre — varia por fornecedor); null = não varia por armazenamento
  // Cor desta variante específica (texto livre) — permite unificar no MESMO
  // produto (mesmo modelo+condição) aparelhos que só diferem por
  // armazenamento e/ou cor, cada combinação com seu próprio preço/estoque.
  // Null = essa variante não distingue cor (usa as cores do produto, ver
  // catalogProductsTable.colors, só como texto informativo na vitrine).
  color: text("color"),
  costPrice: numeric("cost_price"),
  costIncludesInvoice: boolean("cost_includes_invoice").notNull().default(false),
  marginPercentOverride: numeric("margin_percent_override"), // null = usa a margem padrão da loja
  salePrice: numeric("sale_price"),
  // Preço de atacado — só aparece na vitrine pública pra quem desbloqueou
  // com o código de acesso (ver tenants.catalogWholesaleCode). Calculado
  // automaticamente a partir do custo (custo × margem de atacado, sem taxa
  // de cartão — é uma venda direta pra técnico/lojista), do mesmo jeito que
  // o preço de venda normal; pode ser sobrescrito manualmente digitando um
  // valor exato. Null = não foi possível calcular (sem custo informado).
  wholesalePrice: numeric("wholesale_price"),
  wholesaleMarginPercentOverride: numeric("wholesale_margin_percent_override"), // null = usa a margem de atacado padrão da loja
  // Preço "de" (comparação), digitado à mão pelo lojista — quando maior que o
  // preço à vista atual, a vitrine pública mostra ele riscado ao lado do
  // preço final, com um selo de desconto ("X% OFF"). Null = não mostra
  // desconto nenhum (comportamento de antes desse campo existir).
  compareAtPrice: numeric("compare_at_price"),
  stockQty: integer("stock_qty").notNull().default(1),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type CatalogProductVariant = typeof catalogProductVariantsTable.$inferSelect;

// Fotos do aparelho — o arquivo em si fica no disco (CATALOG_MEDIA_DIR),
// aqui só os metadados (mesmo padrão de documentsTable em schema/documents.ts).
// Uma foto pode vir de upload manual ou de busca de imagem (sourceUrl guarda
// a origem, pra auditoria/repetir a busca depois).
export const catalogProductPhotosTable = pgTable("catalog_product_photos", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull().references(() => catalogProductsTable.id, { onDelete: "cascade" }),
  storedName: text("stored_name").notNull(),
  sourceUrl: text("source_url"), // null = upload manual; preenchido = veio de busca de imagem
  // Marca se é a foto da caixa/embalagem lacrada (em vez do aparelho em si).
  // Só faz sentido pra condição "novo": a vitrine pública mostra a foto da
  // caixa primeiro nesse caso; pra qualquer outra condição (seminovo/outlet)
  // fotos de caixa são ignoradas — só interessa mostrar o aparelho de fato.
  isBoxPhoto: boolean("is_box_photo").notNull().default(false),
  // Qual cor cadastrada do produto (catalogProductsTable.colors) essa foto
  // representa — null = foto "geral" (mostrada pra qualquer cor selecionada,
  // e usada de fallback quando a cor escolhida não tem foto própria). Some
  // preenchida automaticamente pela busca automática de fotos por cor, ou
  // manualmente pelo lojista ao marcar a cor de uma foto já anexada.
  color: text("color"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type CatalogProductPhoto = typeof catalogProductPhotosTable.$inferSelect;

// "Avise-me quando chegar" — pedido de um cliente (sem login, vitrine
// pública) pra ser avisado quando um produto/variante esgotado voltar a ter
// estoque. variantId null = pediu pro produto de forma geral (não escolheu
// uma variante específica antes de esgotar). notified = o lojista já
// contatou esse cliente (marcação manual, ver painel admin da Vitrine) —
// nunca dispara nada sozinho, é só uma lista de contatos pra loja seguir.
export const catalogStockNotificationsTable = pgTable("catalog_stock_notifications", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull().references(() => catalogProductsTable.id, { onDelete: "cascade" }),
  variantId: integer("variant_id").references(() => catalogProductVariantsTable.id, { onDelete: "cascade" }),
  customerName: text("customer_name").notNull(),
  customerContact: text("customer_contact").notNull(),
  notified: boolean("notified").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type CatalogStockNotification = typeof catalogStockNotificationsTable.$inferSelect;

// Avaliação de cliente (estrelas + comentário) — só aparece o botão "Avaliar"
// na vitrine pública pra quem está no modo varejo (sem o código de atacado
// desbloqueado, ver wholesaleUnlocked no front). Pede nome/telefone/cidade
// (mesma ideia do "avise-me") pra loja poder confirmar que é venda real, não
// pra criar conta nenhuma. Sem moderação/aprovação prévia — aparece direto na
// vitrine; a loja apaga manualmente pelo painel (botão "Avaliações") se
// algum comentário for indevido.
export const catalogProductReviewsTable = pgTable("catalog_product_reviews", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull().references(() => catalogProductsTable.id, { onDelete: "cascade" }),
  variantId: integer("variant_id").references(() => catalogProductVariantsTable.id, { onDelete: "cascade" }),
  rating: integer("rating").notNull(), // 1 a 5
  customerName: text("customer_name").notNull(),
  customerPhone: text("customer_phone").notNull(),
  customerCity: text("customer_city").notNull(),
  comment: text("comment"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type CatalogProductReview = typeof catalogProductReviewsTable.$inferSelect;

import { pgTable, serial, text, boolean, timestamp, integer, doublePrecision } from "drizzle-orm/pg-core";

// Lojas da rede — cadastradas pelo admin e usadas como opção de seleção
// no cadastro de vendedores (users.storeName) e clientes (crm_contacts.serviceStore).
// O nome é copiado para esses campos de texto existentes, mantendo compatível
// todo o código que já usa storeName/serviceStore.
export const storesTable = pgTable("stores", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Identidade fiscal da loja — cada loja da rede pode ser um CNPJ/regime
  // tributário diferente (necessário para o módulo financeiro bancário: cada
  // conta/maquininha pertence a uma loja com sua própria identidade fiscal).
  cnpj: text("cnpj"),
  fiscalRegime: text("fiscal_regime"), // simples | presumido | real
  address: text("address"),
  city: text("city"),
  state: text("state"), // UF, 2 letras
  zipCode: text("zip_code"),
  // Geofence do Ponto (pedido 15/09, análise Tangerino "Local de Interesse")
  // — raio permitido pra bater ponto de entrada nesta loja. Null (qualquer
  // um dos 3 campos) = geofence não configurado pra esta loja: comportamento
  // de sempre, nada é sinalizado por localização. Configurado, o backend só
  // SINALIZA (flagged) a batida feita fora do raio — nunca bloqueia (mesmo
  // espírito de reconhecimento facial/foto: sinaliza, RH revisa depois).
  geofenceLat: doublePrecision("geofence_lat"),
  geofenceLng: doublePrecision("geofence_lng"),
  geofenceRadiusMeters: integer("geofence_radius_meters"),
  // Participa do "pular fila" por palavra-chave (pedido 18/09, ver
  // routing_rules.skipQueue e lib/skipQueueAssign.ts) — quando true, os
  // vendedores DESTA loja entram como candidatos a receber, na hora, uma
  // conversa nova que bateu numa regra de pular fila (ex.: "xerox"). Uma
  // conversa em si não tem loja definida antes de ser atribuída (a vitrine
  // recebe mensagens por número/setor, não por loja) — este interruptor
  // controla quais VENDEDORES participam, não qual conversa é roteada.
  // Default false: nenhuma loja participa até o admin ligar explicitamente
  // aqui (Setores → Lojas da Rede).
  skipQueueEnabled: boolean("skip_queue_enabled").notNull().default(false),
});

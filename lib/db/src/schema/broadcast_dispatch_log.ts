import { pgTable, serial, integer, text, timestamp, jsonb } from "drizzle-orm/pg-core";

// Métricas do "Disparar mensagem para vários" (lista de transmissão do
// ChatCenter, categoria Resolvidas) — pedido do usuário (19/09): "criar
// métrica para disparo: quantidade, tempo de envio, tempo de intervalo etc".
// Antes desta tabela nada ficava salvo — o resultado só aparecia no toast na
// hora e sumia. Cada linha aqui é UMA leva disparada (até BROADCAST_MAX_BATCH
// conversas), com o intervalo entre mensagens realmente usado (ver
// broadcast_interval_ms em app_settings) e o resultado final por conversa.
export const broadcastDispatchLogTable = pgTable("broadcast_dispatch_log", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  // Sem FK/cascade: precisa sobreviver à exclusão do usuário (fato histórico).
  userId: integer("user_id"),
  userName: text("user_name").notNull(),
  message: text("message").notNull(),
  totalSelected: integer("total_selected").notNull(),
  sentCount: integer("sent_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  // Intervalo (ms) entre um envio e o próximo, usado NESTA leva especificamente
  // (a configuração pode mudar depois — o histórico preserva o valor real usado).
  intervalMs: integer("interval_ms").notNull(),
  // "running" | "done" — processado em segundo plano (loop com intervalo real
  // entre mensagens pode passar de 1-2 minutos pra levas grandes; não dá pra
  // segurar a requisição HTTP aberta esse tempo todo).
  status: text("status").notNull().default("running"),
  results: jsonb("results").$type<{ id: number; ok: boolean; reason?: string }[]>(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

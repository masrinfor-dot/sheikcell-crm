import { db, routineScoreWeightsTable, type RoutineClosure } from "@workspace/db";
import { eq } from "drizzle-orm";

// Fase 6: score de produtividade por funcionário — NÃO premia só
// "quantidade de checklists respondidos" (pedido explícito do relatório
// mestre, item 55). Combina três componentes independentes, cada um
// normalizado pra 0-1:
//
//   onTimeRate       = totalOnTime / totalDue
//                       (respondeu dentro do horário+tolerância do checklist)
//   noPendencyRate    = 1 - totalWithPendency / totalDue
//                       (não deixou pendência em aberto numa resposta negativa)
//   noUrgentAbuseRate = 1 - min(1, totalUrgentBypass / totalDue)
//                       (não usou "Atendimento urgente" repetidamente —
//                       satura em 0 se o nº de bypasses igualar ou passar o
//                       nº de checklists devidos no mês)
//
// score = 100 * (w1·onTimeRate + w2·noPendencyRate + w3·noUrgentAbuseRate) / (w1+w2+w3)
//
// Os pesos (w1/w2/w3) são configuráveis por tenant em routine_score_weights
// (admin edita, sem precisar de deploy) — padrão 50/30/20. A normalização
// pela soma dos pesos significa que o admin não precisa manter a soma em
// 100: só a PROPORÇÃO entre os três pesos importa.
//
// totalDue=0 no mês (função sem checklist aplicável, ou funcionário
// afastado o mês inteiro) retorna score null — não é justo comparar
// "0 de 0" com quem de fato respondeu algo, então esse funcionário fica de
// fora do ranking em vez de aparecer com nota artificial.

export type RoutineScoreWeights = { weightOnTime: number; weightNoPendency: number; weightNoUrgentAbuse: number };
export const DEFAULT_SCORE_WEIGHTS: RoutineScoreWeights = { weightOnTime: 50, weightNoPendency: 30, weightNoUrgentAbuse: 20 };

export async function getScoreWeights(tenantId: number): Promise<RoutineScoreWeights> {
  const [row] = await db.select().from(routineScoreWeightsTable).where(eq(routineScoreWeightsTable.tenantId, tenantId));
  return row
    ? { weightOnTime: row.weightOnTime, weightNoPendency: row.weightNoPendency, weightNoUrgentAbuse: row.weightNoUrgentAbuse }
    : DEFAULT_SCORE_WEIGHTS;
}

export type RoutineScoreBreakdown = {
  score: number;
  onTimeRate: number; noPendencyRate: number; noUrgentAbuseRate: number;
};

export function computeRoutineScore(c: RoutineClosure, weights: RoutineScoreWeights): RoutineScoreBreakdown | null {
  if (c.totalDue === 0) return null;
  const totalWeight = weights.weightOnTime + weights.weightNoPendency + weights.weightNoUrgentAbuse;
  if (totalWeight <= 0) return null;

  const onTimeRate = c.totalOnTime / c.totalDue;
  const noPendencyRate = 1 - c.totalWithPendency / c.totalDue;
  const noUrgentAbuseRate = 1 - Math.min(1, c.totalUrgentBypass / c.totalDue);

  const raw = (weights.weightOnTime * onTimeRate + weights.weightNoPendency * noPendencyRate + weights.weightNoUrgentAbuse * noUrgentAbuseRate) / totalWeight;
  return {
    score: Math.round(raw * 1000) / 10, // 0-100, 1 casa decimal
    onTimeRate: Math.round(onTimeRate * 1000) / 10,
    noPendencyRate: Math.round(noPendencyRate * 1000) / 10,
    noUrgentAbuseRate: Math.round(noUrgentAbuseRate * 1000) / 10,
  };
}

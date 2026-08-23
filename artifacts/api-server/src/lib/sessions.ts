import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// Controle de sessões (item 15 do roadmap de segurança). Reaproveita a
// própria tabela "session" do connect-pg-simple (sid, sess jsonb, expire) —
// sem tabela nova. sess->>'userId' funciona igual pra número ou string
// dentro do JSON (extração sempre devolve texto).

const MAX_SESSIONS_PER_USER = 2;

// No máximo N sessões ativas por usuário — ao logar de novo, encerra as
// mais antigas (sessões sem loginAt registrado, de antes dessa feature,
// são tratadas como as mais antigas de todas). currentSid ainda não foi
// gravado na tabela nesse ponto do login, por isso o "+1" na conta.
export async function enforceSessionLimit(userId: number, currentSid: string): Promise<void> {
  const rows = await db.execute(sql`
    select sid from session
    where sess->>'userId' = ${String(userId)} and sid != ${currentSid} and expire > now()
    order by (sess->>'loginAt') asc nulls first
  `);
  const others = rows.rows as { sid: string }[];
  const excess = others.length + 1 - MAX_SESSIONS_PER_USER;
  for (let i = 0; i < excess; i++) {
    await db.execute(sql`delete from session where sid = ${others[i]!.sid}`);
  }
}

export function parseUserAgent(ua: string | null | undefined): { device: string; browser: string } {
  if (!ua) return { device: "Desconhecido", browser: "Desconhecido" };
  const device = /iPhone/i.test(ua) ? "iPhone"
    : /iPad/i.test(ua) ? "iPad"
    : /Android/i.test(ua) ? "Android"
    : /Mobile/i.test(ua) ? "Celular"
    : "Computador";
  const browser = /Edg\//i.test(ua) ? "Edge"
    : /OPR\//i.test(ua) ? "Opera"
    : /Chrome\//i.test(ua) ? "Chrome"
    : /Firefox\//i.test(ua) ? "Firefox"
    : /Safari\//i.test(ua) ? "Safari"
    : "Navegador";
  return { device, browser };
}

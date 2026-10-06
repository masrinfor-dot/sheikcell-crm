/** Endereço da API do ERP salvo na integração (só https, sem barra no fim). */
export function validErpBaseUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname))) return null;
    // Erro comum (06/10/2026): colar o endereço da tela do ERP
    // (https://erp.…/integracoes) em vez do da API. O CRM completa
    // "/integrations/…" sozinho, então tira esse final e, se for o endereço
    // das telas (erp.…), troca pelo da API (api.…/api/v1).
    let path = u.pathname.replace(/\/+$/, "").replace(/\/(integra[cç](o|õ)es|integrations)$/i, "");
    if (u.hostname.startsWith("erp.") && (path === "" || path === "/")) {
      u.hostname = `api.${u.hostname.slice(4)}`;
      path = "/api/v1";
    }
    u.pathname = path || "/";
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

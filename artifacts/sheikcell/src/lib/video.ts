// Converte links de YouTube em URL de embed; outros links retornam null
// (mostramos um botão "assistir" que abre em nova aba).
export function youtubeEmbedUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtu.be") {
      const id = u.pathname.slice(1).split("/")[0];
      return id ? `https://www.youtube.com/embed/${id}` : null;
    }
    if (host === "youtube.com" || host === "m.youtube.com") {
      if (u.pathname === "/watch") {
        const id = u.searchParams.get("v");
        return id ? `https://www.youtube.com/embed/${id}` : null;
      }
      const short = u.pathname.match(/^\/(shorts|embed|live)\/([\w-]+)/);
      if (short) return `https://www.youtube.com/embed/${short[2]}`;
    }
    return null;
  } catch {
    return null;
  }
}

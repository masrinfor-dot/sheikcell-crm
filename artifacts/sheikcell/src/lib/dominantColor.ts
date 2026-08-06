// Extrai a cor predominante de uma imagem (data URL) desenhando-a num canvas
// e contando as cores mais frequentes entre os pixels. Ignora pixels
// transparentes e os muito claros/escuros (fundo branco e texto preto são
// comuns em logos e não representam a "cor da marca").
export function extractDominantColor(dataUrl: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const size = 100;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(null);
        return;
      }
      ctx.drawImage(img, 0, 0, size, size);

      let data: Uint8ClampedArray;
      try {
        data = ctx.getImageData(0, 0, size, size).data;
      } catch {
        resolve(null);
        return;
      }

      const counts = new Map<string, number>();
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
        if (a < 128) continue;
        const lightness = (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
        if (lightness > 240 || lightness < 15) continue;
        // Quantiza pra agrupar tons próximos como a mesma cor "predominante".
        const key = [r, g, b].map((c) => Math.round(c / 16) * 16).join(",");
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }

      let bestKey: string | null = null;
      let bestCount = 0;
      for (const [key, count] of counts) {
        if (count > bestCount) {
          bestCount = count;
          bestKey = key;
        }
      }
      if (!bestKey) {
        resolve(null);
        return;
      }
      const [r, g, b] = bestKey.split(",").map(Number);
      const hex = `#${[r, g, b].map((c) => Math.min(255, c).toString(16).padStart(2, "0")).join("")}`;
      resolve(hex);
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

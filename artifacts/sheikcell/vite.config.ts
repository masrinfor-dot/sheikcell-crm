import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
import { VitePWA } from "vite-plugin-pwa";

const rawPort = process.env.PORT;

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH;

if (!basePath) {
  throw new Error(
    "BASE_PATH environment variable is required but was not provided.",
  );
}

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    // PWA: permite "Instalar app" no Android/desktop (ícone próprio, tela
    // cheia, abre como app) sem precisar de loja nem de um APK separado.
    // Só faz cache dos arquivos estáticos do build (JS/CSS/ícones) — nunca
    // intercepta /api/* nem mídia (áudio/imagem do chat), pra não arriscar
    // servir dado desatualizado ou mexer no problema de áudio no celular.
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Sheikcell - Sistema de Atendimento",
        short_name: "Sheikcell",
        description: "Central de Atendimento Sheikcell — CRM e chat integrado",
        theme_color: "#FF3C00",
        // Mesma cor de fundo do splash do app mobile (Expo), pra manter a
        // identidade visual igual entre o PWA e o APK.
        background_color: "#1a2e6e",
        display: "standalone",
        orientation: "portrait",
        start_url: ".",
        scope: ".",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "icons/icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // Nunca cacheia /api/* — o chat precisa sempre de dados frescos.
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ["**/*.{js,css,html,ico,svg,png,woff2}"],
        // O bundle principal passa de 2 MB (app grande, com pdf.js etc.);
        // sem isso o build falha recusando pré-cachear esse arquivo.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
    }),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
    },
    // Em produção o Nginx/Replit fazem esse roteamento de /api para a API;
    // localmente o dev server do Vite precisa fazer isso ele mesmo.
    proxy: process.env.API_PROXY_TARGET
      ? {
          "/api": {
            target: process.env.API_PROXY_TARGET,
            changeOrigin: true,
          },
        }
      : undefined,
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});

// PM2 process manager — roda a API e o WhatsApp Bridge como serviços.
// As variáveis sensíveis (DATABASE_URL, SESSION_SECRET, OPENAI_API_KEY) NÃO
// ficam aqui: elas vêm do arquivo .env, carregado pelo deploy.sh com
// `pm2 startOrReload ... --update-env`. Aqui só definimos NODE_ENV e a PORTA
// de cada serviço (que precisam ser diferentes).
module.exports = {
  apps: [
    {
      name: "sheikcell-api",
      cwd: "/var/www/sheikcell",
      script: "artifacts/api-server/dist/index.mjs",
      node_args: "--enable-source-maps",
      env: { NODE_ENV: "production", PORT: "8080" },
      max_restarts: 10,
      restart_delay: 2000,
    },
    {
      name: "sheikcell-whatsapp",
      cwd: "/var/www/sheikcell",
      script: "artifacts/whatsapp-bridge/dist/index.mjs",
      node_args: "--enable-source-maps",
      env: { NODE_ENV: "production", PORT: "3002" },
      max_restarts: 10,
      restart_delay: 2000,
    },
  ],
};

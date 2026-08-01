import app from "./app";
import { logger } from "./lib/logger";
import { ensureSeed } from "./lib/seed";
import { runMigrations } from "./lib/migrate";
import { startScheduler } from "./lib/scheduler";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Migrações ANTES de abrir a porta e do agendador: nenhuma requisição pode ser
// atendida com o schema antigo (sem tenant_id o isolamento entre lojas não
// existe). Falha de migração = processo encerra sem servir tráfego.
runMigrations()
  .then(() => {
    app.listen(port, (err) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }

      logger.info({ port }, "Server listening");

      ensureSeed().catch((e) => logger.error({ err: e }, "Seed error"));
      startScheduler();
    });
  })
  .catch((e) => {
    logger.error({ err: e }, "Migration error — encerrando sem servir tráfego");
    process.exit(1);
  });

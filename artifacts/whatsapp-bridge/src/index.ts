import express from "express";
import { logger } from "./lib/logger";
import bridgeRouter from "./routes/index";
import { connect } from "./lib/waConnection";

const app = express();
const PORT = Number(process.env["PORT"] ?? 3002);

app.use(express.json({ limit: "30mb" }));
app.use(bridgeRouter);

app.listen(PORT, () => {
  logger.info({ port: PORT }, "WhatsApp Bridge (Baileys + DB session) listening");
  // Start Baileys connection — will auto-reconnect from DB auth state if available
  void connect();
});

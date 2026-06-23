import express from "express";
import { logger } from "./lib/logger";
import bridgeRouter from "./routes/index";

const app = express();
const PORT = Number(process.env["PORT"] ?? 3002);

app.use(express.json({ limit: "1mb" }));
app.use(bridgeRouter);

app.listen(PORT, () => {
  logger.info({ port: PORT }, "WhatsApp Bridge (Meta Cloud API) listening");
});

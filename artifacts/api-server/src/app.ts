import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool } from "@workspace/db";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

// Atrás do proxy reverso (EasyPanel/Traefik) — necessário para o cookie
// de sessão "secure" funcionar em produção (HTTPS termina no proxy).
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(cors({
  origin: true,
  credentials: true,
}));

app.use(
  express.json({
    // Fotos/áudios chegam em base64 no JSON (webhook do bridge e envio de mídia
    // pelo painel) — 1mb bloqueava qualquer foto real com 413.
    limit: "30mb",
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

const PgSession = connectPgSimple(session);

app.use(
  session({
    store: new PgSession({
      pool,
      tableName: "session",
      createTableIfMissing: true,
    }),
    secret: process.env["SESSION_SECRET"] ?? (() => {
      if (process.env["NODE_ENV"] === "production") {
        throw new Error("SESSION_SECRET env var is required in production");
      }
      return "sheikcell-dev-only-secret";
    })(),
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env["NODE_ENV"] === "production",
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000,
      sameSite: "lax",
    },
  })
);

// Sessões criadas ANTES do multi-loja não têm tenantId gravado — sem isso o
// fail-closed esconde todos os dados ("Sessão sem loja"). Aqui a sessão antiga
// se corrige sozinha: busca a loja do usuário no banco uma única vez e grava.
app.use("/api", async (req, _res, next) => {
  const s = req.session;
  if (s?.userId && typeof s.tenantId !== "number" && s.userRole !== "superadmin") {
    try {
      const { db, usersTable } = await import("@workspace/db");
      const { eq } = await import("drizzle-orm");
      const [u] = await db.select({ tenantId: usersTable.tenantId, role: usersTable.role })
        .from(usersTable).where(eq(usersTable.id, s.userId));
      if (u && u.role !== "superadmin" && typeof u.tenantId === "number") {
        s.tenantId = u.tenantId;
        s.userRole = u.role;
      }
    } catch { /* segue fail-closed; o login normal ainda resolve */ }
  }
  next();
});

app.use("/api", router);

export default app;

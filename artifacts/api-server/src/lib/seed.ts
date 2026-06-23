import bcrypt from "bcryptjs";
import { db, usersTable, sectorsTable } from "@workspace/db";
import { eq, count } from "drizzle-orm";
import { logger } from "./logger";

const DEFAULT_SECTORS = [
  { name: "Vendas de Celulares", description: "Venda de smartphones e aparelhos", icon: "smartphone", color: "#1a2e6e" },
  { name: "Venda de Acessórios", description: "Capinhas, fones, carregadores e mais", icon: "headphones", color: "#0e6eb8" },
  { name: "Assistência Técnica", description: "Reparos, manutenção e consertos", icon: "wrench", color: "#f59e0b" },
  { name: "Financeiro / Caixa", description: "Pagamentos, parcelas e financiamento", icon: "dollar-sign", color: "#10b981" },
  { name: "RH / Administrativo / Compras", description: "Recursos humanos e administrativo", icon: "users", color: "#8b5cf6" },
] as const;

const ADMIN_EMAIL = process.env["ADMIN_EMAIL"] ?? "admin@sheikcell.com";

function resolveAdminPassword(): string {
  if (process.env["ADMIN_PASSWORD"]) return process.env["ADMIN_PASSWORD"];
  if (process.env["NODE_ENV"] === "production") {
    // Generate a random password in production when env var not set
    const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#";
    let pwd = "";
    for (let i = 0; i < 16; i++) {
      pwd += chars[Math.floor(Math.random() * chars.length)];
    }
    return pwd;
  }
  // Development only — never used in production without ADMIN_PASSWORD env var
  return "admin123";
}

export async function ensureSeed(): Promise<void> {
  try {
    // Seed sectors if none exist
    const [{ sectorCount }] = await db
      .select({ sectorCount: count() })
      .from(sectorsTable);

    if (Number(sectorCount) === 0) {
      await db.insert(sectorsTable).values(
        DEFAULT_SECTORS.map((s) => ({ ...s, isActive: true }))
      );
      logger.info("Seeded default sectors");
    }

    // Get the first sector id (for admin assignment)
    const [firstSector] = await db.select({ id: sectorsTable.id }).from(sectorsTable).limit(1);

    // Seed default admin user only if no users exist at all
    const [{ userCount }] = await db
      .select({ userCount: count() })
      .from(usersTable);

    if (Number(userCount) === 0) {
      const adminPassword = resolveAdminPassword();
      const passwordHash = await bcrypt.hash(adminPassword, 10);
      await db.insert(usersTable).values({
        name: "Admin Sheikcell",
        email: ADMIN_EMAIL,
        passwordHash,
        role: "admin",
        sectorId: firstSector?.id ?? 1,
        isActive: true,
      });
      if (process.env["NODE_ENV"] === "production") {
        // Print credentials once to server logs on first run
        logger.warn(
          { email: ADMIN_EMAIL },
          "⚠️  First-run admin created. Set ADMIN_EMAIL / ADMIN_PASSWORD env vars before next deploy to control these credentials. Change the password immediately after first login."
        );
      } else {
        logger.info({ email: ADMIN_EMAIL }, "Seeded default admin user (dev)");
      }
    }
  } catch (err) {
    logger.error({ err }, "Seed failed — continuing startup");
  }
}

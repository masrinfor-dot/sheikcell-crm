/**
 * Credential rotation script for the WhatsApp Baileys session.
 *
 * Run this whenever WhatsApp auth material may have been exposed
 * (e.g. session files were committed to git history). It wipes the
 * database-backed Baileys auth state so the bridge must re-authenticate
 * via QR scan on next startup, generating a completely fresh key set.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run rotate-wa-credentials
 *
 * After running:
 *   1. Restart the whatsapp-bridge workflow.
 *   2. Open the admin dashboard → WhatsApp and scan the new QR code.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { pgTable, text, timestamp, primaryKey } from "drizzle-orm/pg-core";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error("ERROR: DATABASE_URL environment variable is not set.");
  process.exit(1);
}

const whatsappAuthStateTable = pgTable(
  "whatsapp_auth_state",
  {
    sessionKey: text("session_key").notNull(),
    dataKey: text("data_key").notNull(),
    value: text("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sessionKey, t.dataKey] })],
);

const whatsappSessionsTable = pgTable("whatsapp_sessions", {
  sessionKey: text("session_key").primaryKey(),
  status: text("status").notNull().default("disconnected"),
  phoneNumber: text("phone_number"),
  phoneId: text("phone_id"),
  errorMessage: text("error_message"),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool, { schema: { whatsappAuthStateTable, whatsappSessionsTable } });

  try {
    console.log("Clearing whatsapp_auth_state table (all sessions)…");
    const deleted = await db.delete(whatsappAuthStateTable).returning({ sessionKey: whatsappAuthStateTable.sessionKey, dataKey: whatsappAuthStateTable.dataKey });
    console.log(`  Deleted ${deleted.length} auth-state rows.`);

    console.log("Resetting whatsapp_sessions status to disconnected…");
    await db
      .update(whatsappSessionsTable)
      .set({ status: "disconnected", phoneNumber: null, phoneId: null, lastHeartbeatAt: null, errorMessage: "Credentials rotated — re-scan QR to reconnect.", updatedAt: new Date() });
    console.log("  Done.");

    console.log("\nCredential rotation complete.");
    console.log("Next steps:");
    console.log("  1. Restart the whatsapp-bridge workflow.");
    console.log("  2. Open the admin dashboard → WhatsApp and scan the new QR code.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Rotation failed:", err);
  process.exit(1);
});

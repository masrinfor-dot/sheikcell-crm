/**
 * DB-backed Baileys auth state.
 * Replaces useMultiFileAuthState — persists all creds/keys to PostgreSQL
 * so the session survives server restarts and re-deployments.
 */
import {
  initAuthCreds,
  BufferJSON,
  type AuthenticationCreds,
  type SignalDataSet,
  type SignalDataTypeMap,
  type SignalKeyStore,
} from "@whiskeysockets/baileys";
import { db, whatsappAuthStateTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

type AuthenticationState = {
  creds: AuthenticationCreds;
  keys: SignalKeyStore;
};

const TABLE = whatsappAuthStateTable;

async function readFromDb(sessionKey: string, dataKey: string): Promise<unknown | null> {
  const rows = await db
    .select()
    .from(TABLE)
    .where(and(eq(TABLE.sessionKey, sessionKey), eq(TABLE.dataKey, dataKey)))
    .limit(1);
  if (!rows[0]) return null;
  try { return JSON.parse(rows[0].value, BufferJSON.reviver) as unknown; } catch { return null; }
}

async function writeToDb(sessionKey: string, dataKey: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value, BufferJSON.replacer);
  await db
    .insert(TABLE)
    .values({ sessionKey, dataKey, value: serialized, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [TABLE.sessionKey, TABLE.dataKey],
      set: { value: serialized, updatedAt: new Date() },
    });
}

async function deleteFromDb(sessionKey: string, dataKey: string): Promise<void> {
  await db
    .delete(TABLE)
    .where(and(eq(TABLE.sessionKey, sessionKey), eq(TABLE.dataKey, dataKey)));
}

export async function useDatabaseAuthState(sessionKey: string): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  const stored = await readFromDb(sessionKey, "creds");
  const creds = (stored ?? initAuthCreds()) as AuthenticationCreds;

  const keys: SignalKeyStore = {
    get: async <T extends keyof SignalDataTypeMap>(
      type: T,
      ids: string[],
    ): Promise<{ [id: string]: SignalDataTypeMap[T] }> => {
      const result: { [id: string]: SignalDataTypeMap[T] } = {};
      await Promise.all(
        ids.map(async (id) => {
          const val = await readFromDb(sessionKey, `${type}-${id}`);
          if (val !== null) result[id] = val as SignalDataTypeMap[T];
        }),
      );
      return result;
    },
    set: async (data: SignalDataSet): Promise<void> => {
      const ops: Promise<void>[] = [];
      for (const [type, typeData] of Object.entries(data) as [string, Record<string, unknown>][]) {
        for (const [id, value] of Object.entries(typeData)) {
          if (value != null) {
            ops.push(writeToDb(sessionKey, `${type}-${id}`, value));
          } else {
            ops.push(deleteFromDb(sessionKey, `${type}-${id}`));
          }
        }
      }
      await Promise.all(ops);
    },
  };

  const state: AuthenticationState = { creds, keys };

  return {
    state,
    saveCreds: () => writeToDb(sessionKey, "creds", state.creds),
  };
}

export async function clearAuthState(sessionKey: string): Promise<void> {
  await db
    .delete(TABLE)
    .where(eq(TABLE.sessionKey, sessionKey));
}

export async function hasAuthState(sessionKey: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(TABLE)
    .where(and(eq(TABLE.sessionKey, sessionKey), eq(TABLE.dataKey, "creds")))
    .limit(1);
  return rows.length > 0;
}

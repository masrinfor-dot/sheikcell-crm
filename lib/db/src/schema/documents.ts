import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Arquivo de documentos da loja: atas de reunião, contratos, comunicados etc.
// O arquivo em si fica no disco (DOCS_DIR); aqui só os metadados.
export const documentsTable = pgTable("documents", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  category: text("category").notNull().default("documento"), // ata | documento | comunicado | contrato
  description: text("description"),
  fileName: text("file_name").notNull(), // nome original mostrado ao usuário
  storedName: text("stored_name").notNull(), // nome do arquivo no disco
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull().default(0),
  uploadedBy: integer("uploaded_by").references(() => usersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

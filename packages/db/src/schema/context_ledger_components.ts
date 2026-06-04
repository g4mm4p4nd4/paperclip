import { index, integer, jsonb, pgTable, text, timestamp, uuid, boolean } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { contextLedgerEntries } from "./context_ledger_entries.js";

export const contextLedgerComponents = pgTable(
  "context_ledger_components",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => contextLedgerEntries.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    componentType: text("component_type").notNull().default("prompt_component"),
    contentSha256: text("content_sha256").notNull(),
    chars: integer("chars").notNull().default(0),
    estimatedTokens: integer("estimated_tokens").notNull().default(0),
    truncated: boolean("truncated").notNull().default(false),
    evidenceSliceCount: integer("evidence_slice_count").notNull().default(0),
    artifactRef: jsonb("artifact_ref").$type<Record<string, unknown>>(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    entryIdx: index("context_ledger_components_entry_idx").on(table.entryId),
    companyHashIdx: index("context_ledger_components_company_hash_idx").on(table.companyId, table.contentSha256),
  }),
);

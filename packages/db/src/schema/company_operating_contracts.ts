import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projectWorkspaces } from "./project_workspaces.js";

export const companyOperatingContracts = pgTable(
  "company_operating_contracts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectWorkspaceId: uuid("project_workspace_id").references(() => projectWorkspaces.id, { onDelete: "set null" }),
    packageRootPath: text("package_root_path").notNull().default("."),
    lastReviewSourceHash: text("last_review_source_hash"),
    lastReviewedSnapshot: jsonb("last_reviewed_snapshot").$type<Record<string, unknown>>(),
    lastReviewedAt: timestamp("last_reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUniqueIdx: uniqueIndex("company_operating_contracts_company_idx").on(table.companyId),
    workspaceIdx: index("company_operating_contracts_workspace_idx").on(table.projectWorkspaceId),
  }),
);

import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const promptBudgetPolicies = pgTable(
  "prompt_budget_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    scopeType: text("scope_type").notNull().default("company"),
    scopeId: uuid("scope_id").notNull(),
    maxPromptTokens: integer("max_prompt_tokens").notNull().default(0),
    warnPromptTokens: integer("warn_prompt_tokens").notNull().default(0),
    hardStopEnabled: boolean("hard_stop_enabled").notNull().default(true),
    isActive: boolean("is_active").notNull().default(true),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyScopeActiveIdx: index("prompt_budget_policies_company_scope_active_idx").on(
      table.companyId,
      table.scopeType,
      table.scopeId,
      table.isActive,
    ),
    companyScopeUniqueIdx: uniqueIndex("prompt_budget_policies_company_scope_uq").on(
      table.companyId,
      table.scopeType,
      table.scopeId,
    ),
  }),
);

import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const agentContextCursors = pgTable(
  "agent_context_cursors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id"),
    taskKey: text("task_key").notNull().default(""),
    latestCommentId: uuid("latest_comment_id"),
    commentCursor: jsonb("comment_cursor").$type<Record<string, unknown>>(),
    wakeCursor: jsonb("wake_cursor").$type<Record<string, unknown>>(),
    wakeCount: integer("wake_count").notNull().default(0),
    lastRunId: uuid("last_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    sessionDisplayId: text("session_display_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentTaskUniqueIdx: uniqueIndex("agent_context_cursors_company_agent_task_uq").on(
      table.companyId,
      table.agentId,
      table.taskKey,
    ),
    companyIssueIdx: index("agent_context_cursors_company_issue_idx").on(table.companyId, table.issueId),
  }),
);

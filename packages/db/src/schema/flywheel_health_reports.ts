import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const flywheelHealthReports = pgTable(
  "flywheel_health_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    windowHours: integer("window_hours").notNull().default(1),
    source: text("source").notNull().default("scheduler"),
    reportJson: jsonb("report_json").$type<Record<string, unknown>>().notNull(),
    tasksAttempted: integer("tasks_attempted").notNull().default(0),
    tasksCompleted: integer("tasks_completed").notNull().default(0),
    providerFailureCount: integer("provider_failure_count").notNull().default(0),
    ledgerCompletenessPercent: integer("ledger_completeness_percent").notNull().default(0),
    artifactCoveragePercent: integer("artifact_coverage_percent").notNull().default(0),
    receiptsProduced: integer("receipts_produced").notNull().default(0),
    testsPassed: integer("tests_passed").notNull().default(0),
    testsFailed: integer("tests_failed").notNull().default(0),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyWindowUq: uniqueIndex("flywheel_health_reports_company_window_uq").on(
      table.companyId,
      table.windowStart,
      table.windowEnd,
    ),
    companyGeneratedIdx: index("flywheel_health_reports_company_generated_idx").on(
      table.companyId,
      table.generatedAt,
    ),
  }),
);

import { z } from "zod";
import { DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE } from "../types/feedback.js";
import {
  DAILY_RETENTION_PRESETS,
  DEFAULT_BACKUP_RETENTION,
  MONTHLY_RETENTION_PRESETS,
  WEEKLY_RETENTION_PRESETS,
} from "../types/instance.js";
import { feedbackDataSharingPreferenceSchema } from "./feedback.js";

const dailyBackupRetentionSchema = z.union([
  z.literal(DAILY_RETENTION_PRESETS[0]),
  z.literal(DAILY_RETENTION_PRESETS[1]),
  z.literal(DAILY_RETENTION_PRESETS[2]),
]);

const weeklyBackupRetentionSchema = z.union([
  z.literal(WEEKLY_RETENTION_PRESETS[0]),
  z.literal(WEEKLY_RETENTION_PRESETS[1]),
  z.literal(WEEKLY_RETENTION_PRESETS[2]),
]);

const monthlyBackupRetentionSchema = z.union([
  z.literal(MONTHLY_RETENTION_PRESETS[0]),
  z.literal(MONTHLY_RETENTION_PRESETS[1]),
  z.literal(MONTHLY_RETENTION_PRESETS[2]),
]);

export const backupRetentionPolicySchema = z.object({
  dailyDays: dailyBackupRetentionSchema.default(DEFAULT_BACKUP_RETENTION.dailyDays),
  weeklyWeeks: weeklyBackupRetentionSchema.default(DEFAULT_BACKUP_RETENTION.weeklyWeeks),
  monthlyMonths: monthlyBackupRetentionSchema.default(DEFAULT_BACKUP_RETENTION.monthlyMonths),
}).strict();

export const instanceGeneralSettingsSchema = z.object({
  censorUsernameInLogs: z.boolean().default(false),
  keyboardShortcuts: z.boolean().default(false),
  feedbackDataSharingPreference: feedbackDataSharingPreferenceSchema.default(
    DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
  ),
  backupRetention: backupRetentionPolicySchema.default(DEFAULT_BACKUP_RETENTION),
}).strict();

export const patchInstanceGeneralSettingsSchema = instanceGeneralSettingsSchema.partial();

export const instanceExperimentalSettingsSchema = z.object({
  enableIsolatedWorkspaces: z.boolean().default(false),
  autoRestartDevServerWhenIdle: z.boolean().default(false),
}).strict();

export const patchInstanceExperimentalSettingsSchema = instanceExperimentalSettingsSchema.partial();

export type InstanceGeneralSettings = z.infer<typeof instanceGeneralSettingsSchema>;
export type PatchInstanceGeneralSettings = z.infer<typeof patchInstanceGeneralSettingsSchema>;
export type InstanceExperimentalSettings = z.infer<typeof instanceExperimentalSettingsSchema>;
export type PatchInstanceExperimentalSettings = z.infer<typeof patchInstanceExperimentalSettingsSchema>;

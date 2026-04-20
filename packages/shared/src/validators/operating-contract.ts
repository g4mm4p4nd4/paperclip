import { z } from "zod";

export const operatingContractActionGroupSchema = z.enum([
  "company_metadata",
  "goals",
  "project_goal_links",
  "issue_goal_backfills",
  "agents",
  "staffing_recommendations",
]);

export const updateOperatingContractConfigSchema = z.object({
  projectWorkspaceId: z.string().uuid().nullable(),
  packageRootPath: z.string().min(1).default("."),
});

export type UpdateOperatingContractConfigInput = z.infer<typeof updateOperatingContractConfigSchema>;

export const applyOperatingContractSchema = z.object({
  previewHash: z.string().min(1),
  selectedActionGroups: z.array(operatingContractActionGroupSchema).default([]),
});

export type ApplyOperatingContractInput = z.infer<typeof applyOperatingContractSchema>;

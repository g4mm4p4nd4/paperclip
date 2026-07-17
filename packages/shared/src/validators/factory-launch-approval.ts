import { z } from "zod";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const sha256MapSchema = z.record(z.string().min(1), sha256Schema).refine(
  (value) => Object.keys(value).length > 0,
  "at least one hash binding is required",
);

export const FACTORY_LAUNCH_APPROVAL_TYPES = [
  "profit_flywheel_shadow_launch",
  "profit_flywheel_production_launch",
] as const;

export const factoryLaunchApprovalPayloadSchema = z.object({
  schema_version: z.literal("paperclip.factory_launch_approval.v1"),
  company_id: z.string().uuid(),
  target_repo: z.string().regex(/^[^/]+\/[^/]+$/),
  // A root dispatch can be approved before Paperclip materializes its workflow
  // UUID. When present it is an additional exact binding; when absent the live
  // authority derives the workflow from company_id + run_id and proves that
  // its persisted source dispatch hash equals input_hash.
  workflow_id: z.string().uuid().optional(),
  run_id: z.string().min(1).max(512),
  input_hash: sha256Schema,
  contract_hashes: sha256MapSchema,
  vector_hashes: sha256MapSchema,
  provider_route_hashes: sha256MapSchema,
  credential_epoch_hashes: sha256MapSchema,
  pos_runtime: z.object({
    manifest_path: z.string().startsWith("/"),
    manifest_sha256: sha256Schema,
    source_commit: z.string().regex(/^[0-9a-f]{40}$/),
  }).strict(),
  adapter_bundle: z.object({
    manifest_sha256: sha256Schema,
    archive_sha256: sha256Schema,
    version: z.string().min(1).max(512),
    source_commit: z.string().regex(/^[0-9a-f]{40}$/),
  }).strict(),
  requested_mode: z.enum(["shadow", "production"]),
  expires_at: z.string().datetime({ offset: true }),
  excluded_target_checked: z.literal(true),
  fixture_bindings_absent: z.literal(true),
  shadow_closeout_receipt_sha256: sha256Schema.optional(),
  canary_receipt_sha256: sha256Schema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.requested_mode === "production") {
    for (const key of ["shadow_closeout_receipt_sha256", "canary_receipt_sha256"] as const) {
      if (!value[key]) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is required for production` });
      }
    }
  } else if (value.shadow_closeout_receipt_sha256 || value.canary_receipt_sha256) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["requested_mode"],
      message: "shadow approval cannot carry production closeout authority",
    });
  }
});

export type FactoryLaunchApprovalPayload = z.infer<typeof factoryLaunchApprovalPayloadSchema>;
export type FactoryLaunchApprovalType = (typeof FACTORY_LAUNCH_APPROVAL_TYPES)[number];

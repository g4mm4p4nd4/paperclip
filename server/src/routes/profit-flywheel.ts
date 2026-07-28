import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { profitFlywheelReceiptSchema } from "@paperclipai/shared";
import { z } from "zod";
import { forbidden, unauthorized } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { profitFlywheelService } from "../services/profit-flywheel.js";
import {
  softwareFactoryHealthService,
  type SoftwareFactoryHealthOptions,
} from "../services/software-factory-health.js";
import { createHealthGatedFactoryLaunchAuthority } from "../services/factory-health-launch-authority.js";
import type {
  FactoryLaunchAuthority,
  FactoryLaunchAuthorityInput,
} from "../services/factory-launch-authority.js";
import { createFactoryLaunchProposal } from "../services/factory-launch-proposals.js";
import { assertCompanyAccess, assertInstanceAdmin, getActorInfo } from "./authz.js";

export function profitFlywheelRoutes(db: Db, options: {
  factoryHealth?: SoftwareFactoryHealthOptions;
  factoryLaunchAuthority?: FactoryLaunchAuthority;
} = {}) {
  const router = Router();
  const factoryHealthOptions = options.factoryHealth ?? {
    mode: "fixture",
    pauseNewWork: true,
  };
  const factoryLaunchAuthority = options.factoryLaunchAuthority ??
    createHealthGatedFactoryLaunchAuthority(db, factoryHealthOptions);
  const svc = profitFlywheelService(db, {
    factoryMode: factoryHealthOptions.mode,
    factoryPauseNewWork: factoryHealthOptions.pauseNewWork,
    factoryLaunchAuthority,
  });
  const factoryHealth = softwareFactoryHealthService(db, factoryHealthOptions);
  const isFactoryPaused = () => typeof factoryHealthOptions.pauseNewWork === "function"
    ? factoryHealthOptions.pauseNewWork()
    : factoryHealthOptions.pauseNewWork;
  const emptySchema = z.object({}).strict();
  const claimSchema = z.object({ agentId: z.string().uuid().optional().nullable() }).strict();
  const completeSchema = z.object({
    outputHash: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
    feedback: z.record(z.unknown()).optional(),
  }).strict();
  const blockerSchema = z.object({
    blockerCode: z.string().trim().min(1).max(160),
    blockerDetail: z.string().trim().min(1).max(4000),
    nextOwner: z.string().trim().min(1).max(200),
    resumeCondition: z.string().trim().min(1).max(2000),
  }).strict();
  const failureSchema = z.object({
    failureClass: z.string().trim().min(1).max(160),
    detail: z.string().trim().min(1).max(4000),
    nextOwner: z.string().trim().min(1).max(200).optional(),
    resumeCondition: z.string().trim().min(1).max(2000).optional(),
  }).strict();
  const qaReworkSchema = z.object({
    qaFailureReceiptHash: z.string().regex(/^[a-f0-9]{64}$/i),
  }).strict();
  const paperclipResumeSchema = z.object({
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    expectedBlockerCode: z.string().trim().min(1).max(160),
    expectedReceiptId: z.string().uuid(),
    expectedReceiptHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict();
  const portfolioOsStageSchema = z.enum([
    "research_intake",
    "evidence_normalization",
    "commercial_validation",
    "council_decision",
    "dispatch",
    "commercial_observation",
    "learning",
  ]);
  const portfolioOsAckCommon = {
    schema_version: z.literal("paperclip.portfolio_os_stage_ack.v2"),
    event_id: z.string().uuid(),
    workflow_id: z.string().uuid(),
    stage_run_id: z.string().uuid(),
    stage: portfolioOsStageSchema,
    input_hash: z.string().regex(/^[a-f0-9]{64}$/),
    attempt: z.number().int().positive(),
    claim_nonce: z.string().uuid(),
  } as const;
  const portfolioOsClaimSchema = z.object({
    schema_version: z.literal("paperclip.portfolio_os_stage_claim.v2"),
    workflow_id: z.string().uuid(),
    stage_run_id: z.string().uuid(),
    stage: portfolioOsStageSchema,
    input_hash: z.string().regex(/^[a-f0-9]{64}$/),
    attempt: z.number().int().positive(),
  }).strict();
  const portfolioOsAckSchema = z.discriminatedUnion("state", [
    z.object({
      ...portfolioOsAckCommon,
      state: z.literal("succeeded"),
      output_hash: z.string().regex(/^[a-f0-9]{64}$/),
      receipts: z.array(profitFlywheelReceiptSchema).min(1).max(20),
      linked_issue_id: z.string().uuid().optional(),
    }).strict(),
    z.object({
      ...portfolioOsAckCommon,
      state: z.enum(["degraded", "blocked", "failed"]),
      blocker: z.object({
        blocker_code: z.string().trim().min(1).max(160),
        blocker_detail: z.string().trim().min(1).max(4000),
        next_owner: z.string().trim().min(1).max(200),
        resume_condition: z.string().trim().min(1).max(2000),
      }).strict(),
    }).strict(),
  ]).superRefine((value, ctx) => {
    if (value.state === "succeeded" && value.stage === "dispatch" && !value.linked_issue_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["linked_issue_id"], message: "Dispatch success requires its newly created Paperclip execution issue" });
    }
    if (value.state === "succeeded" && value.stage !== "dispatch" && value.linked_issue_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["linked_issue_id"], message: "Only dispatch success may introduce a new execution issue" });
    }
  });
  const portfolioOsResumeSchema = z.object({
    schema_version: z.literal("paperclip.portfolio_os_stage_resume.v2"),
    workflow_id: z.string().uuid(),
    stage_run_id: z.string().uuid(),
    input_hash: z.string().regex(/^[a-f0-9]{64}$/),
    expected_blocker_code: z.string().trim().min(1).max(160),
  }).strict();

  function publicPayload(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(publicPayload);
    if (!value || typeof value !== "object" || value instanceof Date) return value;
    const sanitized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (["claim_nonce", "execution_evidence_nonce", "server_observation_nonce"].includes(key)) continue;
      sanitized[key] = publicPayload(entry);
    }
    return sanitized;
  }

  function actorBinding(req: Request) {
    if (req.actor.type === "agent" && req.actor.agentId) return { type: "agent" as const, id: req.actor.agentId };
    if (req.actor.type === "board") return { type: "board" as const, id: String(req.actor.userId ?? req.actor.source ?? "board") };
    throw unauthorized();
  }

  function requireLeaseActor(req: Request, detail: NonNullable<Awaited<ReturnType<typeof svc.getStageRun>>>) {
    const actor = actorBinding(req);
    if (detail.stageRun.leaseActorType !== actor.type || detail.stageRun.leaseActorId !== actor.id || !detail.stageRun.leaseOwner) {
      throw forbidden("Profit Flywheel mutation requires the persisted lease actor");
    }
    return {
      actor,
      expectedLease: {
        leaseOwner: detail.stageRun.leaseOwner,
        actorType: actor.type,
        actorId: actor.id,
      },
    };
  }

  async function stageForRequest(req: Request) {
    const detail = await svc.getStageRun(req.params.stageRunId as string);
    if (!detail) return null;
    assertCompanyAccess(req, detail.workflow.companyId);
    return detail;
  }

  router.get("/companies/:companyId/profit-flywheel/workflows", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const limit = Number(req.query.limit ?? 100);
    res.json(publicPayload(await svc.listWorkflows(companyId, {
      state: typeof req.query.state === "string" ? req.query.state : undefined,
      correlationId: typeof req.query.correlation_id === "string" ? req.query.correlation_id : undefined,
      linkedIssueId: typeof req.query.linked_issue_id === "string" ? req.query.linked_issue_id : undefined,
      limit: Number.isFinite(limit) ? Math.min(Math.max(1, limit), 500) : 100,
    })));
  });

  router.get("/companies/:companyId/profit-flywheel/ops-receipt", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const since = typeof req.query.since === "string" ? new Date(req.query.since) : undefined;
    res.json(publicPayload(await svc.buildOpsReceipt(companyId, {
      since: since && !Number.isNaN(since.getTime()) ? since : undefined,
    })));
  });

  router.get("/companies/:companyId/profit-flywheel/factory-health", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.set("Cache-Control", "no-store");
    res.json(publicPayload(await factoryHealth.build(companyId)));
  });

  router.post("/companies/:companyId/profit-flywheel/factory-pause", validate(z.object({ confirm: z.literal(true) }).strict()), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertInstanceAdmin(req);
    if (!factoryHealthOptions.pause) {
      res.status(503).json({ error: "Factory pause persistence is unavailable in this process." });
      return;
    }
    await factoryHealthOptions.pause();
    res.set("Cache-Control", "no-store");
    res.json(publicPayload(await factoryHealth.build(companyId)));
  });

  router.post(
    "/companies/:companyId/profit-flywheel/factory-launch-proposals",
    validate(z.object({
      requestedMode: z.enum(["shadow", "production"]),
      targetRepo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
      runId: z.string().trim().min(1).max(512),
      inputHash: z.string().regex(/^[0-9a-f]{64}$/),
      workflowId: z.string().uuid().optional(),
      expiresInSeconds: z.number().int().min(60).max(3600).default(900),
    }).strict()),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertInstanceAdmin(req);
      if (!factoryHealthOptions.portfolioOsRuntimeRoot) {
        res.status(503).json({ error: "Managed POS runtime root is not configured." });
        return;
      }
      const actor = getActorInfo(req);
      const approval = await createFactoryLaunchProposal(db, {
        companyId,
        ...req.body,
        requestedByUserId: actor.actorId,
        portfolioOsRuntimeRoot: factoryHealthOptions.portfolioOsRuntimeRoot,
      });
      res.status(201).json(approval);
    },
  );

  router.get("/companies/:companyId/profit-flywheel/factory-workflows/:workflowId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const workflowId = req.params.workflowId as string;
    assertCompanyAccess(req, companyId);
    const detail = await factoryHealth.workflowDetail(companyId, workflowId);
    if (!detail) {
      res.status(404).json({ error: "Profit Flywheel workflow not found" });
      return;
    }
    res.set("Cache-Control", "no-store");
    res.json(detail);
  });

  router.get("/companies/:companyId/profit-flywheel/portfolio-os-outbox", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const limit = Number(req.query.limit ?? 100);
    const rawStages = typeof req.query.stages === "string"
      ? req.query.stages.split(",").map((value) => value.trim()).filter(Boolean)
      : [];
    const parsedStages = rawStages.length > 0 ? z.array(portfolioOsStageSchema).safeParse(rawStages) : null;
    if (parsedStages && !parsedStages.success) {
      res.status(400).json({ error: "stages must be a comma-separated set of Portfolio OS-owned Profit Flywheel stages" });
      return;
    }
    res.json(publicPayload(await svc.listPortfolioOsOutbox(companyId, {
      limit: Number.isFinite(limit) ? Math.min(Math.max(1, limit), 500) : 100,
      stages: parsedStages?.success ? parsedStages.data : undefined,
    })));
  });

  router.post("/companies/:companyId/profit-flywheel/portfolio-os-outbox/:eventId/ack", validate(portfolioOsAckSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const eventId = req.params.eventId as string;
    assertCompanyAccess(req, companyId);
    if (req.body.event_id !== eventId) throw forbidden("Outbox event path/body binding mismatch");
    const actor = actorBinding(req);
    if (actor.type !== "agent") throw forbidden("Portfolio OS outbox acknowledgement requires the dedicated Portfolio OS Orchestrator principal");
    res.json(publicPayload(await svc.acknowledgePortfolioOsOutbox({
      companyId,
      eventId,
      workflowId: req.body.workflow_id,
      stageRunId: req.body.stage_run_id,
      stage: req.body.stage,
      inputHash: req.body.input_hash,
      attempt: req.body.attempt,
      claimNonce: req.body.claim_nonce,
      state: req.body.state,
      outputHash: req.body.state === "succeeded" ? req.body.output_hash : undefined,
      receipts: req.body.state === "succeeded" ? req.body.receipts : undefined,
      linkedIssueId: req.body.state === "succeeded" ? req.body.linked_issue_id : undefined,
      blocker: req.body.state === "succeeded" ? undefined : {
        blockerCode: req.body.blocker.blocker_code,
        blockerDetail: req.body.blocker.blocker_detail,
        nextOwner: req.body.blocker.next_owner,
        resumeCondition: req.body.blocker.resume_condition,
      },
      principal: actor,
    })));
  });

  router.post("/companies/:companyId/profit-flywheel/portfolio-os-outbox/:eventId/claim", validate(portfolioOsClaimSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const eventId = req.params.eventId as string;
    assertCompanyAccess(req, companyId);
    const actor = actorBinding(req);
    if (actor.type !== "agent") throw forbidden("Portfolio OS outbox claim requires the workflow-pinned executor agent");
    if (!await svc.hasActiveManagedPosLauncherClaim({ companyId, eventId })) {
      throw forbidden("Portfolio OS outbox claim requires an active server-authorized managed consumer launch");
    }
    res.json(await svc.claimPortfolioOsOutbox({
      companyId,
      eventId,
      workflowId: req.body.workflow_id,
      stageRunId: req.body.stage_run_id,
      stage: req.body.stage,
      inputHash: req.body.input_hash,
      attempt: req.body.attempt,
      principal: actor,
    }));
  });

  router.post("/companies/:companyId/profit-flywheel/portfolio-os-outbox/:eventId/resume", validate(portfolioOsResumeSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const eventId = req.params.eventId as string;
    assertCompanyAccess(req, companyId);
    const actor = actorBinding(req);
    if (actor.type !== "agent") throw forbidden("Portfolio OS outbox resume requires the dedicated Portfolio OS Orchestrator principal");
    res.json(publicPayload(await svc.resumePortfolioOsOutbox({
      companyId,
      eventId,
      workflowId: req.body.workflow_id,
      stageRunId: req.body.stage_run_id,
      inputHash: req.body.input_hash,
      expectedBlockerCode: req.body.expected_blocker_code,
      principal: actor,
    })));
  });

  router.get("/profit-flywheel/workflows/:workflowId", async (req, res) => {
    const detail = await svc.getWorkflow(req.params.workflowId as string);
    if (!detail) {
      res.status(404).json({ error: "Profit Flywheel workflow not found" });
      return;
    }
    assertCompanyAccess(req, detail.workflow.companyId);
    res.json(publicPayload(detail));
  });

  router.post("/profit-flywheel/stages/:stageRunId/receipts", validate(profitFlywheelReceiptSchema), async (req, res) => {
    const detail = await stageForRequest(req);
    if (!detail) {
      res.status(404).json({ error: "Profit Flywheel stage not found" });
      return;
    }
    const lease = requireLeaseActor(req, detail);
    res.status(201).json(publicPayload(await svc.recordReceipt({
      stageRunId: detail.stageRun.id,
      receipt: req.body,
      leaseOwner: detail.stageRun.leaseOwner ?? undefined,
      leaseActor: lease.actor,
      requireActiveLease: true,
    })));
  });

  router.post("/profit-flywheel/stages/:stageRunId/claim", validate(claimSchema), async (req, res) => {
    const detail = await stageForRequest(req);
    if (!detail) {
      res.status(404).json({ error: "Profit Flywheel stage not found" });
      return;
    }
    const actor = actorBinding(req);
    const actorAgentId = actor.type === "agent" ? actor.id : null;
    if (actorAgentId && req.body.agentId && req.body.agentId !== actorAgentId) {
      throw forbidden("Agents may only claim a Profit Flywheel stage for themselves");
    }
    const admission = await factoryLaunchAuthority.claim({
      kind: "paperclip_stage_dispatch",
      mode: factoryHealthOptions.mode,
      pauseNewWork: isFactoryPaused(),
      providerCapabilityClass: detail.stageRun.providerCapabilityClass as
        FactoryLaunchAuthorityInput["providerCapabilityClass"],
      companyId: detail.workflow.companyId,
      targetRepo: detail.workflow.targetRepo,
      workflowId: detail.workflow.id,
      runId: detail.workflow.runId,
      inputHash: detail.stageRun.inputHash,
      stage: detail.stageRun.stage,
      transitionContext: detail.stageRun.feedback as Record<string, unknown>,
    });
    if (!admission.allowed) throw forbidden(`${admission.code}: ${admission.detail}`);
    res.json(publicPayload(await svc.claimStage({
      stageRunId: detail.stageRun.id,
      actorType: actor.type,
      actorId: actor.id,
      agentId: actorAgentId ?? req.body.agentId ?? null,
    })));
  });

  router.post("/profit-flywheel/stages/:stageRunId/resume", validate(paperclipResumeSchema), async (req, res) => {
    const detail = await stageForRequest(req);
    if (!detail) {
      res.status(404).json({ error: "Profit Flywheel stage not found" });
      return;
    }
    const actor = actorBinding(req);
    res.json(publicPayload(await svc.resumePaperclipStage({
      companyId: detail.workflow.companyId,
      stageRunId: detail.stageRun.id,
      inputHash: req.body.inputHash,
      expectedBlockerCode: req.body.expectedBlockerCode,
      expectedReceiptId: req.body.expectedReceiptId,
      expectedReceiptHash: req.body.expectedReceiptHash,
      principal: actor,
    })));
  });

  router.post("/profit-flywheel/stages/:stageRunId/heartbeat", validate(emptySchema), async (req, res) => {
    const detail = await stageForRequest(req);
    if (!detail) {
      res.status(404).json({ error: "Profit Flywheel stage not found" });
      return;
    }
    requireLeaseActor(req, detail);
    res.json(publicPayload(await svc.heartbeatStage({ stageRunId: detail.stageRun.id, leaseOwner: detail.stageRun.leaseOwner! })));
  });

  router.post("/profit-flywheel/stages/:stageRunId/complete", validate(completeSchema), async (req, res) => {
    const detail = await stageForRequest(req);
    if (!detail) {
      res.status(404).json({ error: "Profit Flywheel stage not found" });
      return;
    }
    const lease = requireLeaseActor(req, detail);
    res.json(publicPayload(await svc.completeStage({
      stageRunId: detail.stageRun.id,
      expectedLease: lease.expectedLease,
      outputHash: req.body.outputHash,
      feedback: req.body.feedback,
    })));
  });

  router.post("/profit-flywheel/stages/:stageRunId/block", validate(blockerSchema), async (req, res) => {
    const detail = await stageForRequest(req);
    if (!detail) {
      res.status(404).json({ error: "Profit Flywheel stage not found" });
      return;
    }
    const lease = requireLeaseActor(req, detail);
    res.json(publicPayload(await svc.blockStage({ stageRunId: detail.stageRun.id, blocker: req.body, expectedLease: lease.expectedLease })));
  });

  router.post("/profit-flywheel/stages/:stageRunId/fail", validate(failureSchema), async (req, res) => {
    const detail = await stageForRequest(req);
    if (!detail) {
      res.status(404).json({ error: "Profit Flywheel stage not found" });
      return;
    }
    const lease = requireLeaseActor(req, detail);
    res.json(publicPayload(await svc.failStage({
      stageRunId: detail.stageRun.id,
      failureClass: String(req.body.failureClass ?? "non_retryable"),
      detail: String(req.body.detail ?? "Stage failed without detail"),
      nextOwner: req.body.nextOwner,
      resumeCondition: req.body.resumeCondition,
      expectedLease: lease.expectedLease,
    })));
  });

  router.post("/profit-flywheel/stages/:stageRunId/rework", validate(qaReworkSchema), async (req, res) => {
    const detail = await stageForRequest(req);
    if (!detail) {
      res.status(404).json({ error: "Profit Flywheel stage not found" });
      return;
    }
    const lease = requireLeaseActor(req, detail);
    res.json(publicPayload(await svc.reworkQaFailure({
      stageRunId: detail.stageRun.id,
      qaFailureReceiptHash: req.body.qaFailureReceiptHash,
      expectedLease: lease.expectedLease,
    })));
  });

  return router;
}

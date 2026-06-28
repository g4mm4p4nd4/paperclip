import { describe, expect, it } from "vitest";
import {
  buildBlockerApprovalPayload,
  buildCompanyVisionContract,
  classifyBlockerRouting,
  evaluateGoLiveDelta,
  extractGoLiveDelta,
} from "../services/company-vision-contract.js";

describe("company vision contract", () => {
  it("builds a company go-live contract from goals, projects, and agents", () => {
    const contract = buildCompanyVisionContract({
      company: {
        id: "company-1",
        name: "Portfolio OS",
        description: "Ship a profitable software factory.",
        issuePrefix: "POS",
      },
      goals: [{ id: "goal-1", title: "Reach production go-live", status: "active", level: "company" }],
      projects: [{ id: "project-1", name: "Launch readiness", status: "planned" }],
      agents: [
        { id: "agent-ceo", name: "CEO", role: "ceo" },
        { id: "agent-growth", name: "Growth and Distribution", role: "general" },
      ],
    });

    expect(contract).toMatchObject({
      companyId: "company-1",
      companyName: "Portfolio OS",
      issuePrefix: "POS",
      goLiveDefinition: "Reach production go-live",
    });
    expect(contract.milestones.map((milestone) => milestone.title)).toContain("Launch readiness");
    expect(contract.roleMissions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agentName: "Growth and Distribution",
        mission: expect.stringContaining("distribution"),
      }),
    ]));
  });

  it("extracts and evaluates artifact-backed go-live progress", () => {
    const delta = extractGoLiveDelta({
      resultJson: {
        goLiveDelta: {
          classification: "artifact_delivery",
          companyMilestone: "launch readiness",
          artifactRefs: [{ path: "docs/release-checklist.md" }],
          receiptPaths: ["receipts/release-checklist.json"],
        },
      },
      finalDisposition: { classification: "advanced_vision" },
    });

    expect(delta).toMatchObject({
      classification: "artifact_delivery",
      milestone: "launch readiness",
      source: "explicit_result_json",
    });
    expect(evaluateGoLiveDelta({
      delta,
      issueId: "issue-1",
      artifactRefs: [{ path: "docs/release-checklist.md" }],
      outcome: "succeeded",
    })).toMatchObject({
      status: "valuable",
      countsAsFinalDeliverable: true,
    });
  });

  it("infers valuable blocker progress when a blocked disposition names an owner", () => {
    const delta = extractGoLiveDelta({
      finalDisposition: {
        classification: "blocked",
        nextActionOwner: "board",
      },
    });

    expect(delta).toMatchObject({
      classification: "truthful_blocker",
      blockerOwner: "board",
      source: "inferred_from_disposition",
    });
    expect(evaluateGoLiveDelta({ delta, outcome: "failed" })).toMatchObject({
      status: "valuable",
      reason: "blocker_has_owner",
      countsAsFinalDeliverable: false,
    });
  });

  it("routes credential and duplicate loop blockers to board approval payloads", () => {
    const credentialRouting = classifyBlockerRouting({
      blockerClass: "credential",
      requiredSecretNames: ["GEMINI_API_KEY"],
    });
    const duplicateRouting = classifyBlockerRouting({
      blockerClass: "duplicate_loop",
      text: "suppressed frozen duplicate issue loop",
    });

    expect(credentialRouting).toMatchObject({
      owner: "board",
      route: "request_board_approval",
      approvalRequired: true,
    });
    expect(duplicateRouting).toMatchObject({
      owner: "board",
      route: "refactor_decision",
      approvalRequired: true,
    });
    expect(buildBlockerApprovalPayload({
      title: "Credential blocker",
      companyName: "Portfolio OS",
      blockerFingerprint: "credential:GEMINI_API_KEY",
      routing: credentialRouting,
    })).toMatchObject({
      kind: "factory_blocker_routing",
      blockerFingerprint: "credential:GEMINI_API_KEY",
      routing: credentialRouting,
    });
  });
});

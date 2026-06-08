import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import {
  executeHermes,
  ingestMandate,
  planHermes,
  registerPortfolioOsCommands,
  statusForRun,
} from "../commands/portfolio-os.js";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-portfolio-os-"));
}

function writeJson(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function mandate(portfolioRoot: string): Record<string, unknown> {
  return {
    schema_version: "pos.execution_mandate.v1",
    run: {
      run_id: "fixture-validation-sprint",
      generated_at: "2026-06-01T00:00:00+00:00",
      portfolio_os_commit: "fixture",
      snapshot_hash: "fixture-snapshot",
      execution_mandate_hash: "fixture-mandate",
      frozen_selection_path: path.join(portfolioRoot, "data", "frozen_selection.json"),
    },
    target: {
      repo_full_name: "owner/fixture-target",
      local_repo_path: path.join(portfolioRoot, "..", "fixture-target"),
      default_branch: "main",
      working_branch: "run/fixture-validation-sprint/portfolio-os-flywheel",
    },
    mandate: {
      mandate_type: "validation_sprint",
      evidence_gate_status: "blocked",
      commercialization_confidence: 52,
      research_confidence: 64,
      launch_gates_clear: false,
      blockers: ["Launch gates are not fully clear; converting launch work into a validation sprint."],
    },
    opportunity: {
      niche: "marketing teams in marketing",
      persona: "marketing teams",
      industry: "marketing",
      region: "us",
      strongest_wedge: "analytics dashboards for marketing teams",
      paired_repos: [],
      missing_evidence: ["Need 3 buyer quotes."],
      internet_pipes: {
        score: 64.5,
        readiness: "promising",
        missing_stations: ["evaluation", "visualization"],
        recommendations: ["Add competitive and market mechanics evidence."],
      },
      evidence_summary: "Fixture evidence summary.",
      reasoning_summary: "Fixture reasoning summary.",
    },
    policy: {
      portfolio_os_mutates_target_repo_directly: false,
      target_repo_mutation_via: "Paperclip/Hermes-Agent when execution policy allows",
      write_policy: {
        direct_main_allowed: false,
        branch_then_pr: true,
        local_only: false,
      },
      push_policy: {
        push_to_origin: false,
        create_pr: false,
        no_push: true,
      },
    },
    frozen_bundle: {},
  };
}

function fakeHermes(portfolioRoot: string): string {
  const hermesPath = path.join(portfolioRoot, "fake-hermes");
  fs.writeFileSync(
    hermesPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const bundlePath = process.argv[process.argv.indexOf("--bundle") + 1];
const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
const out = bundle.outputs.result_path;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({
  run_id: bundle.run.run_id,
  status: "completed",
  target_repo: bundle.target.repo_full_name,
  files_changed: ["docs/business_plan.md"],
  tasks_completed: bundle.tasks.map((task) => task.id),
  qa_status: "not_run",
  blockers: [],
  next_actions: []
}, null, 2) + "\\n");
console.log("fake hermes dispatched " + bundle.run.run_id);
`,
    "utf8",
  );
  fs.chmodSync(hermesPath, 0o755);
  return hermesPath;
}

describe("Portfolio-OS Paperclip CLI bridge", () => {
  it("registers the portfolio-os command", () => {
    const program = new Command();

    expect(() => registerPortfolioOsCommands(program)).not.toThrow();

    const command = program.commands.find((item) => item.name() === "portfolio-os");
    expect(command?.commands.map((item) => item.name()).sort()).toEqual([
      "execute",
      "ingest",
      "plan-hermes",
      "status",
    ]);
  });

  it("ingests mandates and creates deterministic Paperclip context", () => {
    const portfolioRoot = tempRoot();
    const mandatePath = path.join(portfolioRoot, "data", "execution_mandate.json");
    writeJson(mandatePath, mandate(portfolioRoot));

    const context = ingestMandate({ mandatePath, portfolioRoot, companyName: "Portfolio Ventures Lab" });

    expect(context.schema_version).toBe("paperclip.portfolio_os_context.v1");
    expect(context.run_id).toBe("fixture-validation-sprint");
    expect(context.paperclip_execution_id).toMatch(/^pc-exec-/);
    expect(JSON.stringify(context)).toContain("Hermes Execution Adapter");
    expect(context.opportunity).toMatchObject({
      internet_pipes: {
        score: 64.5,
        readiness: "promising",
        missing_stations: ["evaluation", "visualization"],
        recommendations: ["Add competitive and market mechanics evidence."],
      },
    });
    expect(fs.existsSync(path.join(portfolioRoot, "data", "paperclip_context", "fixture-validation-sprint.json"))).toBe(true);
    expect(fs.existsSync(path.join(portfolioRoot, "data", "paperclip_context", "latest.json"))).toBe(true);
  });

  it("plans a valid Hermes task bundle and dispatches through Hermes", () => {
    const portfolioRoot = tempRoot();
    const mandatePath = path.join(portfolioRoot, "data", "execution_mandate.json");
    writeJson(mandatePath, mandate(portfolioRoot));
    ingestMandate({ mandatePath, portfolioRoot });

    const bundle = planHermes({ runId: "fixture-validation-sprint", mandatePath, portfolioRoot });

    expect(bundle.schema_version).toBe("pos.hermes_task_bundle.v1");
    expect(bundle.run).toMatchObject({
      run_id: "fixture-validation-sprint",
      paperclip_execution_id: expect.stringMatching(/^pc-exec-/),
    });
    expect(JSON.stringify(bundle)).toContain("validation_sprint");
    expect(bundle.opportunity).toMatchObject({
      internet_pipes: {
        score: 64.5,
        readiness: "promising",
        missing_stations: ["evaluation", "visualization"],
        recommendations: ["Add competitive and market mechanics evidence."],
      },
    });
    expect(bundle.evidence).toMatchObject({
      internet_pipes: {
        score: 64.5,
        readiness: "promising",
        missing_stations: ["evaluation", "visualization"],
        recommendations: ["Add competitive and market mechanics evidence."],
      },
    });
    expect(JSON.stringify(bundle.tasks)).toContain("Internet Pipes completeness: score=64.50");
    expect(JSON.stringify(bundle)).not.toContain("delete_repo now");
    expect(fs.existsSync(path.join(portfolioRoot, "data", "hermes_task_bundles", "fixture-validation-sprint.json"))).toBe(true);
    expect(fs.existsSync(path.join(portfolioRoot, "data", "hermes_task_bundle.seed.json"))).toBe(true);

    const execution = executeHermes({
      runId: "fixture-validation-sprint",
      portfolioRoot,
      hermesBin: fakeHermes(portfolioRoot),
    });

    expect(execution.status).toBe("completed");
    expect(fs.existsSync(path.join(portfolioRoot, "data", "hermes_results", "fixture-validation-sprint.json"))).toBe(true);
    expect(fs.existsSync(path.join(portfolioRoot, "data", "execution_results", "fixture-validation-sprint.paperclip.json"))).toBe(true);

    const status = statusForRun({ runId: "fixture-validation-sprint", portfolioRoot });
    expect(status.status).toBe("completed");
    expect(status.hermes).toMatchObject({ bundle_exists: true, result_exists: true, result_status: "completed" });
    expect(status.next_action).toContain("ingest-hermes-results");
  });
});

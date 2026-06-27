import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  classifyAgentProblems,
  resolveOutputPath,
  scoreAgentCandidate,
  selectDeepDiveAgents,
  timestampForPath,
  type AgentCandidate,
} from "../ops/agent-mission-performance-trace.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function candidate(overrides: Partial<AgentCandidate>): AgentCandidate {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    company_id: "company",
    company_name: "Company",
    issue_prefix: "PAP",
    name: "Agent",
    role: "pm",
    title: null,
    status: "idle",
    adapter_type: "hermes_local",
    last_heartbeat_at: null,
    desired_skill_count: 3,
    recent_runs: 0,
    failed_runs: 0,
    process_lost_runs: 0,
    adapter_failed_runs: 0,
    succeeded_runs: 0,
    open_assigned_issues: 0,
    blocked_assigned_issues: 0,
    stale_in_progress_issues: 0,
    completed_issues: 0,
    ledger_entries: 0,
    explicit_dispositions: 0,
    default_success_dispositions: 0,
    blocked_dispositions: 0,
    verbose_unjustified: 0,
    compact_success: 0,
    missing_skill_budget_runs: 0,
    raw_tokens: 0,
    cost_cents: 0,
    last_run_at: null,
    latest_failure: null,
    ...overrides,
  };
}

describe("agent mission performance trace", () => {
  it("prioritizes Hermes unsupported flag failures above normal activity", () => {
    const broken = candidate({
      id: "broken",
      name: "Broken Hermes",
      status: "error",
      failed_runs: 3,
      adapter_failed_runs: 3,
      latest_failure: "hermes: error: unrecognized arguments: --max-turns 12 --session-id paperclip_run",
    });
    const busy = candidate({
      id: "busy",
      name: "Busy Agent",
      recent_runs: 30,
      default_success_dispositions: 30,
      ledger_entries: 30,
      raw_tokens: 2_000_000,
    });

    expect(scoreAgentCandidate(broken).score).toBeGreaterThan(scoreAgentCandidate(busy).score);
    expect(classifyAgentProblems(broken)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "hermes_cli_flag_incompatibility",
        severity: "critical",
        fixable: true,
      }),
    ]));
  });

  it("keeps at least the requested sample while preserving role coverage", () => {
    const candidates = [
      candidate({ id: "ceo", name: "CEO", role: "ceo", recent_runs: 1 }),
      candidate({ id: "cto", name: "CTO", role: "cto", recent_runs: 1 }),
      candidate({ id: "pm", name: "PM", role: "pm", stale_in_progress_issues: 1 }),
      candidate({ id: "cmo", name: "CMO", role: "cmo", recent_runs: 12, completed_issues: 0 }),
      candidate({ id: "qa", name: "QA", role: "qa", open_assigned_issues: 1 }),
      candidate({ id: "engineer", name: "Engineer", role: "engineer", open_assigned_issues: 1 }),
      candidate({ id: "researcher", name: "Researcher", role: "researcher", recent_runs: 1 }),
    ];

    const selected = selectDeepDiveAgents(candidates, 6);

    expect(selected.length).toBeGreaterThanOrEqual(6);
    expect(selected.map((entry) => entry.candidate.role)).toEqual(expect.arrayContaining([
      "ceo",
      "cto",
      "cmo",
      "engineer",
      "pm",
      "qa",
      "researcher",
    ]));
  });

  it("guarantees high-token no-closure agents are sampled even when role coverage would miss them", () => {
    const candidates = [
      candidate({ id: "ceo", name: "CEO", role: "ceo", recent_runs: 1 }),
      candidate({ id: "cto", name: "CTO", role: "cto", recent_runs: 1 }),
      candidate({ id: "pm", name: "PM", role: "pm", stale_in_progress_issues: 1 }),
      candidate({ id: "cmo", name: "CMO", role: "cmo", recent_runs: 1 }),
      candidate({ id: "qa", name: "QA", role: "qa", open_assigned_issues: 1 }),
      candidate({ id: "engineer", name: "Engineer", role: "engineer", open_assigned_issues: 1 }),
      candidate({ id: "researcher", name: "Researcher", role: "researcher", recent_runs: 1 }),
      candidate({
        id: "expensive-custodian",
        name: "Evidence Custodian",
        role: "operations",
        recent_runs: 1,
        raw_tokens: 800_000,
        completed_issues: 0,
      }),
    ];

    const selected = selectDeepDiveAgents(candidates, 6);

    expect(selected.map((entry) => entry.candidate.id)).toContain("expensive-custodian");
    expect(scoreAgentCandidate(candidates[7]).reasons).toContain("high_tokens_without_closure");
    expect(classifyAgentProblems(candidates[7])).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "high_tokens_without_closure",
        severity: "warning",
      }),
    ]));
  });

  it("flags weak success, verbose output, and wake churn separately", () => {
    const traced = candidate({
      recent_runs: 20,
      succeeded_runs: 20,
      completed_issues: 0,
      ledger_entries: 20,
      default_success_dispositions: 18,
      verbose_unjustified: 10,
      missing_skill_budget_runs: 2,
    });

    expect(classifyAgentProblems(traced).map((problem) => problem.code)).toEqual(expect.arrayContaining([
      "wake_churn_without_closure",
      "weak_success_disposition",
      "output_contract_drift",
      "skill_budget_missing",
    ]));
  });

  it("uses millisecond receipt timestamps and repo-root-relative report paths", () => {
    expect(timestampForPath(new Date("2026-06-27T18:17:48.838Z"))).toBe("20260627T181748838Z");
    expect(resolveOutputPath("docs/reports/example.md")).toBe(path.join(repoRoot, "docs/reports/example.md"));
  });
});

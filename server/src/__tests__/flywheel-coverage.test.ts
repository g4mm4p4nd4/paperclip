import { describe, expect, it } from "vitest";
import {
  assertRoutineCoverage,
  loadFlywheelCoverageManifest,
  parseFlywheelCoverageManifest,
} from "../services/flywheel-coverage.js";

const seededRoutineKeys = [
  "dispatch-poller",
  "run-qa-sweep",
  "evidence-backfill-reconciler",
  "release-gate-reconciler",
];

describe("flywheel coverage manifest", () => {
  it("covers every seeded Portfolio OS routine with receipts and pass/fail rules", () => {
    const manifest = loadFlywheelCoverageManifest();

    const coverage = assertRoutineCoverage(seededRoutineKeys, manifest);

    expect(coverage.map((entry) => entry.routine_key)).toEqual(seededRoutineKeys);
    expect(coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({
        routine_key: "run-qa-sweep",
        stage: "qa",
        owner_plane: "paperclip_process_adapter",
        required_receipts: expect.arrayContaining(["qa_report.md", "screenshots", "regression_notes.md"]),
      }),
      expect.objectContaining({
        routine_key: "release-gate-reconciler",
        stage: "release",
        required_receipts: expect.arrayContaining(["release gate report", "branch telemetry"]),
      }),
    ]));
  });

  it("fails closed when a seeded routine lacks coverage", () => {
    const manifest = parseFlywheelCoverageManifest({
      schema_version: "paperclip.flywheel_coverage.v1",
      stages: [
        { stage: "dispatch" },
      ],
      routine_coverage: [
        {
          routine_key: "dispatch-poller",
          stage: "dispatch",
          owner_plane: "paperclip_process_adapter",
          provider_policy: "deterministic_only",
          required_receipts: ["PAPERCLIP_ADAPTER_RESULT_JSON"],
          pass_fail_rule: "must emit dispatch parity",
        },
      ],
    });

    expect(() => assertRoutineCoverage(["dispatch-poller", "run-qa-sweep"], manifest))
      .toThrow("flywheel coverage manifest missing routine coverage for: run-qa-sweep");
  });

  it("rejects coverage entries without required receipts", () => {
    const manifest = parseFlywheelCoverageManifest({
      schema_version: "paperclip.flywheel_coverage.v1",
      stages: [
        { stage: "qa" },
      ],
      routine_coverage: [
        {
          routine_key: "run-qa-sweep",
          stage: "qa",
          owner_plane: "paperclip_process_adapter",
          provider_policy: "deterministic_only",
          required_receipts: [],
          pass_fail_rule: "must write QA receipts",
        },
      ],
    });

    expect(() => assertRoutineCoverage(["run-qa-sweep"], manifest))
      .toThrow("flywheel coverage manifest routine run-qa-sweep missing required_receipts");
  });
});

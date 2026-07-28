import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadManagedProfitFlywheelAuthority: vi.fn(),
}));

vi.mock("../services/managed-profit-flywheel-authority.js", () => ({
  loadManagedProfitFlywheelAuthority: mocks.loadManagedProfitFlywheelAuthority,
}));

import {
  createFactoryLaunchProposal,
  verifyFactoryLaunchProposalBindings,
} from "../services/factory-launch-proposals.js";

describe("factory launch provider-policy authority binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadManagedProfitFlywheelAuthority.mockRejectedValue(new Error(
      "Provider policy authority descriptor does not equal the active Paperclip policy path/schema pins",
    ));
  });

  it("rejects proposal creation when a structurally valid resolved descriptor is stale", async () => {
    await expect(createFactoryLaunchProposal({} as never, {
      companyId: "company-1",
      requestedMode: "shadow",
      targetRepo: "owner/isolated-shadow",
      runId: "shadow-run-1",
      inputHash: "b".repeat(64),
      expiresInSeconds: 900,
      requestedByUserId: "operator-1",
      portfolioOsRuntimeRoot: "/managed/portfolio-os",
    })).rejects.toThrow("Provider policy authority descriptor does not equal the active Paperclip policy path/schema pins");

    expect(mocks.loadManagedProfitFlywheelAuthority).toHaveBeenCalledWith({
      runtimeRoot: "/managed/portfolio-os",
    });
  });

  it("rejects approval verification when the currently resolved descriptor is stale", async () => {
    await expect(verifyFactoryLaunchProposalBindings(
      {} as never,
      {} as never,
      "/managed/portfolio-os",
    )).rejects.toThrow("Provider policy authority descriptor does not equal the active Paperclip policy path/schema pins");

    expect(mocks.loadManagedProfitFlywheelAuthority).toHaveBeenCalledWith({
      runtimeRoot: "/managed/portfolio-os",
    });
  });
});

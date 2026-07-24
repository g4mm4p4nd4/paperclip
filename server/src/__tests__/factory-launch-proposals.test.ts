import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveManagedPortfolioOsRuntime: vi.fn(),
  verifyProviderPolicyAuthority: vi.fn(),
}));

vi.mock("../services/managed-pos-runtime.js", () => ({
  resolveManagedPortfolioOsRuntime: mocks.resolveManagedPortfolioOsRuntime,
}));

vi.mock("../services/provider-policy-authority.js", () => ({
  ProviderPolicyAuthorityError: class ProviderPolicyAuthorityError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  },
  verifyProviderPolicyAuthority: mocks.verifyProviderPolicyAuthority,
}));

import {
  createFactoryLaunchProposal,
  verifyFactoryLaunchProposalBindings,
} from "../services/factory-launch-proposals.js";

describe("factory launch provider-policy authority binding", () => {
  const descriptor = {
    path: "/managed/paperclip-runtime/authorities/provider-policy/structurally-valid-stale.json",
    sha256: "a".repeat(64),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveManagedPortfolioOsRuntime.mockResolvedValue({
      providerPolicyAuthority: descriptor,
      current: {},
    });
    mocks.verifyProviderPolicyAuthority.mockRejectedValue(new Error(
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

    expect(mocks.resolveManagedPortfolioOsRuntime).toHaveBeenCalledWith({ runtimeRoot: "/managed/portfolio-os" });
    expect(mocks.verifyProviderPolicyAuthority).toHaveBeenCalledWith({
      authorityPath: descriptor.path,
      expectedBinding: descriptor,
    });
  });

  it("rejects approval verification when the currently resolved descriptor is stale", async () => {
    await expect(verifyFactoryLaunchProposalBindings(
      {} as never,
      {} as never,
      "/managed/portfolio-os",
    )).rejects.toThrow("Provider policy authority descriptor does not equal the active Paperclip policy path/schema pins");

    expect(mocks.resolveManagedPortfolioOsRuntime).toHaveBeenCalledWith({ runtimeRoot: "/managed/portfolio-os" });
    expect(mocks.verifyProviderPolicyAuthority).toHaveBeenCalledWith({
      authorityPath: descriptor.path,
      expectedBinding: descriptor,
    });
  });
});

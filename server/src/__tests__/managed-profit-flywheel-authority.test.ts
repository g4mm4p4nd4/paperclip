import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PINNED_PROFIT_FLYWHEEL_CONTRACT_SHA256 } from "../services/profit-flywheel-contract.js";
import { loadManagedProfitFlywheelAuthority } from "../services/managed-profit-flywheel-authority.js";

describe("managed Profit Flywheel authority", () => {
  const runtimeRoot = "/managed/portfolio-os";
  const packageRoot = "/managed/portfolio-os/packages/closure";
  const authority = {
    path: "/managed/paperclip/authorities/provider-policy/current.json",
    sha256: "a".repeat(64),
  };

  it("loads the contract from the verified current POS package", async () => {
    const managedRuntimeResolver = vi.fn().mockResolvedValue({
      migrationOnly: false,
      providerPolicyAuthority: authority,
      current: { package_root: packageRoot },
    });
    const providerPolicyAuthorityVerifier = vi.fn().mockResolvedValue({
      binding: authority,
      providerPolicy: { policy: {} },
    });
    const expectedPath = path.join(packageRoot, "contracts", "profit-flywheel.v2.json");
    const contractLoader = vi.fn().mockImplementation(async ({ path: contractPath }) => ({
      path: contractPath,
      sha256: PINNED_PROFIT_FLYWHEEL_CONTRACT_SHA256,
    }));

    await expect(loadManagedProfitFlywheelAuthority({
      runtimeRoot,
      managedRuntimeResolver,
      providerPolicyAuthorityVerifier,
      contractLoader,
    })).resolves.toMatchObject({
      runtime: { current: { package_root: packageRoot } },
      contract: {
        path: expectedPath,
        sha256: PINNED_PROFIT_FLYWHEEL_CONTRACT_SHA256,
      },
      providerPolicyAuthority: { binding: authority },
    });
    expect(managedRuntimeResolver).toHaveBeenCalledWith({ runtimeRoot });
    expect(providerPolicyAuthorityVerifier).toHaveBeenCalledWith({
      authorityPath: authority.path,
      expectedBinding: authority,
    });
    expect(contractLoader).toHaveBeenCalledWith({ path: expectedPath });
  });

  it("rejects a contract loader that escapes the selected package", async () => {
    await expect(loadManagedProfitFlywheelAuthority({
      runtimeRoot,
      managedRuntimeResolver: async () => ({
        migrationOnly: false,
        providerPolicyAuthority: authority,
        current: { package_root: packageRoot },
      }) as never,
      providerPolicyAuthorityVerifier: async () => ({ binding: authority }) as never,
      contractLoader: async () => ({
        path: "/developer/checkout/contracts/profit-flywheel.v2.json",
        sha256: PINNED_PROFIT_FLYWHEEL_CONTRACT_SHA256,
      }) as never,
    })).rejects.toThrow("managed_pos_runtime_profit_flywheel_contract_mismatch");
  });

  it("rejects migration-only POS closures before contract loading", async () => {
    const contractLoader = vi.fn();
    await expect(loadManagedProfitFlywheelAuthority({
      runtimeRoot,
      managedRuntimeResolver: async () => ({
        migrationOnly: true,
        providerPolicyAuthority: authority,
        current: { package_root: packageRoot },
      }) as never,
      contractLoader,
    })).rejects.toThrow("managed_pos_runtime_migration_only");
    expect(contractLoader).not.toHaveBeenCalled();
  });
});

import path from "node:path";
import { resolveManagedPortfolioOsRuntime } from "./managed-pos-runtime.js";
import {
  loadProfitFlywheelContract,
  PINNED_PROFIT_FLYWHEEL_CONTRACT_SHA256,
} from "./profit-flywheel-contract.js";
import {
  ProviderPolicyAuthorityError,
  verifyProviderPolicyAuthority,
} from "./provider-policy-authority.js";

export interface ManagedProfitFlywheelAuthorityOptions {
  runtimeRoot: string;
  managedRuntimeResolver?: typeof resolveManagedPortfolioOsRuntime;
  contractLoader?: typeof loadProfitFlywheelContract;
  providerPolicyAuthorityVerifier?: typeof verifyProviderPolicyAuthority;
}

/**
 * Resolve one live POS closure and verify that its contract and provider
 * policy authority belong to the same currently active immutable runtime.
 */
export async function loadManagedProfitFlywheelAuthority(
  options: ManagedProfitFlywheelAuthorityOptions,
) {
  const runtime = await (options.managedRuntimeResolver ?? resolveManagedPortfolioOsRuntime)({
    runtimeRoot: options.runtimeRoot,
  });
  if (runtime.migrationOnly) {
    throw new Error("managed_pos_runtime_migration_only");
  }
  const authority = runtime.providerPolicyAuthority;
  if (!authority) {
    throw new ProviderPolicyAuthorityError(
      "profit_flywheel_provider_policy_binding_missing",
      "Managed POS runtime is missing its provider policy authority binding",
    );
  }
  const verifiedAuthority = await (
    options.providerPolicyAuthorityVerifier ?? verifyProviderPolicyAuthority
  )({
    authorityPath: authority.path,
    expectedBinding: authority,
  });
  if (
    verifiedAuthority.binding.path !== authority.path ||
    verifiedAuthority.binding.sha256 !== authority.sha256
  ) {
    throw new ProviderPolicyAuthorityError(
      "profit_flywheel_provider_policy_binding_mismatch",
      "Resolved provider policy authority differs from the managed POS runtime binding",
    );
  }
  const contractPath = path.join(
    runtime.current.package_root,
    "contracts",
    "profit-flywheel.v2.json",
  );
  const contract = await (options.contractLoader ?? loadProfitFlywheelContract)({
    path: contractPath,
  });
  if (
    contract.path !== contractPath ||
    contract.sha256 !== PINNED_PROFIT_FLYWHEEL_CONTRACT_SHA256
  ) {
    throw new Error("managed_pos_runtime_profit_flywheel_contract_mismatch");
  }
  return {
    runtime,
    contract,
    providerPolicyAuthority: verifiedAuthority,
  };
}

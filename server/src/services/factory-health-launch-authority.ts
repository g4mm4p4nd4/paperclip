import type { Db } from "@paperclipai/db";
import path from "node:path";
import type { FactoryMode } from "../config.js";
import {
  defaultDenyFactoryLaunchAuthority,
  fixtureFactoryLaunchAuthority,
  isFactoryFixtureTarget,
  type FactoryLaunchAuthority,
  type FactoryLaunchAuthorityDecision,
  type FactoryLaunchAuthorityInput,
} from "./factory-launch-authority.js";
import {
  softwareFactoryHealthService,
  type SoftwareFactoryHealthOptions,
} from "./software-factory-health.js";
import { resolveManagedPortfolioOsRuntime } from "./managed-pos-runtime.js";
import {
  loadProfitFlywheelContract,
  PINNED_PROFIT_FLYWHEEL_CONTRACT_SHA256,
} from "./profit-flywheel-contract.js";
import { verifyProviderPolicyAuthority } from "./provider-policy-authority.js";

const MINIMUM_FACTORY_DISK_BYTES = 30 * 1024 ** 3;

function denied(
  code: string,
  detail: string,
  terminal = false,
): FactoryLaunchAuthorityDecision {
  return { allowed: false, code, detail, terminal };
}

async function verifyCurrentManagedRuntimeAuthority(options: HealthGatedFactoryLaunchAuthorityOptions) {
  if (!options.portfolioOsRuntimeRoot) {
    throw new Error("managed_pos_runtime_provider_policy_authority_missing");
  }
  const runtime = await (options.managedPortfolioOsRuntimeResolver ?? resolveManagedPortfolioOsRuntime)({
    runtimeRoot: options.portfolioOsRuntimeRoot,
  });
  const authority = runtime.providerPolicyAuthority;
  if (!authority) throw new Error("managed_pos_runtime_provider_policy_authority_missing");
  const verified = await (options.providerPolicyAuthorityVerifier ?? verifyProviderPolicyAuthority)({
    authorityPath: authority.path,
    expectedBinding: authority,
  });
  if (verified.binding.path !== authority.path || verified.binding.sha256 !== authority.sha256) {
    throw new Error("managed_pos_runtime_provider_policy_authority_mismatch");
  }
  const loadedContract = await (options.profitFlywheelContractLoader ?? loadProfitFlywheelContract)({
    path: path.join(runtime.current.package_root, "contracts", "profit-flywheel.v2.json"),
  });
  if (loadedContract.sha256 !== PINNED_PROFIT_FLYWHEEL_CONTRACT_SHA256) {
    throw new Error("managed_pos_runtime_profit_flywheel_contract_mismatch");
  }
}

export interface HealthGatedFactoryLaunchAuthorityOptions {
  mode: FactoryMode;
  pauseNewWork: boolean | (() => boolean);
  baselinePointerPath?: string;
  /** Full managed POS closure root used by the source-backed health gate. */
  portfolioOsRuntimeRoot?: SoftwareFactoryHealthOptions["portfolioOsRuntimeRoot"];
  /** Injectable managed-runtime resolver for tests and alternate composition. */
  managedPortfolioOsRuntimeResolver?: SoftwareFactoryHealthOptions["managedPortfolioOsRuntimeResolver"];
  /** Injectable policy loader so admission and the public health surface share one source. */
  providerPolicyLoader?: SoftwareFactoryHealthOptions["providerPolicyLoader"];
  /** Injectable immutable contract loader for source-backed identity verification. */
  profitFlywheelContractLoader?: SoftwareFactoryHealthOptions["profitFlywheelContractLoader"];
  /** Injectable active-authority verifier shared with the health projection. */
  providerPolicyAuthorityVerifier?: SoftwareFactoryHealthOptions["providerPolicyAuthorityVerifier"];
  /**
   * A live authority must atomically consume the exact typed shadow or
   * production approval before it returns allowed. Omission is fail-closed.
   */
  liveAuthority?: FactoryLaunchAuthority;
}

/**
 * Applies the same observed factory-health predicate to every new-work path.
 * It never creates a DB lease or claim itself. The downstream live authority
 * owns the serializable approval-consumption transaction.
 */
export function createHealthGatedFactoryLaunchAuthority(
  db: Db,
  options: HealthGatedFactoryLaunchAuthorityOptions,
): FactoryLaunchAuthority {
  const healthOptions: SoftwareFactoryHealthOptions = {
    mode: options.mode,
    pauseNewWork: options.pauseNewWork,
    baselinePointerPath: options.baselinePointerPath,
    portfolioOsRuntimeRoot: options.portfolioOsRuntimeRoot,
    managedPortfolioOsRuntimeResolver: options.managedPortfolioOsRuntimeResolver,
    providerPolicyLoader: options.providerPolicyLoader,
    profitFlywheelContractLoader: options.profitFlywheelContractLoader,
    providerPolicyAuthorityVerifier: options.providerPolicyAuthorityVerifier,
  };
  const health = softwareFactoryHealthService(db, healthOptions);
  const liveAuthority = options.liveAuthority ?? defaultDenyFactoryLaunchAuthority;
  const isPaused = () => typeof options.pauseNewWork === "function" ? options.pauseNewWork() : options.pauseNewWork;

  return {
    async claim(input: FactoryLaunchAuthorityInput) {
      if (input.pauseNewWork || isPaused()) {
        return denied(
          "factory_new_work_paused",
          "Factory posture pauses all new leases, outbox claims, dispatch ingests, and subprocess launches.",
        );
      }
      if (!input.companyId) {
        return denied(
          "factory_launch_company_binding_missing",
          "New factory work requires an exact company binding before admission can be evaluated.",
          true,
        );
      }

      let snapshot: Awaited<ReturnType<typeof health.build>>;
      try {
        snapshot = await health.build(input.companyId);
      } catch {
        return denied(
          "factory_health_unavailable",
          "The source-backed factory health snapshot could not be built; launch authority fails closed.",
        );
      }
      if (snapshot.pauseNewWork) {
        return denied(
          "factory_health_pause_active",
          "The source-backed factory health snapshot pauses new work.",
        );
      }
      if (snapshot.freshness.stale) {
        return denied(
          "factory_health_snapshot_stale",
          "Factory launch requires a source-backed baseline captured within the configured freshness interval.",
        );
      }
      if (snapshot.host.diskAvailableBytes === null ||
          snapshot.host.diskAvailableBytes < MINIMUM_FACTORY_DISK_BYTES ||
          snapshot.host.diskState === "hard_stop" || snapshot.host.diskState === "unknown") {
        return denied(
          "factory_disk_hard_stop",
          "Factory launch requires a verified minimum of 30 GiB available on the data volume.",
        );
      }

      // Explicit fixture repositories remain executable under a production
      // server posture, but only through the narrow offline fixture authority.
      // This cannot bypass live approval for a real repository target.
      if (options.mode === "fixture" || isFactoryFixtureTarget(input.targetRepo)) {
        return fixtureFactoryLaunchAuthority.claim({ ...input, mode: "fixture" });
      }
      if (input.mode !== options.mode) {
        return denied(
          "factory_mode_binding_mismatch",
          `Launch requested ${input.mode} while the server posture is ${options.mode}.`,
          true,
        );
      }
      if (snapshot.state !== "healthy") {
        return denied(
          "factory_health_not_healthy",
          `Live launch requires a healthy source-backed snapshot; observed ${snapshot.state}.`,
        );
      }
      if (snapshot.identities.some((identity) => !identity.verified)) {
        return denied(
          "factory_runtime_identity_unverified",
          "Live launch requires verified contract, provider-policy, adapter, Portfolio OS, and Hermes identities.",
        );
      }
      const requiredCapability = snapshot.providerReadiness.find((route) =>
        route.alias === input.providerCapabilityClass);
      if (input.providerCapabilityClass !== "deterministic" &&
          (!requiredCapability || requiredCapability.status !== "ready")) {
        return denied(
          "factory_provider_capability_unavailable",
          `Live launch requires a fresh policy-bound ${input.providerCapabilityClass} route with independent different-family review capacity.`,
        );
      }
      if (snapshot.economics.tokenomicsStatus !== "healthy") {
        return denied(
          "factory_tokenomics_unhealthy",
          "Live launch requires a fresh passing tokenomics artifact.",
        );
      }
      try {
        // Re-resolve immediately before the approval-consuming authority call.
        // The health snapshot is intentionally informative; it is not a fence
        // against a descriptor changing between observation and consumption.
        await verifyCurrentManagedRuntimeAuthority(options);
      } catch {
        return denied(
          "factory_runtime_authority_unverified",
          "Live launch requires the currently resolved managed POS contract and provider-policy authority to exactly match the active immutable Paperclip runtime.",
        );
      }
      return liveAuthority.claim(input);
    },
  };
}

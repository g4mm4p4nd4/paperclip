import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_HERMES_ADAPTER_ROOT = "/Users/mnm/Documents/Github/hermes-paperclip-adapter";

export type HermesCompletionCanaryExpectedBinding = {
  route: Record<string, unknown>;
  providerPolicySha256: string;
  providerPolicySchemaSha256: string;
  correlationId: string;
  nonce: string;
};

export type HermesCompletionCanaryArtifactReference = {
  path: string;
  sha256: string;
};

type HermesReceiptContractModule = {
  completionCanaryRouteSha256: (route: unknown) => string;
  generateProviderCatalogEvidence: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  runCompletionCanary: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  validateCompletionCanaryReceipt: (receipt: unknown, options?: Record<string, unknown>) => Record<string, unknown>;
  projectCompletionCanaryReceipt: (receipt: unknown, artifact?: Record<string, unknown>, options?: Record<string, unknown>) => Record<string, unknown>;
  verifyCompletionCanaryReceiptArtifact: (
    artifact: HermesCompletionCanaryArtifactReference,
    expected: HermesCompletionCanaryExpectedBinding,
    options?: { now?: number },
  ) => {
    receipt: Record<string, unknown>;
    artifact: { path: string; sha256: string; bytes: number; mode: string | null; verified: true };
    summary: Record<string, unknown>;
  };
};

const cachedModules = new Map<string, Promise<HermesReceiptContractModule>>();

async function loadHermesReceiptContract(
  configuredRoot = DEFAULT_HERMES_ADAPTER_ROOT,
): Promise<HermesReceiptContractModule> {
  const requestedRoot = path.resolve(configuredRoot);
  let cachedModule = cachedModules.get(requestedRoot);
  if (!cachedModule) {
    cachedModule = (async () => {
      const adapterRoot = await realpath(requestedRoot);
      if (adapterRoot !== requestedRoot) {
        throw new Error("Hermes adapter root must be its canonical realpath");
      }
      const [adapterModulePath, receiptModulePath] = await Promise.all([
        realpath(path.join(adapterRoot, "index.js")),
        realpath(path.join(adapterRoot, "receipt-contract.js")),
      ]);
      if (path.dirname(adapterModulePath) !== adapterRoot || path.dirname(receiptModulePath) !== adapterRoot) {
        throw new Error("Hermes adapter module escaped the configured adapter root");
      }
      const [adapterStat, receiptStat] = await Promise.all([stat(adapterModulePath), stat(receiptModulePath)]);
      if (!adapterStat.isFile() || !receiptStat.isFile()) throw new Error("Hermes adapter contract module is not a regular file");
      const [adapter, receipt] = await Promise.all([
        import(pathToFileURL(adapterModulePath).href),
        import(pathToFileURL(receiptModulePath).href),
      ]) as [Partial<HermesReceiptContractModule>, Partial<HermesReceiptContractModule>];
      const loaded = { ...adapter, ...receipt };
      if (
        typeof loaded.completionCanaryRouteSha256 !== "function" ||
        typeof loaded.generateProviderCatalogEvidence !== "function" ||
        typeof loaded.runCompletionCanary !== "function" ||
        typeof loaded.validateCompletionCanaryReceipt !== "function" ||
        typeof loaded.projectCompletionCanaryReceipt !== "function" ||
        typeof loaded.verifyCompletionCanaryReceiptArtifact !== "function"
      ) {
        throw new Error("Hermes adapter does not export the frozen semantic receipt contract");
      }
      return loaded as HermesReceiptContractModule;
    })();
    cachedModules.set(requestedRoot, cachedModule);
  }
  return cachedModule;
}

export async function runHermesCompletionCanary(input: Record<string, unknown>, adapterRoot?: string) {
  return (await loadHermesReceiptContract(adapterRoot)).runCompletionCanary(input);
}

export async function generateHermesProviderCatalogEvidence(input: Record<string, unknown>, adapterRoot?: string) {
  return (await loadHermesReceiptContract(adapterRoot)).generateProviderCatalogEvidence(input);
}

export async function hashHermesCompletionCanaryRoute(route: unknown, adapterRoot?: string) {
  return (await loadHermesReceiptContract(adapterRoot)).completionCanaryRouteSha256(route);
}

export async function validateHermesCompletionCanaryReceipt(
  receipt: unknown,
  options?: Record<string, unknown>,
  adapterRoot?: string,
) {
  return (await loadHermesReceiptContract(adapterRoot)).validateCompletionCanaryReceipt(receipt, options);
}

export async function projectHermesCompletionCanaryReceipt(
  receipt: unknown,
  artifact?: Record<string, unknown>,
  options?: Record<string, unknown>,
  adapterRoot?: string,
) {
  return (await loadHermesReceiptContract(adapterRoot)).projectCompletionCanaryReceipt(receipt, artifact, options);
}

export async function verifyHermesCompletionCanaryReceiptArtifact(
  artifact: HermesCompletionCanaryArtifactReference,
  expected: HermesCompletionCanaryExpectedBinding,
  options?: { now?: number },
  adapterRoot?: string,
) {
  return (await loadHermesReceiptContract(adapterRoot)).verifyCompletionCanaryReceiptArtifact(artifact, expected, options);
}

export function resetHermesReceiptContractForTests() {
  cachedModules.clear();
}

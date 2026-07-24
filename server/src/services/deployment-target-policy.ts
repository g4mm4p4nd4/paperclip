import { readFileSync } from "node:fs";
import path from "node:path";

export const DEFAULT_DEPLOYMENT_TARGET = "hostinger";
export const LEGACY_FLY_API_TOKEN_SECRET_NAME = "FLY_API_TOKEN";
export const HOSTINGER_API_KEY_SECRET_NAME = "HOSTINGER_API_KEY";
export const HOSTINGER_API_KEY_FILE_SECRET_NAME = "HOSTINGER_API_KEY_FILE";
export const HOSTINGER_VM_ID_SECRET_NAME = "HOSTINGER_VM_ID";
export const HOSTINGER_FIREWALL_ID_SECRET_NAME = "HOSTINGER_FIREWALL_ID";
export const HOSTINGER_ALLOWED_CLIENT_IP_SECRET_NAME = "HOSTINGER_ALLOWED_CLIENT_IP";

export const HOSTINGER_DEPLOYMENT_REQUIRED_SECRET_NAMES = [
  HOSTINGER_API_KEY_SECRET_NAME,
  HOSTINGER_VM_ID_SECRET_NAME,
  HOSTINGER_FIREWALL_ID_SECRET_NAME,
  HOSTINGER_ALLOWED_CLIENT_IP_SECRET_NAME,
] as const;

export function resolveHostingerApiKeyFilePath(): string | null {
  const configured = process.env[HOSTINGER_API_KEY_FILE_SECRET_NAME]?.trim();
  return configured ? path.resolve(configured) : null;
}

function fileHasSecretMaterial(filePath: string) {
  try {
    return readFileSync(filePath, "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

export function isHostingerApiKeyAvailableFromLocalFile() {
  const filePath = resolveHostingerApiKeyFilePath();
  return filePath !== null && fileHasSecretMaterial(filePath);
}

export function isDeploymentSecretSatisfiedByRuntime(name: string) {
  const normalized = name.trim();
  if (!normalized) return false;

  if (normalized === HOSTINGER_API_KEY_SECRET_NAME) {
    return Boolean(process.env[HOSTINGER_API_KEY_SECRET_NAME]?.trim()) ||
      isHostingerApiKeyAvailableFromLocalFile();
  }

  if (normalized === HOSTINGER_API_KEY_FILE_SECRET_NAME) {
    return isHostingerApiKeyAvailableFromLocalFile();
  }

  return Boolean(process.env[normalized]?.trim());
}

export function normalizeDeploymentRequiredSecretNames(names: string[], lane?: string | null) {
  const normalized = new Set(names.map((name) => name.trim()).filter(Boolean));
  const hasLegacyHostingerApiKeyFile = normalized.delete(HOSTINGER_API_KEY_FILE_SECRET_NAME);
  const needsDeploymentTarget =
    normalized.delete(LEGACY_FLY_API_TOKEN_SECRET_NAME) ||
    hasLegacyHostingerApiKeyFile ||
    lane === "deploy";

  if (needsDeploymentTarget) {
    for (const name of HOSTINGER_DEPLOYMENT_REQUIRED_SECRET_NAMES) {
      normalized.add(name);
    }
  }

  return [...normalized].sort();
}

export function hostingerDeploymentTargetMetadata() {
  return {
    provider: DEFAULT_DEPLOYMENT_TARGET,
    operatorAgentName: "Hostinger Deploy Operator",
    operatorRole: "devops",
    operatorSkillKey: "paperclipai/paperclip/hostinger-deploy-operator",
    apiKeySecretName: HOSTINGER_API_KEY_SECRET_NAME,
    apiKeyFileSecretName: HOSTINGER_API_KEY_FILE_SECRET_NAME,
    apiKeyFilePath: resolveHostingerApiKeyFilePath(),
    virtualMachineIdSecretName: HOSTINGER_VM_ID_SECRET_NAME,
    firewallIdSecretName: HOSTINGER_FIREWALL_ID_SECRET_NAME,
    allowedClientIpSecretName: HOSTINGER_ALLOWED_CLIENT_IP_SECRET_NAME,
    networkPolicy: "allowlist_single_client_ip",
    legacyProviderReplaced: "fly.io",
  };
}

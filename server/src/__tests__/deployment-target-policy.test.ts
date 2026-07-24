import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HOSTINGER_ALLOWED_CLIENT_IP_SECRET_NAME,
  HOSTINGER_API_KEY_FILE_SECRET_NAME,
  HOSTINGER_API_KEY_SECRET_NAME,
  HOSTINGER_DEPLOYMENT_REQUIRED_SECRET_NAMES,
  HOSTINGER_FIREWALL_ID_SECRET_NAME,
  HOSTINGER_VM_ID_SECRET_NAME,
  isDeploymentSecretSatisfiedByRuntime,
  normalizeDeploymentRequiredSecretNames,
  resolveHostingerApiKeyFilePath,
} from "../services/deployment-target-policy.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Hostinger deployment target policy", () => {
  it("does not discover a legacy key-file path by default", () => {
    vi.stubEnv(HOSTINGER_API_KEY_FILE_SECRET_NAME, "");

    expect(resolveHostingerApiKeyFilePath()).toBeNull();
  });

  it("accepts the required API key directly from the runtime", () => {
    vi.stubEnv(HOSTINGER_API_KEY_SECRET_NAME, "runtime-test-key");
    vi.stubEnv(HOSTINGER_API_KEY_FILE_SECRET_NAME, "");

    expect(isDeploymentSecretSatisfiedByRuntime(HOSTINGER_API_KEY_SECRET_NAME)).toBe(true);
  });

  it("uses a valid key file only when the legacy bridge is explicitly configured", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-hostinger-policy-"));
    const keyFile = path.join(tempDir, "hostinger-api-key");
    await writeFile(keyFile, "legacy-test-key\n", "utf8");
    vi.stubEnv(HOSTINGER_API_KEY_SECRET_NAME, "");
    vi.stubEnv(HOSTINGER_API_KEY_FILE_SECRET_NAME, keyFile);

    try {
      expect(resolveHostingerApiKeyFilePath()).toBe(path.resolve(keyFile));
      expect(isDeploymentSecretSatisfiedByRuntime(HOSTINGER_API_KEY_SECRET_NAME)).toBe(true);
      expect(isDeploymentSecretSatisfiedByRuntime(HOSTINGER_API_KEY_FILE_SECRET_NAME)).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects an explicit legacy bridge that does not contain a key", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-hostinger-policy-"));
    const keyFile = path.join(tempDir, "empty-hostinger-api-key");
    await writeFile(keyFile, "\n", "utf8");
    vi.stubEnv(HOSTINGER_API_KEY_SECRET_NAME, "");
    vi.stubEnv(HOSTINGER_API_KEY_FILE_SECRET_NAME, keyFile);

    try {
      expect(isDeploymentSecretSatisfiedByRuntime(HOSTINGER_API_KEY_SECRET_NAME)).toBe(false);
      expect(isDeploymentSecretSatisfiedByRuntime(HOSTINGER_API_KEY_FILE_SECRET_NAME)).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("requires the encrypted API-key secret rather than the optional file bridge", () => {
    expect(HOSTINGER_DEPLOYMENT_REQUIRED_SECRET_NAMES).toEqual([
      HOSTINGER_API_KEY_SECRET_NAME,
      HOSTINGER_VM_ID_SECRET_NAME,
      HOSTINGER_FIREWALL_ID_SECRET_NAME,
      HOSTINGER_ALLOWED_CLIENT_IP_SECRET_NAME,
    ]);
    expect(normalizeDeploymentRequiredSecretNames(["FLY_API_TOKEN"])).toEqual(
      [...HOSTINGER_DEPLOYMENT_REQUIRED_SECRET_NAMES].sort(),
    );
    expect(normalizeDeploymentRequiredSecretNames([HOSTINGER_API_KEY_FILE_SECRET_NAME])).toEqual(
      [...HOSTINGER_DEPLOYMENT_REQUIRED_SECRET_NAMES].sort(),
    );
    expect(normalizeDeploymentRequiredSecretNames([], "deploy"))
      .not.toContain(HOSTINGER_API_KEY_FILE_SECRET_NAME);
  });
});

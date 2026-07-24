import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProviderPolicyV2 } from "../services/provider-policy.js";
import { parseProviderPolicyAuthorityPublishArgs } from "../ops/provider-policy-authority.js";
import {
  publishActiveProviderPolicyAuthority,
  verifyProviderPolicyAuthority,
  type ProviderPolicyAuthorityDescriptor,
} from "../services/provider-policy-authority.js";

const roots: string[] = [];
const originalProviderPolicyEnvironment = {
  path: process.env.PAPERCLIP_PROVIDER_POLICY_PATH,
  schemaPath: process.env.PAPERCLIP_PROVIDER_POLICY_SCHEMA_PATH,
  sha256: process.env.PAPERCLIP_PROVIDER_POLICY_SHA256,
  schemaSha256: process.env.PAPERCLIP_PROVIDER_POLICY_SCHEMA_SHA256,
};

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function restoreEnvironmentValue(name: keyof typeof originalProviderPolicyEnvironment) {
  const value = originalProviderPolicyEnvironment[name];
  const environmentName = name === "path" ? "PAPERCLIP_PROVIDER_POLICY_PATH"
    : name === "schemaPath" ? "PAPERCLIP_PROVIDER_POLICY_SCHEMA_PATH"
      : name === "sha256" ? "PAPERCLIP_PROVIDER_POLICY_SHA256"
        : "PAPERCLIP_PROVIDER_POLICY_SCHEMA_SHA256";
  if (value === undefined) delete process.env[environmentName];
  else process.env[environmentName] = value;
}

function canonicalBytes(value: unknown) {
  const canonicalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(canonicalize);
    if (entry && typeof entry === "object") {
      return Object.fromEntries(Object.entries(entry as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, canonicalize(child)]));
    }
    return entry;
  };
  return Buffer.from(`${JSON.stringify(canonicalize(value), null, 2)}\n`, "utf8");
}

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "paperclip-provider-policy-authority-")));
  roots.push(root);
  const managedRuntimeRoot = path.join(root, "managed-paperclip-runtime");
  const configDirectory = path.join(managedRuntimeRoot, "packages", "c".repeat(64), "config");
  const policyPath = path.join(configDirectory, "provider-policy.v2.json");
  const schemaPath = path.join(configDirectory, "provider-policy.v2.schema.json");
  const [policyBytes, schemaBytes] = await Promise.all([
    readFile(path.resolve(process.cwd(), "config/provider-policy.v2.json")),
    readFile(path.resolve(process.cwd(), "config/provider-policy.v2.schema.json")),
  ]);
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await writeFile(policyPath, policyBytes, { mode: 0o600 });
  await writeFile(schemaPath, schemaBytes, { mode: 0o600 });
  const historyPath = path.join(configDirectory, "provider-policy-history", `${sha256(policyBytes)}.json`);
  await mkdir(path.dirname(historyPath), { recursive: true, mode: 0o700 });
  await writeFile(historyPath, policyBytes, { mode: 0o600 });
  await Promise.all([chmod(policyPath, 0o444), chmod(schemaPath, 0o444), chmod(historyPath, 0o444)]);
  process.env.PAPERCLIP_PROVIDER_POLICY_PATH = policyPath;
  process.env.PAPERCLIP_PROVIDER_POLICY_SCHEMA_PATH = schemaPath;
  process.env.PAPERCLIP_PROVIDER_POLICY_SHA256 = sha256(policyBytes);
  process.env.PAPERCLIP_PROVIDER_POLICY_SCHEMA_SHA256 = sha256(schemaBytes);
  const providerPolicy = await loadProviderPolicyV2();
  return { root, managedRuntimeRoot, providerPolicy, historyPath };
}

async function writeDescriptor(root: string, descriptor: ProviderPolicyAuthorityDescriptor) {
  const bytes = canonicalBytes(descriptor);
  const directory = path.join(root, "authorities", "provider-policy");
  const filePath = path.join(directory, `${sha256(bytes)}.json`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(filePath, bytes, { mode: 0o600 });
  await chmod(filePath, 0o444);
  return { path: filePath, sha256: sha256(bytes) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  restoreEnvironmentValue("path");
  restoreEnvironmentValue("schemaPath");
  restoreEnvironmentValue("sha256");
  restoreEnvironmentValue("schemaSha256");
});

describe("immutable Paperclip provider-policy authority", () => {
  it("accepts no publisher arguments and rejects ambiguous publisher input", () => {
    expect(parseProviderPolicyAuthorityPublishArgs([])).toEqual({ help: false });
    expect(parseProviderPolicyAuthorityPublishArgs(["--help"])).toEqual({ help: true });
    expect(() => parseProviderPolicyAuthorityPublishArgs(["--path", "/unsafe"])).toThrow(
      "provider_policy_authority_publish_argument_invalid",
    );
  });

  it("publishes one D6 descriptor with exact active policy/schema pins and verifies it idempotently", async () => {
    const value = await fixture();
    const binding = await publishActiveProviderPolicyAuthority();
    expect(binding.path).toMatch(new RegExp(`^${value.managedRuntimeRoot}/authorities/provider-policy/[a-f0-9]{64}\\.json$`));
    expect((await stat(binding.path)).mode & 0o777).toBe(0o444);
    const descriptor = JSON.parse(await readFile(binding.path, "utf8"));
    expect(descriptor).toEqual({
      authority: "paperclip_control_plane",
      provider_policy: {
        path: value.providerPolicy.path,
        sha256: value.providerPolicy.sha256,
        schema_version: "provider-policy.v2",
        schema_path: value.providerPolicy.schemaPath,
        schema_sha256: value.providerPolicy.schemaSha256,
      },
      schema_version: "pos.paperclip_provider_policy_authority.v1",
    });
    await expect(verifyProviderPolicyAuthority({
      authorityPath: binding.path,
      expectedBinding: binding,
    })).resolves.toMatchObject({ binding, descriptor });
    await expect(publishActiveProviderPolicyAuthority())
      .resolves.toEqual(binding);
  });

  it.each(["missing", "wrong_bytes"] as const)("rejects a %s active policy history archive before publishing a descriptor", async (condition) => {
    const value = await fixture();
    if (condition === "missing") {
      await unlink(value.historyPath);
    } else {
      await chmod(value.historyPath, 0o600);
      await writeFile(value.historyPath, "{}\n", { mode: 0o600 });
      await chmod(value.historyPath, 0o444);
    }
    await expect(publishActiveProviderPolicyAuthority()).rejects.toMatchObject({
      code: "profit_flywheel_provider_policy_binding_mismatch",
    });
  });

  it.each([
    "path",
    "sha256",
    "schema_path",
    "schema_sha256",
  ] as const)("rejects a descriptor whose provider_policy.%s drifts from active D6 pins", async (field) => {
    const value = await fixture();
    const descriptor: ProviderPolicyAuthorityDescriptor = {
      schema_version: "pos.paperclip_provider_policy_authority.v1",
      authority: "paperclip_control_plane",
      provider_policy: {
        path: value.providerPolicy.path,
        sha256: value.providerPolicy.sha256,
        schema_version: "provider-policy.v2",
        schema_path: value.providerPolicy.schemaPath,
        schema_sha256: value.providerPolicy.schemaSha256,
      },
    };
    descriptor.provider_policy[field] = field.endsWith("path")
      ? `${descriptor.provider_policy[field]}.drift`
      : "0".repeat(64);
    const binding = await writeDescriptor(value.managedRuntimeRoot, descriptor);
    await expect(verifyProviderPolicyAuthority({
      authorityPath: binding.path,
      expectedBinding: binding,
    })).rejects.toMatchObject({ code: "profit_flywheel_provider_policy_binding_mismatch" });
  });
});

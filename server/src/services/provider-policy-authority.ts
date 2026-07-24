import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { z } from "zod";
import { writeImmutableReceiptBytes } from "../ops/immutable-json-receipt.js";
import {
  prepareTrustedReceiptDirectory,
  readTrustedFile,
  readTrustedJsonFile,
  requireTrustedDirectory,
} from "../ops/trusted-receipt-directory.js";
import { loadProviderPolicyV2 } from "./provider-policy.js";

const SHA256_RE = /^[0-9a-f]{64}$/;
const MANAGED_PACKAGE_ID_RE = /^[0-9a-f]{64}$/;
const AUTHORITY_SCHEMA_SHA256 = "bd800da956bfb3b2966c5b38326fe4b2e0e8049a1153d51c33394cb862c68541";
const AUTHORITY_SCHEMA_PATH = fileURLToPath(new URL(
  "../../../contracts/profit-flywheel/pos.paperclip_provider_policy_authority.v1.schema.json",
  import.meta.url,
));
const MAX_AUTHORITY_BYTES = 1024 * 1024;

const authoritySchemaBytes = readFileSync(AUTHORITY_SCHEMA_PATH);
if (createHash("sha256").update(authoritySchemaBytes).digest("hex") !== AUTHORITY_SCHEMA_SHA256) {
  throw new Error("provider_policy_authority_schema_pin_mismatch");
}
const AuthorityAjvConstructor = (Ajv2020 as any).default ?? Ajv2020;
const authorityAjv = new AuthorityAjvConstructor({ allErrors: true, strict: false });
const applyAuthorityFormats = (addFormats as any).default ?? addFormats;
applyAuthorityFormats(authorityAjv);
const validateAuthoritySchema = authorityAjv.compile(JSON.parse(authoritySchemaBytes.toString("utf8")));

const artifactBindingSchema = z.object({
  path: z.string().startsWith("/"),
  sha256: z.string().regex(SHA256_RE),
}).strict();

const providerPolicyAuthoritySchema = z.object({
  schema_version: z.literal("pos.paperclip_provider_policy_authority.v1"),
  authority: z.literal("paperclip_control_plane"),
  provider_policy: z.object({
    path: z.string().startsWith("/"),
    sha256: z.string().regex(SHA256_RE),
    schema_version: z.literal("provider-policy.v2"),
    schema_path: z.string().startsWith("/"),
    schema_sha256: z.string().regex(SHA256_RE),
  }).strict(),
}).strict();

export type ProviderPolicyAuthorityBinding = z.infer<typeof artifactBindingSchema>;
export type ProviderPolicyAuthorityDescriptor = z.infer<typeof providerPolicyAuthoritySchema>;
type LoadedProviderPolicy = Awaited<ReturnType<typeof loadProviderPolicyV2>>;

export class ProviderPolicyAuthorityError extends Error {
  readonly code: "profit_flywheel_provider_policy_binding_missing" | "profit_flywheel_provider_policy_binding_mismatch";

  constructor(
    code: ProviderPolicyAuthorityError["code"],
    message: string,
  ) {
    super(message);
    this.name = "ProviderPolicyAuthorityError";
    this.code = code;
  }
}

function compareUnicodeCodePoints(left: string, right: string) {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0)!);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index]! - rightPoints[index]!;
  }
  return leftPoints.length - rightPoints.length;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareUnicodeCodePoints(left, right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

function canonicalJsonBytes(value: unknown) {
  return Buffer.from(`${JSON.stringify(canonicalValue(value), null, 2)}\n`, "utf8");
}

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalAbsolutePath(value: string, code: ProviderPolicyAuthorityError["code"], label: string) {
  if (!path.isAbsolute(value) || path.resolve(value) !== value || /[\r\n\0]/.test(value)) {
    throw new ProviderPolicyAuthorityError(code, `${label} must be a canonical absolute path`);
  }
  return value;
}

function bindingEquals(left: ProviderPolicyAuthorityBinding, right: ProviderPolicyAuthorityBinding) {
  return left.path === right.path && left.sha256 === right.sha256;
}

function providerPolicyMap(loaded: LoadedProviderPolicy): ProviderPolicyAuthorityDescriptor["provider_policy"] {
  return {
    path: loaded.path,
    sha256: loaded.sha256,
    schema_version: "provider-policy.v2",
    schema_path: loaded.schemaPath,
    schema_sha256: loaded.schemaSha256,
  };
}

async function ensureTrustedChildDirectory(parent: string, name: string, label: string) {
  const expected = path.join(parent, name);
  await mkdir(expected, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const before = await lstat(expected).catch(() => null);
  if (!before?.isDirectory() || before.isSymbolicLink() || await realpath(expected).catch(() => "") !== expected) {
    throw new ProviderPolicyAuthorityError(
      "profit_flywheel_provider_policy_binding_mismatch",
      `${label} must be a canonical non-symlink directory`,
    );
  }
  await chmod(expected, 0o700);
  return prepareTrustedReceiptDirectory(expected, label);
}

async function validateManagedRuntimePolicyLayout(loaded: LoadedProviderPolicy) {
  const policyPath = canonicalAbsolutePath(
    loaded.path,
    "profit_flywheel_provider_policy_binding_mismatch",
    "Active provider policy path",
  );
  const schemaPath = canonicalAbsolutePath(
    loaded.schemaPath,
    "profit_flywheel_provider_policy_binding_mismatch",
    "Active provider policy schema path",
  );
  const [policyArtifact, schemaArtifact] = await Promise.all([
    readTrustedFile(policyPath, "provider_policy_authority_policy", {
      maxBytes: MAX_AUTHORITY_BYTES,
      requireReadOnly: true,
    }),
    readTrustedFile(schemaPath, "provider_policy_authority_schema", {
      maxBytes: MAX_AUTHORITY_BYTES,
      requireReadOnly: true,
    }),
  ]).catch(() => {
    throw new ProviderPolicyAuthorityError(
      "profit_flywheel_provider_policy_binding_mismatch",
      "Active provider policy files must be immutable managed-runtime artifacts",
    );
  });
  if (policyArtifact.path !== policyPath || schemaArtifact.path !== schemaPath ||
      policyArtifact.sha256 !== loaded.sha256 || schemaArtifact.sha256 !== loaded.schemaSha256 ||
      (policyArtifact.metadata.mode & 0o777) !== 0o444 || (schemaArtifact.metadata.mode & 0o777) !== 0o444) {
    throw new ProviderPolicyAuthorityError(
      "profit_flywheel_provider_policy_binding_mismatch",
      "Active provider policy bytes or immutable modes differ from the loaded authority pins",
    );
  }
  const policyConfigDirectory = path.dirname(policyPath);
  const schemaConfigDirectory = path.dirname(schemaPath);
  const historyPath = path.join(
    policyConfigDirectory,
    "provider-policy-history",
    `${loaded.sha256}.json`,
  );
  const historyArtifact = await readTrustedFile(historyPath, "provider_policy_authority_history", {
    maxBytes: MAX_AUTHORITY_BYTES,
    requireReadOnly: true,
  }).catch(() => {
    throw new ProviderPolicyAuthorityError(
      "profit_flywheel_provider_policy_binding_mismatch",
      "Active provider policy is missing its immutable content-addressed history archive",
    );
  });
  if (historyArtifact.path !== historyPath || historyArtifact.sha256 !== loaded.sha256 ||
      !historyArtifact.bytes.equals(policyArtifact.bytes) ||
      (historyArtifact.metadata.mode & 0o777) !== 0o444) {
    throw new ProviderPolicyAuthorityError(
      "profit_flywheel_provider_policy_binding_mismatch",
      "Active provider policy history archive does not exactly match the immutable active policy bytes",
    );
  }
  const packageRoot = path.dirname(policyConfigDirectory);
  const packagesRoot = path.dirname(packageRoot);
  const managedRuntimeRoot = path.dirname(packagesRoot);
  if (path.basename(policyConfigDirectory) !== "config" || schemaConfigDirectory !== policyConfigDirectory ||
      path.basename(packagesRoot) !== "packages" || !MANAGED_PACKAGE_ID_RE.test(path.basename(packageRoot))) {
    throw new ProviderPolicyAuthorityError(
      "profit_flywheel_provider_policy_binding_mismatch",
      "Active provider policy does not belong to one immutable managed Paperclip package",
    );
  }
  await requireTrustedDirectory(managedRuntimeRoot, "provider_policy_authority_managed_runtime_root").catch(() => {
    throw new ProviderPolicyAuthorityError(
      "profit_flywheel_provider_policy_binding_mismatch",
      "Managed Paperclip runtime root is not a trusted authority directory",
    );
  });
  return { managedRuntimeRoot, policyArtifact, schemaArtifact };
}

function parseAuthorityDescriptor(value: unknown) {
  if (!validateAuthoritySchema(value)) {
    throw new ProviderPolicyAuthorityError(
      "profit_flywheel_provider_policy_binding_mismatch",
      "Provider policy authority descriptor failed its pinned contract schema",
    );
  }
  const parsed = providerPolicyAuthoritySchema.safeParse(value);
  if (!parsed.success) {
    throw new ProviderPolicyAuthorityError(
      "profit_flywheel_provider_policy_binding_mismatch",
      "Provider policy authority descriptor is structurally invalid",
    );
  }
  return parsed.data;
}

async function readAuthorityDescriptor(input: {
  path: string;
  expectedBinding?: ProviderPolicyAuthorityBinding;
}) {
  const authorityPath = canonicalAbsolutePath(
    input.path,
    "profit_flywheel_provider_policy_binding_missing",
    "Provider policy authority path",
  );
  const artifact = await readTrustedJsonFile(
    authorityPath,
    "provider_policy_authority_descriptor",
    { maxBytes: MAX_AUTHORITY_BYTES },
  ).catch(() => {
    throw new ProviderPolicyAuthorityError(
      "profit_flywheel_provider_policy_binding_mismatch",
      "Provider policy authority descriptor is not an immutable trusted JSON artifact",
    );
  });
  if ((artifact.metadata.mode & 0o777) !== 0o444) {
    throw new ProviderPolicyAuthorityError(
      "profit_flywheel_provider_policy_binding_mismatch",
      "Provider policy authority descriptor must be mode 0444",
    );
  }
  const binding = { path: artifact.path, sha256: artifact.sha256 };
  if (input.expectedBinding && !bindingEquals(binding, input.expectedBinding)) {
    throw new ProviderPolicyAuthorityError(
      "profit_flywheel_provider_policy_binding_mismatch",
      "Provider policy authority descriptor does not match the immutable runtime manifest binding",
    );
  }
  const descriptor = parseAuthorityDescriptor(artifact.value);
  if (!artifact.bytes.equals(canonicalJsonBytes(descriptor))) {
    throw new ProviderPolicyAuthorityError(
      "profit_flywheel_provider_policy_binding_mismatch",
      "Provider policy authority descriptor must use canonical JSON bytes",
    );
  }
  return { artifact, binding, descriptor };
}

/** Validate only the immutable descriptor artifact and an exact manifest binding. */
export async function verifyProviderPolicyAuthorityDescriptor(input: {
  authorityPath: string;
  expectedBinding: ProviderPolicyAuthorityBinding;
}) {
  const expectedBinding = artifactBindingSchema.safeParse(input.expectedBinding);
  if (!expectedBinding.success) {
    throw new ProviderPolicyAuthorityError(
      "profit_flywheel_provider_policy_binding_missing",
      "POS runtime manifest is missing a valid provider policy authority binding",
    );
  }
  return readAuthorityDescriptor({
    path: input.authorityPath,
    expectedBinding: expectedBinding.data,
  });
}

/**
 * Publish one content-addressed, immutable policy descriptor beneath the
 * active managed Paperclip runtime. The descriptor contains no secret values;
 * it only freezes the active policy/schema paths and byte identities.
 */
export async function publishActiveProviderPolicyAuthority(): Promise<ProviderPolicyAuthorityBinding> {
  const loaded = await loadProviderPolicyV2();
  const verified = await validateManagedRuntimePolicyLayout(loaded);
  const authorityDirectory = await ensureTrustedChildDirectory(
    await ensureTrustedChildDirectory(
      verified.managedRuntimeRoot,
      "authorities",
      "provider_policy_authority_root",
    ),
    "provider-policy",
    "provider_policy_authority_directory",
  );
  const descriptor: ProviderPolicyAuthorityDescriptor = {
    schema_version: "pos.paperclip_provider_policy_authority.v1",
    authority: "paperclip_control_plane",
    provider_policy: providerPolicyMap(loaded),
  };
  const bytes = canonicalJsonBytes(descriptor);
  const descriptorSha256 = sha256(bytes);
  const descriptorPath = path.join(authorityDirectory, `${descriptorSha256}.json`);
  try {
    await writeImmutableReceiptBytes(descriptorPath, bytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const published = await readAuthorityDescriptor({
    path: descriptorPath,
    expectedBinding: { path: descriptorPath, sha256: descriptorSha256 },
  });
  if (!bindingEquals(published.binding, { path: descriptorPath, sha256: descriptorSha256 }) ||
      !isDeepStrictEqual(published.descriptor, descriptor)) {
    throw new ProviderPolicyAuthorityError(
      "profit_flywheel_provider_policy_binding_mismatch",
      "Published provider policy authority descriptor differs from the active policy pins",
    );
  }
  // Reload after publication so a changed active selection cannot race
  // descriptor publication and silently leave a stale launch authority.
  const reloaded = await loadProviderPolicyV2();
  await validateManagedRuntimePolicyLayout(reloaded);
  if (!isDeepStrictEqual(providerPolicyMap(reloaded), descriptor.provider_policy)) {
    throw new ProviderPolicyAuthorityError(
      "profit_flywheel_provider_policy_binding_mismatch",
      "Active provider policy changed while publishing its authority descriptor",
    );
  }
  return published.binding;
}

/**
 * Verify a descriptor selected by a POS runtime manifest against the currently
 * loaded Paperclip policy. The comparison is intentionally path-sensitive:
 * matching hashes at a developer checkout are not a substitute for the exact
 * active managed-runtime policy and schema files.
 */
export async function verifyProviderPolicyAuthority(input: {
  authorityPath: string;
  expectedBinding: ProviderPolicyAuthorityBinding;
}) {
  const loaded = await loadProviderPolicyV2();
  await validateManagedRuntimePolicyLayout(loaded);
  const descriptor = await verifyProviderPolicyAuthorityDescriptor(input);
  const expectedPolicy = providerPolicyMap(loaded);
  if (!isDeepStrictEqual(descriptor.descriptor.provider_policy, expectedPolicy)) {
    throw new ProviderPolicyAuthorityError(
      "profit_flywheel_provider_policy_binding_mismatch",
      "Provider policy authority descriptor does not equal the active Paperclip policy path/schema pins",
    );
  }
  return {
    binding: descriptor.binding,
    descriptor: descriptor.descriptor,
    providerPolicy: loaded,
  };
}

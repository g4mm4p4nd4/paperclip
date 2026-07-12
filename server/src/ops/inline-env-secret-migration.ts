import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  agents,
  companies,
  companySecrets,
  companySecretVersions,
  heartbeatRuns,
  inspectMigrations,
  runDatabaseBackup,
  type Db,
  type RunDatabaseBackupResult,
} from "@paperclipai/db";
import { createLocalEncryptedVersionFromKey } from "../secrets/local-encrypted-provider.js";
import { secretService } from "../services/secrets.js";
import {
  isSensitiveEnvBinding,
} from "../services/sensitive-env-keys.js";
import { writeImmutableJsonReceipt } from "./immutable-json-receipt.js";

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REDACTED_SENTINEL = "***REDACTED***";
const RECEIPT_SCHEMA_VERSION = "paperclip.inline_env_secret_migration.v2";
const RECOVERY_SCHEMA_VERSION = "paperclip.inline_env_secret_migration_recovery.v1";
const DEFAULT_RECEIPT_DIR = "data/ops/inline-env-secret-migration/runs";
const MAINTENANCE_ACK = "I_HAVE_STOPPED_PAPERCLIP_WRITERS";

type JsonRecord = Record<string, unknown>;
type SecretAction = "create" | "reuse" | "rotate";

export const INLINE_SECRET_MIGRATION_MAINTENANCE_ENV =
  "PAPERCLIP_INLINE_SECRET_MIGRATION_MAINTENANCE";
export const INLINE_SECRET_MIGRATION_MAINTENANCE_ACK = MAINTENANCE_ACK;

export type InlineEnvSecretMigrationOptions = {
  apply?: boolean;
  connectionString?: string;
  homeDir?: string;
  instanceId?: string;
  receiptDir?: string;
  backupDir?: string;
  masterKeyFilePath?: string;
  importCompanyId?: string;
  importEnvNames?: string[];
  rotateImportedSecrets?: boolean;
  expectedPlanSha256?: string;
  /** Test seam: production callers omit this and values come from process.env. */
  environment?: NodeJS.ProcessEnv;
  now?: Date;
  maintenanceAcknowledged?: boolean;
  backupRunner?: (options: {
    connectionString: string;
    backupDir: string;
  }) => Promise<RunDatabaseBackupResult>;
  testHooks?: {
    beforeTransaction?: () => void | Promise<void>;
    afterSecretWrites?: () => void | Promise<void>;
    beforeCommit?: () => void | Promise<void>;
  };
  receiptWriter?: typeof writeImmutableJsonReceipt;
};

export type InlineEnvSecretMigrationCliOptions = {
  apply: boolean;
  importCompanyId?: string;
  importEnvNames: string[];
  rotateImportedSecrets: boolean;
  expectedPlanSha256?: string;
  homeDir?: string;
  instanceId?: string;
  receiptDir?: string;
  backupDir?: string;
  help: boolean;
};

type MigrationAgent = Pick<
  typeof agents.$inferSelect,
  "id" | "companyId" | "status" | "adapterConfig" | "updatedAt"
>;

type InternalSecretGroup = {
  key: string;
  companyId: string;
  name: string;
  value: string;
  valueSha256: string;
  agentIds: Set<string>;
  imported: boolean;
  id: string;
  version: number;
  action: SecretAction;
  expectedSecret: typeof companySecrets.$inferSelect | null;
  expectedVersion: typeof companySecretVersions.$inferSelect | null;
};

type AgentMutationPlan = {
  agent: MigrationAgent;
  beforeAdapterConfigSha256: string;
  nextAdapterConfig: JsonRecord;
};

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function hmacSha256(key: Buffer, value: string) {
  return createHmac("sha256", key).update(value).digest("hex");
}

function safeHexEqual(left: string, right: string) {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function adapterConfigSha256(value: unknown) {
  return sha256(JSON.stringify(value));
}

function redactForSafePlan(value: unknown, fieldName = ""): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactForSafePlan(entry));
  const record = asRecord(value);
  if (!record) return isSensitiveEnvBinding(fieldName, value) && typeof value === "string"
    ? "<inline-secret-redacted>"
    : value;
  if (record.type === "secret_ref" && typeof record.secretId === "string") {
    return {
      type: "secret_ref",
      secretId: record.secretId,
      version: record.version ?? "latest",
    };
  }
  if (record.type === "plain" && isSensitiveEnvBinding(fieldName, record)) {
    return { type: "plain", value: "<inline-secret-redacted>" };
  }
  return Object.fromEntries(
    Object.entries(record)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, redactForSafePlan(entry, key)]),
  );
}

function safeAdapterConfigSha256(value: unknown) {
  return sha256(JSON.stringify(redactForSafePlan(value)));
}

function groupKey(companyId: string, name: string) {
  return `${companyId}\u0000${name}`;
}

function deterministicSecretId(companyId: string, name: string) {
  const chars = sha256(`paperclip.inline-env-secret.v2\u0000${companyId}\u0000${name}`)
    .slice(0, 32)
    .split("");
  chars[12] = "5";
  chars[16] = ((Number.parseInt(chars[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function readPlainBinding(name: string, binding: unknown): string | null {
  if (typeof binding === "string") return binding;
  const record = asRecord(binding);
  if (record?.type === "secret_ref" && typeof record.secretId === "string") return null;
  if (record?.type === "plain" && typeof record.value === "string") return record.value;
  throw new Error(`inline_secret_binding_invalid: name=${name}`);
}

function addGroupValue(
  groups: Map<string, InternalSecretGroup>,
  input: { companyId: string; name: string; value: string; agentId?: string; imported?: boolean },
) {
  if (input.value === REDACTED_SENTINEL) {
    throw new Error(`inline_secret_redacted_placeholder: company=${input.companyId} name=${input.name}`);
  }
  const key = groupKey(input.companyId, input.name);
  const valueSha256 = sha256(input.value);
  const current = groups.get(key);
  if (current && current.valueSha256 !== valueSha256) {
    throw new Error(
      `inline_secret_plaintext_collision: company=${input.companyId} name=${input.name}; multiple distinct values refuse canonicalization`,
    );
  }
  const group = current ?? {
    key,
    companyId: input.companyId,
    name: input.name,
    value: input.value,
    valueSha256,
    agentIds: new Set<string>(),
    imported: false,
    id: deterministicSecretId(input.companyId, input.name),
    version: 1,
    action: "create" as const,
    expectedSecret: null,
    expectedVersion: null,
  };
  if (input.agentId) group.agentIds.add(input.agentId);
  if (input.imported) group.imported = true;
  groups.set(key, group);
}

function publicSecretEntries(groups: InternalSecretGroup[]) {
  return groups
    .map((group) => ({
      companyId: group.companyId,
      name: group.name,
      id: group.id,
      version: group.version,
      action: group.action,
    }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

function receiptSummary(scannedAgentCount: number, agentPlans: AgentMutationPlan[], groups: InternalSecretGroup[]) {
  return {
    scannedAgentCount,
    changedAgentCount: agentPlans.length,
    canonicalSecretCount: groups.length,
    createCount: groups.filter((group) => group.action === "create").length,
    reuseCount: groups.filter((group) => group.action === "reuse").length,
    rotateCount: groups.filter((group) => group.action === "rotate").length,
    importedSecretCount: groups.filter((group) => group.imported).length,
  };
}

function publicPlanStructureSha256(
  allAgents: MigrationAgent[],
  groups: InternalSecretGroup[],
  agentPlans: AgentMutationPlan[],
) {
  // This approval pin intentionally excludes plaintext and value fingerprints.
  // Secret equality is checked independently inside the serializable CAS.
  const target = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    secrets: groups.map((group) => ({
      companyId: group.companyId,
      name: group.name,
      id: group.id,
      version: group.version,
      action: group.action,
    })),
    agents: allAgents
      .map((agent) => ({
        id: agent.id,
        companyId: agent.companyId,
        status: agent.status,
        updatedAt: agent.updatedAt.toISOString(),
        beforeAdapterConfigSha256: safeAdapterConfigSha256(agent.adapterConfig),
        names: groups
          .filter((group) => group.companyId === agent.companyId && group.agentIds.has(agent.id))
          .map((group) => group.name)
          .sort(),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
  return sha256(JSON.stringify(target));
}

function internalPlanStateSha256(
  allAgents: MigrationAgent[],
  groups: InternalSecretGroup[],
) {
  return sha256(JSON.stringify({
    agents: [...allAgents]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((agent) => ({
        id: agent.id,
        companyId: agent.companyId,
        status: agent.status,
        updatedAt: agent.updatedAt.toISOString(),
        adapterConfigSha256: adapterConfigSha256(agent.adapterConfig),
      })),
    secrets: groups.map((group) => ({
      companyId: group.companyId,
      name: group.name,
      id: group.id,
      version: group.version,
      action: group.action,
      valueSha256: group.valueSha256,
      expectedSecretUpdatedAt: group.expectedSecret?.updatedAt.toISOString() ?? null,
      expectedVersionId: group.expectedVersion?.id ?? null,
      expectedVersionRevokedAt: group.expectedVersion?.revokedAt?.toISOString() ?? null,
    })),
  }));
}

function importApprovalHmac(options: InlineEnvSecretMigrationOptions, approvalKey: Buffer) {
  const names = [...new Set(options.importEnvNames ?? [])].sort();
  const environment = options.environment ?? process.env;
  return hmacSha256(approvalKey, JSON.stringify({
    companyId: options.importCompanyId ?? null,
    values: names.map((name) => ({ name, value: environment[name] ?? null })),
  }));
}

function hasInlineSensitiveBinding(agent: Pick<MigrationAgent, "adapterConfig">) {
  const env = asRecord(asRecord(agent.adapterConfig)?.env);
  if (!env) return false;
  return Object.entries(env).some(([name, binding]) => {
    if (!isSensitiveEnvBinding(name, binding)) return false;
    if (typeof binding === "string") return binding.trim().length > 0;
    const record = asRecord(binding);
    if (record?.type === "secret_ref" && typeof record.secretId === "string") return false;
    return record?.type !== "plain" || typeof record.value !== "string" || record.value.trim().length > 0;
  });
}

function canonicalizeExpectedAdapterConfig(adapterConfig: JsonRecord) {
  const next = { ...adapterConfig };
  const env = asRecord(adapterConfig.env);
  if (!env) return next;
  next.env = Object.fromEntries(Object.entries(env).map(([name, binding]) => {
    if (typeof binding === "string") return [name, { type: "plain", value: binding }];
    const record = asRecord(binding);
    if (record?.type === "plain" && typeof record.value === "string") {
      return [name, { type: "plain", value: record.value }];
    }
    if (record?.type === "secret_ref" && typeof record.secretId === "string") {
      return [name, {
        type: "secret_ref",
        secretId: record.secretId,
        version: typeof record.version === "number" ? record.version : "latest",
      }];
    }
    throw new Error(`inline_secret_binding_invalid: name=${name}`);
  }));
  return next;
}

type ExpectedPostState = {
  agents: Array<{ id: string; adapterConfigHmacSha256: string }>;
  secrets: Array<{
    companyId: string;
    name: string;
    id: string;
    version: number;
    provider: "local_encrypted";
    externalRef: null;
    versionStateHmacSha256: string;
  }>;
};

function receiptTimestamp(now: Date) {
  return now.toISOString().replace(/[-:.]/g, "").replace("Z", "Z");
}

async function ensureDirectoryChain(basePath: string, segments: string[]) {
  const base = path.resolve(basePath);
  const baseLeaf = await lstat(base);
  const currentUid = typeof process.geteuid === "function" ? process.geteuid() : null;
  const isTrustedDirectory = (metadata: Stats) => metadata.isDirectory() && !metadata.isSymbolicLink() &&
    (currentUid === null || metadata.uid === currentUid) && (metadata.mode & 0o022) === 0;
  if (!isTrustedDirectory(baseLeaf)) throw new Error("inline_secret_operator_root_invalid");
  const canonicalBase = await realpath(base);
  await fsyncDirectory(canonicalBase);
  let current = base;
  for (const segment of segments) {
    if (!segment || segment === "." || segment === ".." || segment.includes(path.sep)) {
      throw new Error("inline_secret_operator_root_invalid");
    }
    current = path.join(current, segment);
    let created = false;
    try {
      await mkdir(current, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const metadata = await lstat(current);
    if (!isTrustedDirectory(metadata)) throw new Error("inline_secret_operator_root_invalid");
    const canonical = await realpath(current);
    if (canonical !== canonicalBase && !canonical.startsWith(`${canonicalBase}${path.sep}`)) {
      throw new Error("inline_secret_operator_root_escaped");
    }
    await fsyncDirectory(canonical);
    if (created) await fsyncDirectory(await realpath(path.dirname(current)));
  }
  return realpath(current);
}

async function prepareInstancePaths(options: InlineEnvSecretMigrationOptions) {
  const homeDir = path.resolve(options.homeDir ?? process.env.PAPERCLIP_HOME ?? path.join(os.homedir(), ".paperclip"));
  const instanceId = options.instanceId ?? process.env.PAPERCLIP_INSTANCE_ID ?? "default";
  if (!/^[A-Za-z0-9_-]+$/.test(instanceId)) throw new Error("inline_secret_instance_id_invalid");
  const instanceRoot = await ensureDirectoryChain(homeDir, ["instances", instanceId]);
  const relativeReceiptDir = options.receiptDir ?? DEFAULT_RECEIPT_DIR;
  const normalized = path.normalize(relativeReceiptDir);
  if (!relativeReceiptDir.trim() || path.isAbsolute(relativeReceiptDir) ||
      normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error("inline_secret_receipt_dir_invalid");
  }
  const receiptRoot = await ensureDirectoryChain(instanceRoot, normalized.split(path.sep).filter(Boolean));
  await chmod(receiptRoot, 0o700);
  await fsyncDirectory(receiptRoot);
  await fsyncDirectory(await realpath(path.dirname(receiptRoot)));
  const receiptMetadata = await lstat(receiptRoot);
  const currentUid = typeof process.geteuid === "function" ? process.geteuid() : null;
  if ((receiptMetadata.mode & 0o777) !== 0o700 ||
      (currentUid !== null && receiptMetadata.uid !== currentUid)) {
    throw new Error("inline_secret_receipt_root_permissions_invalid");
  }
  const backupDir = options.backupDir
    ? await (() => {
        const requested = path.resolve(options.backupDir!);
        return ensureDirectoryChain(path.dirname(requested), [path.basename(requested)]);
      })()
    : await ensureDirectoryChain(instanceRoot, ["data", "backups"]);
  await chmod(backupDir, 0o700);
  await fsyncDirectory(backupDir);
  await fsyncDirectory(await realpath(path.dirname(backupDir)));
  const backupMetadata = await lstat(backupDir);
  if (!backupMetadata.isDirectory() || backupMetadata.isSymbolicLink() ||
      (backupMetadata.mode & 0o777) !== 0o700 ||
      (currentUid !== null && backupMetadata.uid !== currentUid)) {
    throw new Error("inline_secret_backup_root_permissions_invalid");
  }
  return {
    instanceRoot,
    receiptRoot,
    backupDir,
  };
}

async function fsyncDirectory(directory: string) {
  const handle = await open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function secureBackupFile(filePath: string, backupRoot: string) {
  const requested = path.resolve(filePath);
  const currentUid = typeof process.geteuid === "function" ? process.geteuid() : null;
  const rootMetadata = await lstat(backupRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() ||
      (rootMetadata.mode & 0o777) !== 0o700 ||
      (currentUid !== null && rootMetadata.uid !== currentUid)) {
    throw new Error("inline_secret_backup_root_permissions_invalid");
  }
  const leaf = await lstat(requested);
  if (!leaf.isFile() || leaf.isSymbolicLink() || leaf.size < 1 ||
      (currentUid !== null && leaf.uid !== currentUid) || (leaf.mode & 0o077) !== 0) {
    throw new Error("inline_secret_backup_not_regular_file");
  }
  const [canonical, canonicalParent] = await Promise.all([realpath(requested), realpath(path.dirname(requested))]);
  if (canonicalParent !== path.resolve(backupRoot)) throw new Error("inline_secret_backup_escaped_root");
  const needsHardening = (leaf.mode & 0o777) !== 0o400;
  const handle = await open(
    requested,
    (needsHardening ? constants.O_RDWR : constants.O_RDONLY) | (constants.O_NOFOLLOW ?? 0),
  );
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== leaf.dev || before.ino !== leaf.ino || before.size !== leaf.size) {
      throw new Error("inline_secret_backup_changed");
    }
    if (needsHardening) {
      await handle.chmod(0o400);
      await handle.sync();
    }
    const hash = createHash("sha256");
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    const canonicalAfter = await realpath(requested);
    if (canonicalAfter !== canonical || after.dev !== before.dev || after.ino !== before.ino ||
        after.size !== before.size || after.mtimeMs !== before.mtimeMs || (after.mode & 0o777) !== 0o400) {
      throw new Error("inline_secret_backup_changed");
    }
    if (needsHardening) await handle.sync();
    await fsyncDirectory(canonicalParent);
    return {
      path: canonical,
      sha256: hash.digest("hex"),
      sizeBytes: after.size,
      mode: "0400",
    };
  } finally {
    buffer.fill(0);
    await handle.close();
  }
}

function decodeMasterKey(raw: string) {
  const trimmed = raw.trim();
  if (/^[a-f0-9]{64}$/i.test(trimmed)) return Buffer.from(trimmed, "hex");
  try {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === 32) return decoded;
  } catch {
    // Fall through to the raw 32-byte representation.
  }
  return Buffer.byteLength(trimmed, "utf8") === 32 ? Buffer.from(trimmed, "utf8") : null;
}

async function loadMasterKeyBoundary(masterKeyFilePath?: string) {
  if (process.env.PAPERCLIP_SECRETS_MASTER_KEY?.trim()) {
    throw new Error("inline_secret_inline_master_key_forbidden");
  }
  const keyPath = path.resolve(
    masterKeyFilePath ?? process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE ?? "",
  );
  if (!masterKeyFilePath && !process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE) {
    throw new Error("inline_secret_master_key_not_configured");
  }
  let raw = Buffer.alloc(0);
  try {
    const leaf = await lstat(keyPath);
    if (!leaf.isFile() || leaf.isSymbolicLink()) throw new Error("inline_secret_master_key_invalid");
    const canonicalBefore = await realpath(keyPath);
    const handle = await open(keyPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let metadata: Stats;
    try {
      metadata = await handle.stat();
      const currentUid = typeof process.geteuid === "function" ? process.geteuid() : null;
      if (metadata.dev !== leaf.dev || metadata.ino !== leaf.ino || !metadata.isFile() ||
          metadata.size < 1 || metadata.size > 4096 ||
          (currentUid !== null && metadata.uid !== currentUid) ||
          (metadata.mode & 0o400) === 0 || (metadata.mode & 0o111) !== 0 || (metadata.mode & 0o077) !== 0) {
        throw new Error("inline_secret_master_key_invalid");
      }
      raw = await handle.readFile();
      const afterRead = await handle.stat();
      if (afterRead.dev !== metadata.dev || afterRead.ino !== metadata.ino || afterRead.size !== metadata.size ||
          afterRead.mode !== metadata.mode || afterRead.uid !== metadata.uid || afterRead.mtimeMs !== metadata.mtimeMs) {
        throw new Error("inline_secret_master_key_invalid");
      }
    } finally {
      await handle.close();
    }
    const [canonicalAfter, after] = await Promise.all([realpath(keyPath), lstat(keyPath)]);
    if (canonicalAfter !== canonicalBefore || after.dev !== metadata.dev || after.ino !== metadata.ino ||
        after.uid !== metadata.uid || after.mode !== metadata.mode || after.size !== metadata.size ||
        after.mtimeMs !== metadata.mtimeMs) {
      throw new Error("inline_secret_master_key_invalid");
    }
    const key = decodeMasterKey(raw.toString("utf8"));
    if (!key) throw new Error("inline_secret_master_key_invalid");
    return {
      configuredPath: keyPath,
      canonicalPath: canonicalBefore,
      identity: {
        dev: metadata.dev,
        ino: metadata.ino,
        uid: metadata.uid,
        mode: metadata.mode,
        size: metadata.size,
        mtimeMs: metadata.mtimeMs,
      },
      key,
    };
  } catch {
    throw new Error("inline_secret_master_key_invalid");
  } finally {
    raw.fill(0);
  }
}

async function revalidateMasterKeyBoundary(masterKey: Awaited<ReturnType<typeof loadMasterKeyBoundary>>) {
  try {
    const leaf = await lstat(masterKey.configuredPath);
    if (!leaf.isFile() || leaf.isSymbolicLink()) throw new Error("inline_secret_master_key_changed");
    const canonical = await realpath(masterKey.configuredPath);
    if (canonical !== masterKey.canonicalPath || leaf.dev !== masterKey.identity.dev ||
        leaf.ino !== masterKey.identity.ino || leaf.uid !== masterKey.identity.uid ||
        leaf.mode !== masterKey.identity.mode || leaf.size !== masterKey.identity.size ||
        leaf.mtimeMs !== masterKey.identity.mtimeMs) {
      throw new Error("inline_secret_master_key_changed");
    }
    const handle = await open(masterKey.configuredPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const current = await handle.stat();
      if (current.dev !== masterKey.identity.dev || current.ino !== masterKey.identity.ino ||
          current.uid !== masterKey.identity.uid || current.mode !== masterKey.identity.mode ||
          current.size !== masterKey.identity.size || current.mtimeMs !== masterKey.identity.mtimeMs) {
        throw new Error("inline_secret_master_key_changed");
      }
      const raw = await handle.readFile();
      const observedKey = decodeMasterKey(raw.toString("utf8"));
      try {
        const afterRead = await handle.stat();
        if (!observedKey || observedKey.length !== masterKey.key.length ||
            !timingSafeEqual(observedKey, masterKey.key) ||
            afterRead.dev !== masterKey.identity.dev || afterRead.ino !== masterKey.identity.ino ||
            afterRead.uid !== masterKey.identity.uid || afterRead.mode !== masterKey.identity.mode ||
            afterRead.size !== masterKey.identity.size || afterRead.mtimeMs !== masterKey.identity.mtimeMs) {
          throw new Error("inline_secret_master_key_changed");
        }
      } finally {
        observedKey?.fill(0);
        raw.fill(0);
      }
    } finally {
      await handle.close();
    }
  } catch {
    throw new Error("inline_secret_master_key_changed");
  }
}

async function createPlan(db: Db, options: InlineEnvSecretMigrationOptions, approvalKey: Buffer) {
  const importEnvNames = [...new Set(options.importEnvNames ?? [])].sort();
  const environment = options.environment ?? process.env;
  if (importEnvNames.length > 0 && !options.importCompanyId) {
    throw new Error("inline_secret_import_company_required");
  }
  if (options.importCompanyId && !/^[a-f0-9-]{36}$/i.test(options.importCompanyId)) {
    throw new Error("inline_secret_import_company_invalid");
  }
  if (options.rotateImportedSecrets && importEnvNames.length === 0) {
    throw new Error("inline_secret_rotate_requires_import");
  }

  const allAgents = await db.select({
    id: agents.id,
    companyId: agents.companyId,
    status: agents.status,
    adapterConfig: agents.adapterConfig,
    updatedAt: agents.updatedAt,
  }).from(agents);
  const groups = new Map<string, InternalSecretGroup>();

  for (const agent of allAgents) {
    const adapterConfig = asRecord(agent.adapterConfig);
    const env = asRecord(adapterConfig?.env);
    if (!env) continue;
    for (const [name, binding] of Object.entries(env)) {
      if (!isSensitiveEnvBinding(name, binding)) continue;
      const value = readPlainBinding(name, binding);
      if (value === null || value.trim().length === 0) continue;
      addGroupValue(groups, { companyId: agent.companyId, name, value, agentId: agent.id });
    }
  }

  if (options.importCompanyId) {
    const company = await db.select({ id: companies.id }).from(companies)
      .where(eq(companies.id, options.importCompanyId)).then((rows) => rows[0] ?? null);
    if (!company) throw new Error("inline_secret_import_company_not_found");
    for (const name of importEnvNames) {
      if (!ENV_NAME_RE.test(name)) {
        throw new Error(`inline_secret_import_name_invalid: name=${name}`);
      }
      const value = environment[name];
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`inline_secret_import_value_missing: name=${name}`);
      }
      if (!isSensitiveEnvBinding(name, value)) {
        throw new Error(`inline_secret_import_name_invalid: name=${name}`);
      }
      addGroupValue(groups, {
        companyId: options.importCompanyId,
        name,
        value,
        imported: true,
      });
    }
  }

  const orderedGroups = [...groups.values()].sort((left, right) =>
    left.companyId.localeCompare(right.companyId) || left.name.localeCompare(right.name));
  const companyIds = [...new Set(orderedGroups.map((group) => group.companyId))];
  const names = [...new Set(orderedGroups.map((group) => group.name))];
  const candidateSecrets = orderedGroups.length > 0
    ? await db.select().from(companySecrets).where(and(
        inArray(companySecrets.companyId, companyIds),
        inArray(companySecrets.name, names),
      ))
    : [];
  const candidateIds = candidateSecrets.map((secret) => secret.id);
  const candidateVersions = candidateIds.length > 0
    ? await db.select().from(companySecretVersions)
        .where(inArray(companySecretVersions.secretId, candidateIds))
    : [];
  const secretByKey = new Map(candidateSecrets.map((secret) => [groupKey(secret.companyId, secret.name), secret]));
  const versionsBySecret = new Map<string, typeof companySecretVersions.$inferSelect[]>();
  for (const version of candidateVersions) {
    versionsBySecret.set(version.secretId, [...(versionsBySecret.get(version.secretId) ?? []), version]);
  }

  for (const group of orderedGroups) {
    const existing = secretByKey.get(group.key) ?? null;
    if (!existing) continue;
    if (existing.provider !== "local_encrypted") {
      throw new Error(`inline_secret_provider_mismatch: company=${group.companyId} name=${group.name}`);
    }
    const currentVersion = (versionsBySecret.get(existing.id) ?? [])
      .find((version) => version.version === existing.latestVersion) ?? null;
    const active = currentVersion && currentVersion.revokedAt === null;
    group.id = existing.id;
    group.expectedSecret = existing;
    group.expectedVersion = currentVersion;
    if (active && currentVersion.valueSha256 === group.valueSha256) {
      group.action = "reuse";
      group.version = existing.latestVersion;
      continue;
    }
    if (group.imported && options.rotateImportedSecrets) {
      group.action = "rotate";
      group.version = existing.latestVersion + 1;
      continue;
    }
    throw new Error(`inline_secret_fingerprint_mismatch: company=${group.companyId} name=${group.name}`);
  }

  const groupByKey = new Map(orderedGroups.map((group) => [group.key, group]));
  const agentPlans: AgentMutationPlan[] = [];
  for (const agent of allAgents) {
    const adapterConfig = asRecord(agent.adapterConfig);
    const env = asRecord(adapterConfig?.env);
    if (!adapterConfig || !env) continue;
    const nextEnv: JsonRecord = { ...env };
    let changed = false;
    for (const [name, binding] of Object.entries(env)) {
      if (!isSensitiveEnvBinding(name, binding)) continue;
      const value = readPlainBinding(name, binding);
      if (value === null || value.trim().length === 0) continue;
      const group = groupByKey.get(groupKey(agent.companyId, name));
      if (!group) throw new Error(`inline_secret_plan_incomplete: name=${name}`);
      nextEnv[name] = { type: "secret_ref", secretId: group.id, version: "latest" };
      changed = true;
    }
    if (!changed) continue;
    agentPlans.push({
      agent,
      beforeAdapterConfigSha256: adapterConfigSha256(agent.adapterConfig),
      nextAdapterConfig: { ...adapterConfig, env: nextEnv },
    });
  }

  const internalStateSha256 = internalPlanStateSha256(allAgents, orderedGroups);
  const structureSha256 = publicPlanStructureSha256(allAgents, orderedGroups, agentPlans);
  return {
    allAgents,
    groups: orderedGroups,
    agentPlans,
    // HMAC binds the operator approval to plaintext-dependent CAS state without
    // publishing an offline-guessable low-entropy value hash.
    planSha256: hmacSha256(approvalKey, JSON.stringify({ structureSha256, internalStateSha256 })),
    planStructureSha256: structureSha256,
    internalPlanStateSha256: internalStateSha256,
  };
}

async function prepareSecretVersions(groups: InternalSecretGroup[], key: Buffer) {
  const prepared = new Map<string, ReturnType<typeof createLocalEncryptedVersionFromKey>>();
  for (const group of groups) {
    if (group.action === "reuse") continue;
    const version = createLocalEncryptedVersionFromKey(key, group.value);
    if (version.valueSha256 !== group.valueSha256) {
      throw new Error(`inline_secret_provider_fingerprint_invalid: name=${group.name}`);
    }
    prepared.set(group.key, version);
  }
  return prepared;
}

function buildExpectedPostState(
  plan: Awaited<ReturnType<typeof createPlan>>,
  prepared: Awaited<ReturnType<typeof prepareSecretVersions>>,
  key: Buffer,
): ExpectedPostState {
  return {
    agents: plan.agentPlans
      .map((mutation) => ({
        id: mutation.agent.id,
        adapterConfigHmacSha256: hmacSha256(
          key,
          stableJson(canonicalizeExpectedAdapterConfig(mutation.nextAdapterConfig)),
        ),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    secrets: plan.groups
      .map((group) => {
        const version = group.action === "reuse" ? group.expectedVersion : prepared.get(group.key);
        if (!version) throw new Error(`inline_secret_expected_version_missing: name=${group.name}`);
        const versionState = {
          secretId: group.id,
          version: group.version,
          material: version.material,
          valueSha256: version.valueSha256,
          revokedAt: null,
        };
        return {
          companyId: group.companyId,
          name: group.name,
          id: group.id,
          version: group.version,
          provider: "local_encrypted" as const,
          externalRef: null,
          versionStateHmacSha256: hmacSha256(key, stableJson(versionState)),
        };
      })
      .sort((left, right) => left.companyId.localeCompare(right.companyId) || left.name.localeCompare(right.name)),
  };
}

async function verifyExpectedPostState(db: Db, expected: ExpectedPostState, key: Buffer) {
  if (expected.secrets.length === 0) return false;
  const allAgents = await db.select({
    id: agents.id,
    companyId: agents.companyId,
    status: agents.status,
    adapterConfig: agents.adapterConfig,
    updatedAt: agents.updatedAt,
  }).from(agents);
  if (allAgents.some(hasInlineSensitiveBinding)) return false;
  const agentById = new Map(allAgents.map((agent) => [agent.id, agent]));
  for (const target of expected.agents) {
    const current = agentById.get(target.id);
    if (!current || hmacSha256(key, stableJson(current.adapterConfig)) !== target.adapterConfigHmacSha256) {
      return false;
    }
  }
  const ids = expected.secrets.map((secret) => secret.id);
  const [secretRows, versionRows] = await Promise.all([
    db.select().from(companySecrets).where(inArray(companySecrets.id, ids)),
    db.select().from(companySecretVersions).where(inArray(companySecretVersions.secretId, ids)),
  ]);
  const secretById = new Map(secretRows.map((secret) => [secret.id, secret]));
  for (const target of expected.secrets) {
    const secret = secretById.get(target.id);
    const version = versionRows.find((candidate) =>
      candidate.secretId === target.id && candidate.version === target.version);
    if (!secret || !version || secret.companyId !== target.companyId || secret.name !== target.name ||
        secret.provider !== target.provider || secret.externalRef !== target.externalRef ||
        secret.latestVersion !== target.version || version.revokedAt !== null) {
      return false;
    }
    const versionStateHmac = hmacSha256(key, stableJson({
      secretId: version.secretId,
      version: version.version,
      material: version.material,
      valueSha256: version.valueSha256,
      revokedAt: null,
    }));
    if (versionStateHmac !== target.versionStateHmacSha256) return false;
  }
  return true;
}

async function applyPlan(
  db: Db,
  plan: Awaited<ReturnType<typeof createPlan>>,
  prepared: Awaited<ReturnType<typeof prepareSecretVersions>>,
  options: InlineEnvSecretMigrationOptions,
  masterKey: Awaited<ReturnType<typeof loadMasterKeyBoundary>>,
  expectedPostState: ExpectedPostState | null,
) {
  const affectedAgentIds = plan.agentPlans.map((entry) => entry.agent.id);
  const companyIds = [...new Set(plan.groups.map((group) => group.companyId))];
  const names = [...new Set(plan.groups.map((group) => group.name))];
  const now = options.now ?? new Date();

  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(
      "LOCK TABLE companies, agents, heartbeat_runs, company_secrets, company_secret_versions IN SHARE ROW EXCLUSIVE MODE",
    ));
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"inline-env-secret-migration-v2"}))`);
    const lockedPlan = await createPlan(tx as unknown as Db, options, masterKey.key);
    if (lockedPlan.planSha256 !== plan.planSha256 ||
        lockedPlan.internalPlanStateSha256 !== plan.internalPlanStateSha256) {
      throw new Error(
        `inline_secret_full_plan_changed_under_lock: approved=${plan.planSha256} observed=${lockedPlan.planSha256}`,
      );
    }
    const lockedAgents = affectedAgentIds.length > 0
      ? await tx.select().from(agents).where(inArray(agents.id, affectedAgentIds)).for("update")
      : [];
    const activeRuns = affectedAgentIds.length > 0
      ? await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
          inArray(heartbeatRuns.agentId, affectedAgentIds),
          inArray(heartbeatRuns.status, ["queued", "running"]),
        )).for("update")
      : [];
    if (activeRuns.length > 0 || lockedAgents.some((agent) => agent.status === "running")) {
      throw new Error("inline_secret_active_execution");
    }
    const lockedSecrets = plan.groups.length > 0
      ? await tx.select().from(companySecrets).where(and(
          inArray(companySecrets.companyId, companyIds),
          inArray(companySecrets.name, names),
        )).for("update")
      : [];
    const lockedSecretIds = lockedSecrets.map((secret) => secret.id);
    const lockedVersions = lockedSecretIds.length > 0
      ? await tx.select().from(companySecretVersions)
          .where(inArray(companySecretVersions.secretId, lockedSecretIds)).for("update")
      : [];
    const currentSecretByKey = new Map(lockedSecrets.map((secret) => [groupKey(secret.companyId, secret.name), secret]));
    const currentVersionsBySecret = new Map<string, typeof companySecretVersions.$inferSelect[]>();
    for (const version of lockedVersions) {
      currentVersionsBySecret.set(version.secretId, [...(currentVersionsBySecret.get(version.secretId) ?? []), version]);
    }

    for (const group of plan.groups) {
      const current = currentSecretByKey.get(group.key) ?? null;
      if (group.action === "create") {
        if (current) throw new Error(`inline_secret_cas_secret_appeared: name=${group.name}`);
        const material = prepared.get(group.key);
        if (!material) throw new Error(`inline_secret_material_missing: name=${group.name}`);
        await tx.insert(companySecrets).values({
          id: group.id,
          companyId: group.companyId,
          name: group.name,
          provider: "local_encrypted",
          externalRef: material.externalRef,
          latestVersion: 1,
          description: "Canonical encrypted environment secret migrated from inline agent configuration",
          createdByUserId: "inline-env-secret-migration",
        });
        await tx.insert(companySecretVersions).values({
          secretId: group.id,
          version: 1,
          material: material.material,
          valueSha256: material.valueSha256,
          createdByUserId: "inline-env-secret-migration",
        });
        continue;
      }

      const expected = group.expectedSecret;
      if (!current || !expected || current.id !== expected.id ||
          current.provider !== expected.provider || current.latestVersion !== expected.latestVersion) {
        throw new Error(`inline_secret_cas_secret_changed: name=${group.name}`);
      }
      const currentVersion = (currentVersionsBySecret.get(current.id) ?? [])
        .find((version) => version.version === current.latestVersion) ?? null;
      if (group.action === "reuse") {
        if (!currentVersion || currentVersion.revokedAt !== null ||
            currentVersion.valueSha256 !== group.valueSha256) {
          throw new Error(`inline_secret_cas_fingerprint_changed: name=${group.name}`);
        }
        continue;
      }

      const expectedVersion = group.expectedVersion;
      if ((currentVersion?.id ?? null) !== (expectedVersion?.id ?? null) ||
          (currentVersion?.valueSha256 ?? null) !== (expectedVersion?.valueSha256 ?? null) ||
          (currentVersion?.revokedAt?.getTime() ?? null) !== (expectedVersion?.revokedAt?.getTime() ?? null)) {
        throw new Error(`inline_secret_cas_rotation_source_changed: name=${group.name}`);
      }
      const material = prepared.get(group.key);
      if (!material) throw new Error(`inline_secret_material_missing: name=${group.name}`);
      await tx.insert(companySecretVersions).values({
        secretId: current.id,
        version: group.version,
        material: material.material,
        valueSha256: material.valueSha256,
        createdByUserId: "inline-env-secret-migration",
      });
      const rotated = await tx.update(companySecrets).set({
        latestVersion: group.version,
        externalRef: material.externalRef,
        updatedAt: now,
      }).where(and(
        eq(companySecrets.id, current.id),
        eq(companySecrets.latestVersion, expected.latestVersion),
      )).returning({ id: companySecrets.id });
      if (rotated.length !== 1) throw new Error(`inline_secret_cas_rotation_lost: name=${group.name}`);
    }

    await options.testHooks?.afterSecretWrites?.();
    const lockedAgentById = new Map(lockedAgents.map((agent) => [agent.id, agent]));
    const secrets = secretService(tx as unknown as Db);
    for (const mutation of plan.agentPlans) {
      const current = lockedAgentById.get(mutation.agent.id);
      if (!current || current.updatedAt.getTime() !== mutation.agent.updatedAt.getTime() ||
          adapterConfigSha256(current.adapterConfig) !== mutation.beforeAdapterConfigSha256) {
        throw new Error(`inline_secret_cas_agent_changed: agent=${mutation.agent.id}`);
      }
      const normalized = await secrets.normalizeAdapterConfigForPersistence(
        mutation.agent.companyId,
        mutation.nextAdapterConfig,
        { strictMode: true },
      );
      const updated = await tx.update(agents).set({ adapterConfig: normalized, updatedAt: now })
        // The row is already held FOR UPDATE and its exact preimage was
        // compared above. Avoid a timestamp predicate here: PostgreSQL can
        // retain sub-millisecond precision that a JavaScript Date cannot
        // round-trip, producing a false CAS miss on an unchanged row.
        .where(eq(agents.id, mutation.agent.id))
        .returning({ id: agents.id });
      if (updated.length !== 1) {
        throw new Error(`inline_secret_cas_agent_update_lost: agent=${mutation.agent.id}`);
      }
    }

    const postAgents = affectedAgentIds.length > 0
      ? await tx.select({ id: agents.id, companyId: agents.companyId, adapterConfig: agents.adapterConfig })
          .from(agents).where(inArray(agents.id, affectedAgentIds))
      : [];
    for (const agent of postAgents) {
      const env = asRecord(asRecord(agent.adapterConfig)?.env);
      if (!env) continue;
      for (const [name, binding] of Object.entries(env)) {
        const group = plan.groups.find((candidate) =>
          candidate.companyId === agent.companyId && candidate.name === name);
        if (!group || !group.agentIds.has(agent.id)) continue;
        const record = asRecord(binding);
        if (record?.type !== "secret_ref" || record.secretId !== group.id || record.version !== "latest") {
          throw new Error(`inline_secret_postcheck_failed: agent=${agent.id} name=${name}`);
        }
      }
    }
    await options.testHooks?.beforeCommit?.();
    await revalidateMasterKeyBoundary(masterKey);
    if (expectedPostState && !await verifyExpectedPostState(tx as unknown as Db, expectedPostState, masterKey.key)) {
      throw new Error("inline_secret_post_state_mismatch");
    }
  }, { isolationLevel: "serializable", accessMode: "read write" });
}

function makeReceipt(input: {
  mode: "dry_run" | "apply_intent" | "apply";
  status: "OK" | "READY";
  now: Date;
  runId: string;
  plan: Awaited<ReturnType<typeof createPlan>>;
  backup: null | { path: string; sha256: string; sizeBytes: number; mode: string };
  intent?: { path: string; sha256: string };
}) {
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    mode: input.mode,
    status: input.status,
    runId: input.runId,
    observedAt: input.now.toISOString(),
    planSha256: input.plan.planSha256,
    summary: receiptSummary(input.plan.allAgents.length, input.plan.agentPlans, input.plan.groups),
    secrets: publicSecretEntries(input.plan.groups),
    databaseBackup: input.backup,
    intentReceipt: input.intent ?? null,
    safety: {
      dryRunDefault: true,
      canonicalIdentity: "exact company_id plus case-sensitive environment key",
      valuesRecorded: false,
      valueFingerprintsRecorded: false,
      processEnvironmentReadByNameOnly: true,
      transaction: input.mode === "dry_run" ? null : "serializable with advisory, table, row, and adapter-config CAS locks",
    },
  };
}

function jsonReceiptSha256(value: unknown) {
  return sha256(`${JSON.stringify(value, null, 2)}\n`);
}

async function readImmutableReceiptFile(filePath: string, maxBytes = 2 * 1024 * 1024) {
  const leaf = await lstat(filePath);
  const currentUid = typeof process.geteuid === "function" ? process.geteuid() : null;
  if (!leaf.isFile() || leaf.isSymbolicLink() || leaf.size < 1 || leaf.size > maxBytes ||
      (leaf.mode & 0o777) !== 0o444 || (currentUid !== null && leaf.uid !== currentUid)) {
    throw new Error("inline_secret_committed_receipt_not_immutable");
  }
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== leaf.dev || before.ino !== leaf.ino ||
        before.uid !== leaf.uid || before.mode !== leaf.mode || before.size !== leaf.size ||
        before.mtimeMs !== leaf.mtimeMs) {
      throw new Error("inline_secret_committed_receipt_changed");
    }
    const bytes = await handle.readFile();
    const [after, pathAfter] = await Promise.all([handle.stat(), lstat(filePath)]);
    if (after.dev !== before.dev || after.ino !== before.ino || after.uid !== before.uid ||
        after.mode !== before.mode || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
        pathAfter.isSymbolicLink() || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino ||
        pathAfter.mode !== before.mode || pathAfter.size !== before.size || pathAfter.mtimeMs !== before.mtimeMs ||
        bytes.length !== before.size) {
      throw new Error("inline_secret_committed_receipt_changed");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function validateImmutableReceiptFile(filePath: string, expectedSha256: string, expectedValue?: unknown) {
  const bytes = await readImmutableReceiptFile(filePath);
  const observed = createHash("sha256").update(bytes).digest("hex");
  if (!safeHexEqual(observed, expectedSha256)) {
    throw new Error("inline_secret_committed_receipt_hash_mismatch");
  }
  if (expectedValue !== undefined && bytes.toString("utf8") !== `${JSON.stringify(expectedValue, null, 2)}\n`) {
    throw new Error("inline_secret_committed_receipt_content_mismatch");
  }
  return bytes;
}

function parseExpectedPostState(value: unknown): ExpectedPostState | null {
  const record = asRecord(value);
  if (!record || !exactKeys(record, ["agents", "secrets"]) ||
      !Array.isArray(record.agents) || !Array.isArray(record.secrets) || record.secrets.length === 0) {
    return null;
  }
  const agentsState = record.agents.map(asRecord);
  const secretsState = record.secrets.map(asRecord);
  if (agentsState.some((entry) => !entry || !exactKeys(entry, ["id", "adapterConfigHmacSha256"]) ||
      typeof entry.id !== "string" ||
      typeof entry.adapterConfigHmacSha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.adapterConfigHmacSha256)) ||
      secretsState.some((entry) => !entry || !exactKeys(entry, [
        "companyId", "name", "id", "version", "provider", "externalRef", "versionStateHmacSha256",
      ]) || typeof entry.companyId !== "string" ||
        typeof entry.name !== "string" || typeof entry.id !== "string" ||
        !Number.isInteger(entry.version) || Number(entry.version) < 1 ||
        entry.provider !== "local_encrypted" || entry.externalRef !== null ||
        typeof entry.versionStateHmacSha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.versionStateHmacSha256))) {
    return null;
  }
  const agentIds = agentsState.map((entry) => String(entry!.id));
  const secretIds = secretsState.map((entry) => String(entry!.id));
  const secretKeys = secretsState.map((entry) => groupKey(String(entry!.companyId), String(entry!.name)));
  if (new Set(agentIds).size !== agentIds.length || new Set(secretIds).size !== secretIds.length ||
      new Set(secretKeys).size !== secretKeys.length) return null;
  return {
    agents: agentsState.map((entry) => ({
      id: String(entry!.id),
      adapterConfigHmacSha256: String(entry!.adapterConfigHmacSha256),
    })),
    secrets: secretsState.map((entry) => ({
      companyId: String(entry!.companyId),
      name: String(entry!.name),
      id: String(entry!.id),
      version: Number(entry!.version),
      provider: "local_encrypted",
      externalRef: null,
      versionStateHmacSha256: String(entry!.versionStateHmacSha256),
    })),
  };
}

function exactKeys(record: JsonRecord, expected: string[]) {
  return JSON.stringify(Object.keys(record).sort()) === JSON.stringify([...expected].sort());
}

function isPathDirectlyInside(root: string, candidate: string) {
  return path.dirname(candidate) === root && candidate !== root;
}

function parseReceiptSummary(value: unknown) {
  const summary = asRecord(value);
  const keys = [
    "scannedAgentCount", "changedAgentCount", "canonicalSecretCount", "createCount",
    "reuseCount", "rotateCount", "importedSecretCount",
  ];
  if (!summary || !exactKeys(summary, keys) ||
      keys.some((key) => !Number.isInteger(summary[key]) || Number(summary[key]) < 0)) return null;
  return summary;
}

function parsePublicSecretEntries(value: unknown) {
  if (!Array.isArray(value)) return null;
  const entries = value.map(asRecord);
  if (entries.some((entry) => !entry || !exactKeys(entry, ["companyId", "name", "id", "version", "action"]) ||
      typeof entry.companyId !== "string" || typeof entry.name !== "string" || typeof entry.id !== "string" ||
      !Number.isInteger(entry.version) || Number(entry.version) < 1 ||
      !["create", "reuse", "rotate"].includes(String(entry.action)))) return null;
  const identities = entries.map((entry) => `${entry!.companyId}\u0000${entry!.name}\u0000${entry!.id}`);
  if (new Set(identities).size !== identities.length) return null;
  return entries as JsonRecord[];
}

function parseBackupEvidence(value: unknown) {
  const backup = asRecord(value);
  if (!backup || !exactKeys(backup, ["path", "sha256", "sizeBytes", "mode"]) ||
      typeof backup.path !== "string" || !path.isAbsolute(backup.path) ||
      typeof backup.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(backup.sha256) ||
      !Number.isInteger(backup.sizeBytes) || Number(backup.sizeBytes) < 1 || backup.mode !== "0400") return null;
  return {
    path: backup.path,
    sha256: backup.sha256,
    sizeBytes: Number(backup.sizeBytes),
    mode: "0400",
  };
}

function validReceiptSafety(value: unknown, mode: "apply_intent" | "apply") {
  const safety = asRecord(value);
  return Boolean(safety && exactKeys(safety, [
    "dryRunDefault", "canonicalIdentity", "valuesRecorded", "valueFingerprintsRecorded",
    "processEnvironmentReadByNameOnly", "transaction",
  ]) && safety.dryRunDefault === true &&
    safety.canonicalIdentity === "exact company_id plus case-sensitive environment key" &&
    safety.valuesRecorded === false && safety.valueFingerprintsRecorded === false &&
    safety.processEnvironmentReadByNameOnly === true &&
    safety.transaction === "serializable with advisory, table, row, and adapter-config CAS locks" &&
    (mode === "apply" || mode === "apply_intent"));
}

function receiptIdentityEntries(entries: JsonRecord[]) {
  return entries
    .map((entry) => ({
      companyId: entry.companyId,
      name: entry.name,
      id: entry.id,
      version: entry.version,
    }))
    .sort((left, right) => String(left.companyId).localeCompare(String(right.companyId)) ||
      String(left.name).localeCompare(String(right.name)) || String(left.id).localeCompare(String(right.id)));
}

async function reconcileFromRecoveryReceipts(
  db: Db,
  expectedPlanSha256: string,
  receiptRoot: string,
  backupRoot: string,
  writer: typeof writeImmutableJsonReceipt,
  options: InlineEnvSecretMigrationOptions,
  approvalKey: Buffer,
) {
  const requestedImportNames = [...new Set(options.importEnvNames ?? [])].sort();
  const canonicalRoot = path.resolve(receiptRoot);
  const names = (await readdir(canonicalRoot)).filter((name) => name.endsWith("-recovery.json")).sort().reverse();
  for (const name of names) {
    const recoveryPath = path.join(canonicalRoot, name);
    let recovery: JsonRecord;
    try {
      recovery = asRecord(JSON.parse((await readImmutableReceiptFile(recoveryPath)).toString("utf8"))) ?? {};
    } catch {
      throw new Error("inline_secret_recovery_receipt_invalid");
    }
    if (!exactKeys(recovery, [
      "schemaVersion", "mode", "status", "runId", "observedAt", "planSha256", "intentReceipt",
      "resultReceiptJson", "resultReceiptPath", "resultReceiptSha256", "importCompanyId", "importEnvNames",
      "importApprovalHmac", "expectedPostState", "safety", "recoveryHmacSha256",
    ])) throw new Error("inline_secret_recovery_receipt_invalid");
    const recoveryHmac = typeof recovery.recoveryHmacSha256 === "string" ? recovery.recoveryHmacSha256 : "";
    const { recoveryHmacSha256: _ignored, ...unsigned } = recovery;
    const recoverySafety = asRecord(recovery.safety);
    if (recovery.schemaVersion !== RECOVERY_SCHEMA_VERSION || recovery.mode !== "precommit_recovery" ||
        recovery.status !== "READY" || typeof recovery.runId !== "string" || !recovery.runId ||
        typeof recovery.observedAt !== "string" || Number.isNaN(Date.parse(recovery.observedAt)) ||
        typeof recovery.planSha256 !== "string" || !/^[a-f0-9]{64}$/.test(recovery.planSha256) ||
        !safeHexEqual(recoveryHmac, hmacSha256(approvalKey, stableJson(unsigned))) ||
        !recoverySafety || !exactKeys(recoverySafety, [
          "valuesRecorded", "valueFingerprintsRecorded", "tenantVisibleDatabaseMarkerWritten",
        ]) || recoverySafety.valuesRecorded !== false || recoverySafety.valueFingerprintsRecorded !== false ||
        recoverySafety.tenantVisibleDatabaseMarkerWritten !== false) {
      throw new Error("inline_secret_recovery_receipt_invalid");
    }
    if (recovery.planSha256 !== expectedPlanSha256) continue;
    const importNames = Array.isArray(recovery.importEnvNames)
      ? recovery.importEnvNames
      : [];
    if (importNames.some((value) => typeof value !== "string") ||
        JSON.stringify(importNames) !== JSON.stringify(requestedImportNames) ||
        recovery.importCompanyId !== (options.importCompanyId ?? null) ||
        typeof recovery.importApprovalHmac !== "string" ||
        !safeHexEqual(recovery.importApprovalHmac, importApprovalHmac(options, approvalKey))) {
      throw new Error("inline_secret_recovery_import_mismatch");
    }
    const expectedPostState = parseExpectedPostState(recovery.expectedPostState);
    if (!expectedPostState) throw new Error("inline_secret_recovery_post_state_invalid");
    const resultJson = typeof recovery.resultReceiptJson === "string" ? recovery.resultReceiptJson : "";
    const resultPath = typeof recovery.resultReceiptPath === "string" ? path.resolve(recovery.resultReceiptPath) : "";
    const resultSha256 = typeof recovery.resultReceiptSha256 === "string" ? recovery.resultReceiptSha256 : "";
    const intent = asRecord(recovery.intentReceipt);
    let result: JsonRecord | null = null;
    try {
      result = asRecord(JSON.parse(resultJson));
    } catch {
      result = null;
    }
    const resultSecrets = parsePublicSecretEntries(result?.secrets);
    const resultBackup = parseBackupEvidence(result?.databaseBackup);
    const resultIntent = asRecord(result?.intentReceipt);
    if (!result || !exactKeys(result, [
      "schemaVersion", "mode", "status", "runId", "observedAt", "planSha256", "summary",
      "secrets", "databaseBackup", "intentReceipt", "safety",
    ]) || result.schemaVersion !== RECEIPT_SCHEMA_VERSION || result.mode !== "apply" || result.status !== "OK" ||
        result.planSha256 !== expectedPlanSha256 || result.runId !== recovery.runId ||
        result.observedAt !== recovery.observedAt || !parseReceiptSummary(result.summary) ||
        !validReceiptSafety(result.safety, "apply") || !resultSecrets || !resultBackup ||
        !resultIntent || !exactKeys(resultIntent, ["path", "sha256"]) ||
        typeof resultIntent.path !== "string" || typeof resultIntent.sha256 !== "string" ||
        !safeHexEqual(resultSha256, sha256(resultJson)) ||
        resultJson !== `${JSON.stringify(result, null, 2)}\n` ||
        !intent || !exactKeys(intent, ["path", "sha256"]) ||
        typeof intent.path !== "string" || typeof intent.sha256 !== "string" ||
        stableJson(resultIntent) !== stableJson(intent) ||
        stableJson(receiptIdentityEntries(resultSecrets)) !== stableJson(expectedPostState.secrets.map((secret) => ({
          companyId: secret.companyId, name: secret.name, id: secret.id, version: secret.version,
        })))) {
      throw new Error("inline_secret_recovery_result_invalid");
    }
    const intentPath = path.resolve(intent.path);
    if (!isPathDirectlyInside(canonicalRoot, resultPath) || !isPathDirectlyInside(canonicalRoot, intentPath) ||
        !resultPath.endsWith("-applied.json") || !intentPath.endsWith("-intent.json")) {
      throw new Error("inline_secret_recovery_receipt_escaped_root");
    }
    const intentBytes = await validateImmutableReceiptFile(intentPath, intent.sha256);
    const intentReceipt = asRecord(JSON.parse(intentBytes.toString("utf8")));
    const intentSecrets = parsePublicSecretEntries(intentReceipt?.secrets);
    const intentBackup = parseBackupEvidence(intentReceipt?.databaseBackup);
    if (!intentReceipt || !exactKeys(intentReceipt, [
      "schemaVersion", "mode", "status", "runId", "observedAt", "planSha256", "summary",
      "secrets", "databaseBackup", "intentReceipt", "safety",
    ]) || intentReceipt.schemaVersion !== RECEIPT_SCHEMA_VERSION ||
        intentReceipt.mode !== "apply_intent" || intentReceipt.status !== "READY" ||
        intentReceipt.planSha256 !== expectedPlanSha256 || intentReceipt.runId !== recovery.runId ||
        intentReceipt.observedAt !== recovery.observedAt || intentReceipt.intentReceipt !== null ||
        !parseReceiptSummary(intentReceipt.summary) || !validReceiptSafety(intentReceipt.safety, "apply_intent") ||
        !intentSecrets || !intentBackup ||
        stableJson(intentReceipt.summary) !== stableJson(result.summary) ||
        stableJson(intentSecrets) !== stableJson(resultSecrets) ||
        stableJson(intentBackup) !== stableJson(resultBackup)) {
      throw new Error("inline_secret_recovery_intent_invalid");
    }
    const observedBackup = await secureBackupFile(resultBackup.path, backupRoot);
    if (stableJson(observedBackup) !== stableJson(resultBackup)) {
      throw new Error("inline_secret_recovery_backup_invalid");
    }
    if (!await verifyExpectedPostState(db, expectedPostState, approvalKey)) continue;
    try {
      const writtenSha = await writer(resultPath, result);
      if (!safeHexEqual(writtenSha, resultSha256)) throw new Error("inline_secret_reconciled_receipt_hash_mismatch");
    } catch (error) {
      const filesystemError = error as NodeJS.ErrnoException;
      if (filesystemError.code !== "EEXIST") throw error;
    }
    await validateImmutableReceiptFile(resultPath, resultSha256, result);
    return { ...result, receiptPath: resultPath, receiptSha256: resultSha256, reconciled: true };
  }
  return null;
}

export async function runInlineEnvSecretMigration(db: Db, options: InlineEnvSecretMigrationOptions = {}) {
  const apply = options.apply === true;
  const now = options.now ?? new Date();
  const masterKey = await loadMasterKeyBoundary(options.masterKeyFilePath);
  try {
    const paths = await prepareInstancePaths(options);
    const receiptWriter = options.receiptWriter ?? writeImmutableJsonReceipt;
    if (apply) {
      if (!options.expectedPlanSha256 || !/^[a-f0-9]{64}$/.test(options.expectedPlanSha256)) {
        throw new Error("inline_secret_expected_plan_required_for_apply");
      }
      const reconciled = await reconcileFromRecoveryReceipts(
        db,
        options.expectedPlanSha256,
        paths.receiptRoot,
        paths.backupDir,
        receiptWriter,
        options,
        masterKey.key,
      );
      if (reconciled) return reconciled;
    }
    const plan = await createPlan(db, options, masterKey.key);
    const runId = randomUUID();
    const basename = `${receiptTimestamp(now)}-${runId}-inline-env-secret-migration`;
    if (!apply) {
      const receipt = makeReceipt({ mode: "dry_run", status: "OK", now, runId, plan, backup: null });
      const receiptPath = path.join(paths.receiptRoot, `${basename}-dry-run.json`);
      const receiptSha256 = await receiptWriter(receiptPath, receipt);
      return { ...receipt, receiptPath, receiptSha256 };
    }
    if (!options.connectionString) throw new Error("inline_secret_database_url_required_for_apply");
    if (options.expectedPlanSha256 !== plan.planSha256) {
      throw new Error(`inline_secret_plan_approval_mismatch: expected=${options.expectedPlanSha256} observed=${plan.planSha256}`);
    }
    if (options.maintenanceAcknowledged !== true) {
      throw new Error(`inline_secret_maintenance_ack_required: set ${INLINE_SECRET_MIGRATION_MAINTENANCE_ENV}=${MAINTENANCE_ACK}`);
    }
    const migrationState = await inspectMigrations(options.connectionString);
    if (migrationState.status !== "upToDate") {
      throw new Error(`inline_secret_pending_database_migrations: ${migrationState.pendingMigrations.join(",")}`);
    }
    const backupResult = options.backupRunner
      ? await options.backupRunner({ connectionString: options.connectionString, backupDir: paths.backupDir })
      : await runDatabaseBackup({
          connectionString: options.connectionString,
          backupDir: paths.backupDir,
          retentionDays: 36_500,
          filenamePrefix: "paperclip-pre-inline-env-secret-migration",
          compression: "gzip",
          includeMigrationJournal: true,
        });
    const backup = await secureBackupFile(backupResult.backupFile, paths.backupDir);
    const intent = makeReceipt({ mode: "apply_intent", status: "READY", now, runId, plan, backup });
    const intentPath = path.join(paths.receiptRoot, `${basename}-intent.json`);
    const intentSha256 = await receiptWriter(intentPath, intent);
    const prepared = await prepareSecretVersions(plan.groups, masterKey.key);
    const intentRef = { path: intentPath, sha256: intentSha256 };
    const receipt = makeReceipt({ mode: "apply", status: "OK", now, runId, plan, backup, intent: intentRef });
    const receiptPath = path.join(paths.receiptRoot, `${basename}-applied.json`);
    const receiptSha256 = jsonReceiptSha256(receipt);
    let expectedPostState: ExpectedPostState | null = null;
    if (plan.groups.length > 0) {
      expectedPostState = buildExpectedPostState(plan, prepared, masterKey.key);
      const unsignedRecovery = {
        schemaVersion: RECOVERY_SCHEMA_VERSION,
        mode: "precommit_recovery",
        status: "READY",
        runId,
        observedAt: now.toISOString(),
        planSha256: plan.planSha256,
        intentReceipt: intentRef,
        resultReceiptJson: `${JSON.stringify(receipt, null, 2)}\n`,
        resultReceiptPath: receiptPath,
        resultReceiptSha256: receiptSha256,
        importCompanyId: options.importCompanyId ?? null,
        importEnvNames: [...new Set(options.importEnvNames ?? [])].sort(),
        importApprovalHmac: importApprovalHmac(options, masterKey.key),
        expectedPostState,
        safety: {
          valuesRecorded: false,
          valueFingerprintsRecorded: false,
          tenantVisibleDatabaseMarkerWritten: false,
        },
      };
      const recovery = {
        ...unsignedRecovery,
        recoveryHmacSha256: hmacSha256(masterKey.key, stableJson(unsignedRecovery)),
      };
      await receiptWriter(path.join(paths.receiptRoot, `${basename}-recovery.json`), recovery);
    }
    await options.testHooks?.beforeTransaction?.();
    await revalidateMasterKeyBoundary(masterKey);
    await applyPlan(db, plan, prepared, options, masterKey, expectedPostState);
    try {
      const writtenSha256 = await receiptWriter(receiptPath, receipt);
      if (writtenSha256 !== receiptSha256) throw new Error("inline_secret_final_receipt_hash_mismatch");
      return { ...receipt, receiptPath, receiptSha256: writtenSha256 };
    } catch (error) {
      throw new Error(
        `inline_secret_final_receipt_failed_after_commit: rerun safely to reconcile; intent=${intentPath}; ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } finally {
    masterKey.key.fill(0);
  }
}

function readOperand(argv: string[], flag: string, index: number) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseInlineEnvSecretMigrationArgs(rawArgv: string[]): InlineEnvSecretMigrationCliOptions {
  const argv = rawArgv[0] === "--" ? rawArgv.slice(1) : rawArgv;
  const options: InlineEnvSecretMigrationCliOptions = {
    apply: false,
    importEnvNames: [],
    rotateImportedSecrets: false,
    help: false,
  };
  let explicitlyDryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--apply") options.apply = true;
    else if (arg === "--dry-run") explicitlyDryRun = true;
    else if (arg === "--import-env") options.importEnvNames.push(readOperand(argv, arg, ++index));
    else if (arg === "--company-id") options.importCompanyId = readOperand(argv, arg, ++index);
    else if (arg === "--rotate-imported-secrets") options.rotateImportedSecrets = true;
    else if (arg === "--expected-plan-sha256") options.expectedPlanSha256 = readOperand(argv, arg, ++index);
    else if (arg === "--home") options.homeDir = readOperand(argv, arg, ++index);
    else if (arg === "--instance-id") options.instanceId = readOperand(argv, arg, ++index);
    else if (arg === "--receipt-dir") options.receiptDir = readOperand(argv, arg, ++index);
    else if (arg === "--backup-dir") options.backupDir = readOperand(argv, arg, ++index);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error("inline_secret_argument_invalid");
  }
  if (options.apply && explicitlyDryRun) throw new Error("--apply and --dry-run are mutually exclusive");
  options.importEnvNames = [...new Set(options.importEnvNames)];
  if (options.importEnvNames.length > 0 && !options.importCompanyId) {
    throw new Error("--company-id is required with --import-env");
  }
  if (options.importCompanyId && options.importEnvNames.length === 0) {
    throw new Error("--company-id is valid only with --import-env");
  }
  if (options.rotateImportedSecrets && options.importEnvNames.length === 0) {
    throw new Error("--rotate-imported-secrets requires --import-env");
  }
  if (options.apply && (!options.expectedPlanSha256 || !/^[a-f0-9]{64}$/.test(options.expectedPlanSha256))) {
    throw new Error("--apply requires --expected-plan-sha256 <lowercase-sha256>");
  }
  if (!options.apply && options.expectedPlanSha256) {
    throw new Error("--expected-plan-sha256 is valid only with --apply");
  }
  return options;
}

export const INLINE_ENV_SECRET_MIGRATION_USAGE = [
  "Usage: pnpm secrets:migrate-inline-env [--dry-run | --apply --expected-plan-sha256 <sha256>]",
  "       [--company-id <uuid> --import-env <ENV_NAME> ... [--rotate-imported-secrets]]",
  "       [--home <path>] [--instance-id <id>] [--receipt-dir <instance-relative-path>]",
  "       [--backup-dir <path>]",
  "",
  "Imported secret values are read only from the inherited process environment, never argv or files.",
  "Database connection strings are never accepted through argv.",
  `Apply also requires ${INLINE_SECRET_MIGRATION_MAINTENANCE_ENV}=${MAINTENANCE_ACK}.`,
].join("\n");

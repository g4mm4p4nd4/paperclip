import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SecretProviderModule, StoredSecretVersionMaterial } from "./types.js";
import { badRequest } from "../errors.js";

interface LocalEncryptedMaterial extends StoredSecretVersionMaterial {
  scheme: "local_encrypted_v1";
  iv: string;
  tag: string;
  ciphertext: string;
}

type TrustedDirectorySnapshot = {
  path: string;
  dev: number;
  ino: number;
  uid: number;
  mode: number;
};

type WindowsAclTarget = {
  path: string;
  ownerSid: string;
  currentSid: string;
  unexpectedAllowSids: string[];
};

const WINDOWS_SYSTEM_SID = "S-1-5-18";
const WINDOWS_ADMINISTRATORS_SID = "S-1-5-32-544";

export function validateWindowsMasterKeyAclEvidence(
  keyPath: string,
  userRoot: string,
  evidence: WindowsAclTarget[],
  includeKey = true,
) {
  const relative = path.relative(userRoot, keyPath);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw badRequest(`Secrets master key must remain inside the selected Windows user root: ${keyPath}`);
  }
  const expectedTargets = new Set(windowsMasterKeyAclTargets(keyPath, userRoot, includeKey));
  if (evidence.length !== expectedTargets.size || evidence.some((entry) => !expectedTargets.delete(entry.path)) ||
      expectedTargets.size !== 0) {
    throw badRequest(`Incomplete Windows ACL evidence for secrets master key at ${keyPath}`);
  }
  for (const entry of evidence) {
    const allowed = new Set([entry.currentSid, WINDOWS_SYSTEM_SID, WINDOWS_ADMINISTRATORS_SID]);
    if (!entry.currentSid.startsWith("S-") || !allowed.has(entry.ownerSid) ||
        entry.unexpectedAllowSids.length > 0) {
      throw badRequest(`Unsafe Windows ACL for secrets master key at ${entry.path}`);
    }
  }
}

export function windowsMasterKeyAclTargets(keyPath: string, userRoot: string, includeKey = true) {
  const targets = [userRoot];
  const parent = path.dirname(keyPath);
  const relativeParent = path.relative(userRoot, parent);
  if (relativeParent === ".." || relativeParent.startsWith(`..${path.sep}`) || path.isAbsolute(relativeParent)) {
    throw badRequest(`Secrets master key must remain inside the selected Windows user root: ${keyPath}`);
  }
  let current = userRoot;
  for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    targets.push(current);
  }
  if (includeKey) targets.push(keyPath);
  return targets;
}

function verifyWindowsMasterKeyAcl(keyPath: string, includeKey = true) {
  const configuredHome = process.env.PAPERCLIP_HOME?.trim();
  const userRoot = realpathSync(path.resolve(configuredHome || os.homedir()));
  const targets = windowsMasterKeyAclTargets(keyPath, userRoot, includeKey);
  const systemRoot = process.env.SystemRoot?.trim() || process.env.WINDIR?.trim();
  if (!systemRoot || !path.isAbsolute(systemRoot)) {
    throw badRequest(`Unable to resolve canonical Windows PowerShell for secrets master key at ${keyPath}`);
  }
  const powershellCandidate = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  let powershell: string;
  try {
    powershell = realpathSync(powershellCandidate);
  } catch {
    throw badRequest(`Unable to resolve canonical Windows PowerShell for secrets master key at ${keyPath}`);
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    "$targets=@(ConvertFrom-Json $env:PAPERCLIP_ACL_TARGETS)",
    "$current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$allowed=@($current,'S-1-5-18','S-1-5-32-544')",
    "$results=foreach($target in $targets){",
    "  $acl=Get-Acl -LiteralPath $target",
    "  $owner=([System.Security.Principal.NTAccount]$acl.Owner).Translate([System.Security.Principal.SecurityIdentifier]).Value",
    "  $bad=@($acl.Access | Where-Object {$_.AccessControlType -eq 'Allow'} | ForEach-Object {$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value} | Where-Object {$allowed -notcontains $_} | Sort-Object -Unique)",
    "  [pscustomobject]@{path=$target;ownerSid=$owner;currentSid=$current;unexpectedAllowSids=@($bad)}",
    "}",
    "ConvertTo-Json -InputObject @($results) -Compress",
  ].join(";");
  let evidence: WindowsAclTarget[];
  try {
    const stdout = execFileSync(powershell, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script,
    ], {
      env: {
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        PAPERCLIP_ACL_TARGETS: JSON.stringify(targets),
      },
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    });
    const parsed = JSON.parse(stdout) as unknown;
    evidence = (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => {
      const row = entry as Partial<WindowsAclTarget>;
      if (typeof row.path !== "string" || typeof row.ownerSid !== "string" ||
          typeof row.currentSid !== "string" || !Array.isArray(row.unexpectedAllowSids) ||
          row.unexpectedAllowSids.some((sid) => typeof sid !== "string")) {
        throw new Error("invalid_acl_evidence");
      }
      return row as WindowsAclTarget;
    });
  } catch {
    throw badRequest(`Unable to verify Windows ACL for secrets master key at ${keyPath}`);
  }
  validateWindowsMasterKeyAclEvidence(keyPath, userRoot, evidence, includeKey);
}

function resolveMasterKeyFilePath() {
  const fromEnv = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const resolved = path.resolve(
    fromEnv && fromEnv.trim().length > 0 ? fromEnv.trim() : path.join(process.cwd(), "data/secrets/master.key"),
  );
  // Darwin exposes /var and /tmp as OS-owned aliases into /private. Normalize
  // only those exact platform aliases; arbitrary symlink components remain
  // forbidden by the hierarchy and descriptor checks below.
  if (process.platform === "darwin") {
    if (resolved === "/var" || resolved.startsWith("/var/")) return "/private" + resolved;
    if (resolved === "/tmp" || resolved.startsWith("/tmp/")) return "/private" + resolved;
  }
  return resolved;
}

function decodeMasterKey(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (/^[A-Fa-f0-9]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  try {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === 32) return decoded;
  } catch {
    // ignored
  }

  if (Buffer.byteLength(trimmed, "utf8") === 32) {
    return Buffer.from(trimmed, "utf8");
  }
  return null;
}

function trustedKeyDirectoryHierarchy(keyPath: string): TrustedDirectorySnapshot[] {
  const directory = path.dirname(keyPath);
  const parsed = path.parse(directory);
  const components = [parsed.root];
  let current = parsed.root;
  for (const segment of directory.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    components.push(current);
  }
  const currentUid = typeof process.geteuid === "function" ? process.geteuid() : null;
  const snapshots = components.map((component) => {
    let metadata;
    try {
      metadata = lstatSync(component);
    } catch {
      throw badRequest(`Unsafe secrets master key directory at ${component}`);
    }
    const windows = process.platform === "win32";
    const rootOwnedSticky = !windows && metadata.uid === 0 && (metadata.mode & 0o1000) !== 0;
    const trustedOwner = windows || currentUid === null || metadata.uid === currentUid || metadata.uid === 0;
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || !trustedOwner ||
        (!windows && (metadata.mode & 0o022) !== 0 && !rootOwnedSticky) || realpathSync(component) !== component) {
      throw badRequest(`Unsafe secrets master key directory at ${component}`);
    }
    return {
      path: component,
      dev: metadata.dev,
      ino: metadata.ino,
      uid: metadata.uid,
      mode: metadata.mode,
    };
  });
  const leaf = snapshots.at(-1)!;
  if (process.platform !== "win32" && currentUid !== null && leaf.uid !== currentUid) {
    throw badRequest(`Unsafe secrets master key directory at ${directory}`);
  }
  return snapshots;
}

function revalidateKeyDirectoryHierarchy(snapshots: TrustedDirectorySnapshot[]) {
  for (const snapshot of snapshots) {
    let metadata;
    try {
      metadata = lstatSync(snapshot.path);
    } catch {
      throw badRequest(`Secrets master key directory changed at ${snapshot.path}`);
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
        metadata.dev !== snapshot.dev || metadata.ino !== snapshot.ino ||
        metadata.uid !== snapshot.uid || metadata.mode !== snapshot.mode ||
        realpathSync(snapshot.path) !== snapshot.path) {
      throw badRequest(`Secrets master key directory changed at ${snapshot.path}`);
    }
  }
}

function readExistingMasterKey(keyPath: string): Buffer {
  const hierarchy = trustedKeyDirectoryHierarchy(keyPath);
  let before;
  try {
    before = lstatSync(keyPath);
  } catch {
    throw badRequest(`Secrets master key does not exist at ${keyPath}`);
  }
  const currentUid = typeof process.geteuid === "function" ? process.geteuid() : null;
  const windows = process.platform === "win32";
  if (!before.isFile() || before.isSymbolicLink() ||
      (!windows && currentUid !== null && before.uid !== currentUid) ||
      (!windows && ((before.mode & 0o077) !== 0 || (before.mode & 0o400) === 0 ||
        (before.mode & 0o111) !== 0)) || before.size < 1 || before.size > 1_024 ||
      realpathSync(keyPath) !== keyPath) {
    throw badRequest(`Unsafe secrets master key at ${keyPath}`);
  }
  if (windows) verifyWindowsMasterKeyAcl(keyPath);
  let fd: number;
  try {
    fd = openSync(keyPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    throw badRequest(`Unable to open secrets master key safely at ${keyPath}`);
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.uid !== before.uid || opened.mode !== before.mode || opened.size !== before.size ||
        opened.mtimeMs !== before.mtimeMs) {
      throw badRequest(`Secrets master key changed while opening ${keyPath}`);
    }
    const raw = readFileSync(fd, "utf8");
    const [afterHandle, afterPath] = [fstatSync(fd), lstatSync(keyPath)];
    if (!afterPath.isFile() || afterPath.isSymbolicLink() ||
        afterHandle.dev !== before.dev || afterHandle.ino !== before.ino ||
        afterPath.dev !== before.dev || afterPath.ino !== before.ino ||
        afterHandle.uid !== before.uid || afterPath.uid !== before.uid ||
        afterHandle.mode !== before.mode || afterPath.mode !== before.mode ||
        afterHandle.size !== before.size || afterPath.size !== before.size ||
        afterHandle.mtimeMs !== before.mtimeMs || afterPath.mtimeMs !== before.mtimeMs) {
      throw badRequest(`Secrets master key changed while reading ${keyPath}`);
    }
    revalidateKeyDirectoryHierarchy(hierarchy);
    const decoded = decodeMasterKey(raw);
    if (!decoded) throw badRequest(`Invalid secrets master key at ${keyPath}`);
    return decoded;
  } finally {
    closeSync(fd);
  }
}

function loadMasterKey(options: { createIfMissing: boolean }): Buffer {
  const envKeyRaw = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
  if (envKeyRaw && envKeyRaw.trim().length > 0) {
    const fromEnv = decodeMasterKey(envKeyRaw);
    if (!fromEnv) {
      throw badRequest(
        "Invalid PAPERCLIP_SECRETS_MASTER_KEY (expected 32-byte base64, 64-char hex, or raw 32-char string)",
      );
    }
    return fromEnv;
  }

  const keyPath = resolveMasterKeyFilePath();
  if (existsSync(keyPath)) {
    return readExistingMasterKey(keyPath);
  }

  if (!options.createIfMissing) {
    throw badRequest(`Secrets master key does not exist at ${keyPath}`);
  }

  const dir = path.dirname(keyPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const hierarchy = trustedKeyDirectoryHierarchy(keyPath);
  if (process.platform === "win32") verifyWindowsMasterKeyAcl(keyPath, false);
  const generated = randomBytes(32);
  try {
    writeFileSync(keyPath, generated.toString("base64"), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      generated.fill(0);
      return readExistingMasterKey(keyPath);
    }
    generated.fill(0);
    throw error;
  }
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    // best effort
  }
  try {
    revalidateKeyDirectoryHierarchy(hierarchy);
    if (process.platform === "win32") verifyWindowsMasterKeyAcl(keyPath);
    return generated;
  } catch (error) {
    generated.fill(0);
    throw error;
  }
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function encryptValue(masterKey: Buffer, value: string): LocalEncryptedMaterial {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    scheme: "local_encrypted_v1",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

/**
 * Prepare a local-encrypted secret version from key bytes that were already
 * validated by a maintenance operator. This path performs no environment or
 * filesystem lookup and can never create or reopen a master-key file.
 */
export function createLocalEncryptedVersionFromKey(masterKey: Buffer, value: string) {
  if (masterKey.length !== 32) {
    throw badRequest("Invalid in-memory local_encrypted master key");
  }
  return {
    material: encryptValue(masterKey, value),
    valueSha256: sha256Hex(value),
    externalRef: null,
  };
}

function decryptValue(masterKey: Buffer, material: LocalEncryptedMaterial): string {
  const iv = Buffer.from(material.iv, "base64");
  const tag = Buffer.from(material.tag, "base64");
  const ciphertext = Buffer.from(material.ciphertext, "base64");
  const decipher = createDecipheriv("aes-256-gcm", masterKey, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString("utf8");
}

function asLocalEncryptedMaterial(value: StoredSecretVersionMaterial): LocalEncryptedMaterial {
  if (
    value &&
    typeof value === "object" &&
    value.scheme === "local_encrypted_v1" &&
    typeof value.iv === "string" &&
    typeof value.tag === "string" &&
    typeof value.ciphertext === "string"
  ) {
    return value as LocalEncryptedMaterial;
  }
  throw badRequest("Invalid local_encrypted secret material");
}

/**
 * Resolve an encrypted version with key bytes already validated by a bounded
 * maintenance/operator boundary. This performs no environment lookup, file
 * reopen, or key creation.
 */
export function resolveLocalEncryptedVersionFromKey(
  masterKey: Buffer,
  material: StoredSecretVersionMaterial,
) {
  if (masterKey.length !== 32) {
    throw badRequest("Invalid in-memory local_encrypted master key");
  }
  return decryptValue(masterKey, asLocalEncryptedMaterial(material));
}

export const localEncryptedProvider: SecretProviderModule = {
  id: "local_encrypted",
  descriptor: {
    id: "local_encrypted",
    label: "Local encrypted (default)",
    requiresExternalRef: false,
  },
  async createVersion(input) {
    const masterKey = loadMasterKey({ createIfMissing: true });
    try {
      return createLocalEncryptedVersionFromKey(masterKey, input.value);
    } finally {
      masterKey.fill(0);
    }
  },
  async resolveVersion(input) {
    // Existing ciphertext is unrecoverable without the original key. Never
    // create a replacement while resolving: doing so mutates operator state
    // and turns a precise missing-key blocker into a misleading auth failure.
    const masterKey = loadMasterKey({ createIfMissing: false });
    try {
      return resolveLocalEncryptedVersionFromKey(masterKey, input.material);
    } finally {
      masterKey.fill(0);
    }
  },
};

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

type TrustedPathSnapshot = {
  path: string;
  dev: number;
  ino: number;
  uid: number;
  mode: number;
};

function directoryComponents(absolutePath: string) {
  const parsed = path.parse(absolutePath);
  const relative = absolutePath.slice(parsed.root.length).split(path.sep).filter(Boolean);
  const components = [parsed.root];
  let current = parsed.root;
  for (const segment of relative) {
    current = path.join(current, segment);
    components.push(current);
  }
  return components;
}

async function fsyncVerifiedDirectory(directory: string) {
  const before = await lstat(directory);
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_DIRECTORY ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.uid !== before.uid || opened.mode !== before.mode) {
      throw new Error("trusted_receipt_directory_inode_changed");
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  const after = await lstat(directory);
  if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev ||
      after.ino !== before.ino || after.uid !== before.uid || after.mode !== before.mode) {
    throw new Error("trusted_receipt_directory_changed");
  }
}

function currentUid() {
  return typeof process.geteuid === "function" ? process.geteuid() : null;
}

async function snapshotTrustedHierarchy(
  canonical: string,
  errorPrefix: string,
  options: { requireCurrentOwnedLeaf: boolean },
) {
  const uid = currentUid();
  const snapshots: TrustedPathSnapshot[] = [];
  const components = directoryComponents(canonical);
  for (const component of components) {
    const metadata = await lstat(component).catch(() => null);
    const rootOwnedSticky = metadata?.uid === 0 && (metadata.mode & 0o1000) !== 0;
    const trustedOwner = uid === null || metadata?.uid === uid || metadata?.uid === 0;
    if (!metadata?.isDirectory() || metadata.isSymbolicLink() || !trustedOwner ||
        ((metadata.mode & 0o022) !== 0 && !rootOwnedSticky)) {
      throw new Error(errorPrefix + "_unsafe_hierarchy");
    }
    if (await realpath(component) !== component) throw new Error(errorPrefix + "_symlink_hierarchy");
    snapshots.push({
      path: component,
      dev: metadata.dev,
      ino: metadata.ino,
      uid: metadata.uid,
      mode: metadata.mode,
    });
  }
  const leaf = snapshots.at(-1)!;
  if (options.requireCurrentOwnedLeaf && uid !== null && leaf.uid !== uid) {
    throw new Error(errorPrefix + "_unsafe_leaf");
  }
  return snapshots;
}

async function revalidateTrustedHierarchy(snapshots: TrustedPathSnapshot[], errorPrefix: string) {
  for (const snapshot of snapshots) {
    const metadata = await lstat(snapshot.path).catch(() => null);
    if (!metadata?.isDirectory() || metadata.isSymbolicLink() ||
        metadata.dev !== snapshot.dev || metadata.ino !== snapshot.ino ||
        metadata.uid !== snapshot.uid || metadata.mode !== snapshot.mode ||
        await realpath(snapshot.path) !== snapshot.path) {
      throw new Error(errorPrefix + "_hierarchy_changed");
    }
  }
}

/**
 * Validate an existing current-user-owned directory and every ancestor. The
 * returned path is canonical and the hierarchy is rechecked after validation,
 * so callers never silently accept a swapped directory as a new baseline.
 */
export async function requireTrustedDirectory(value: string, errorPrefix: string) {
  if (!path.isAbsolute(value) || path.resolve(value) !== value || /[\r\n\0]/.test(value)) {
    throw new Error(errorPrefix + "_invalid");
  }
  const canonical = await realpath(value).catch(() => "");
  if (!canonical || canonical !== value) throw new Error(errorPrefix + "_not_canonical");
  const snapshots = await snapshotTrustedHierarchy(canonical, errorPrefix, {
    requireCurrentOwnedLeaf: true,
  });
  const leaf = await lstat(canonical);
  if ((leaf.mode & 0o022) !== 0) throw new Error(errorPrefix + "_unsafe_leaf");
  await revalidateTrustedHierarchy(snapshots, errorPrefix);
  return canonical;
}

/**
 * Read one bounded regular file through a single O_NOFOLLOW descriptor. Both
 * the full hierarchy and the pathname-to-inode binding are verified before and
 * after the read. The returned bytes are the only bytes callers should parse,
 * hash, or compare.
 */
export async function readTrustedFile(
  value: string,
  errorPrefix: string,
  options: {
    maxBytes: number;
    requireReadOnly?: boolean;
    requireCurrentOwner?: boolean;
  },
) {
  if (!path.isAbsolute(value) || path.resolve(value) !== value || /[\r\n\0]/.test(value)) {
    throw new Error(errorPrefix + "_invalid");
  }
  const canonical = await realpath(value).catch(() => "");
  if (!canonical || canonical !== value) throw new Error(errorPrefix + "_not_canonical");
  const parent = path.dirname(canonical);
  const hierarchy = await snapshotTrustedHierarchy(parent, errorPrefix, {
    requireCurrentOwnedLeaf: true,
  });
  const beforePath = await lstat(canonical).catch(() => null);
  const uid = currentUid();
  if (!beforePath?.isFile() || beforePath.isSymbolicLink() || beforePath.size <= 0 ||
      beforePath.size > options.maxBytes ||
      (options.requireReadOnly !== false && (beforePath.mode & 0o222) !== 0) ||
      (beforePath.mode & 0o022) !== 0 ||
      (options.requireCurrentOwner !== false && uid !== null && beforePath.uid !== uid)) {
    throw new Error(errorPrefix + "_unsafe_file");
  }
  const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== beforePath.dev || before.ino !== beforePath.ino ||
        before.uid !== beforePath.uid || before.mode !== beforePath.mode ||
        before.size !== beforePath.size || before.mtimeMs !== beforePath.mtimeMs ||
        before.ctimeMs !== beforePath.ctimeMs) {
      throw new Error(errorPrefix + "_inode_changed");
    }
    // Do not use FileHandle.readFile(): a concurrently growing regular file can
    // otherwise make the read exceed the prevalidated limit. Read exactly the
    // snapshotted length, then probe one byte beyond it to detect growth.
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < before.size) {
      const result = await handle.read(bytes, offset, before.size - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const overflowProbe = Buffer.alloc(1);
    const overflow = await handle.read(overflowProbe, 0, 1, before.size);
    const [after, afterPath] = await Promise.all([handle.stat(), lstat(canonical)]);
    if (offset !== before.size || overflow.bytesRead !== 0 || after.dev !== before.dev || after.ino !== before.ino ||
        after.uid !== before.uid || after.mode !== before.mode || after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
        !afterPath.isFile() || afterPath.isSymbolicLink() ||
        afterPath.dev !== before.dev || afterPath.ino !== before.ino || afterPath.uid !== before.uid ||
        afterPath.mode !== before.mode || afterPath.size !== before.size ||
        afterPath.mtimeMs !== before.mtimeMs || afterPath.ctimeMs !== before.ctimeMs) {
      throw new Error(errorPrefix + "_changed_during_read");
    }
    await revalidateTrustedHierarchy(hierarchy, errorPrefix);
    return {
      path: canonical,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      metadata: before,
    };
  } finally {
    await handle.close();
  }
}

export async function readTrustedJsonFile(
  value: string,
  errorPrefix: string,
  options: { maxBytes: number; requireCurrentOwner?: boolean },
) {
  const artifact = await readTrustedFile(value, errorPrefix, {
    ...options,
    requireReadOnly: true,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(artifact.bytes.toString("utf8"));
  } catch {
    throw new Error(errorPrefix + "_invalid_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(errorPrefix + "_invalid_json_object");
  }
  return { ...artifact, value: parsed as Record<string, unknown> };
}

/**
 * Verify and durably fsync an already-created receipt hierarchy. Root-owned
 * sticky ancestors such as /tmp are accepted, but the receipt directory itself
 * must be owned by the current user and must not be group/world writable.
 */
export async function prepareTrustedReceiptDirectory(value: string, errorPrefix: string) {
  const canonical = await requireTrustedDirectory(value, errorPrefix);
  const components = directoryComponents(canonical);
  const leaf = await lstat(canonical);
  if ((leaf.mode & 0o022) !== 0) {
    throw new Error(errorPrefix + "_unsafe_leaf");
  }
  // Every directory entry becomes durable when its parent is synced; syncing
  // all components bottom-up covers the complete pre-created hierarchy.
  for (const component of [...components].reverse()) {
    await fsyncVerifiedDirectory(component);
  }
  return canonical;
}

import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";

async function fsyncDirectory(directory: string) {
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_DIRECTORY ?? 0),
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Durably install a JSON receipt without an overwrite window. The destination
 * is created by hard-linking a synced 0400 temporary inode, then made 0444;
 * an existing destination always fails closed with EEXIST. The caller must
 * pre-create and durably fsync the trusted directory hierarchy.
 */
export async function writeImmutableJsonReceipt(receiptPath: string, value: unknown) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const requestedPath = path.resolve(receiptPath);
  const receiptDirectory = path.dirname(requestedPath);
  const directoryLeaf = await lstat(receiptDirectory);
  const currentUid = typeof process.geteuid === "function" ? process.geteuid() : null;
  if (!directoryLeaf.isDirectory() || directoryLeaf.isSymbolicLink() ||
      (currentUid !== null && directoryLeaf.uid !== currentUid) || (directoryLeaf.mode & 0o022) !== 0) {
    throw new Error("immutable_receipt_directory_invalid");
  }
  const canonicalDirectory = await realpath(receiptDirectory);
  const destinationPath = path.join(canonicalDirectory, path.basename(requestedPath));
  const temporaryPath = path.join(
    canonicalDirectory,
    `.${path.basename(requestedPath)}.${randomBytes(12).toString("hex")}.tmp`,
  );
  const handle = await open(
    temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o400,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(0o444);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  try {
    await handle.close();
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  let installed = false;
  try {
    const directoryBeforeLink = await lstat(receiptDirectory);
    if (directoryBeforeLink.isSymbolicLink() || directoryBeforeLink.dev !== directoryLeaf.dev ||
        directoryBeforeLink.ino !== directoryLeaf.ino || directoryBeforeLink.uid !== directoryLeaf.uid ||
        directoryBeforeLink.mode !== directoryLeaf.mode || await realpath(receiptDirectory) !== canonicalDirectory) {
      throw new Error("immutable_receipt_directory_changed");
    }
    const temporaryMetadata = await lstat(temporaryPath);
    await link(temporaryPath, destinationPath);
    try {
      const installedMetadata = await lstat(destinationPath);
      const directoryAfterLink = await lstat(receiptDirectory);
      if (!installedMetadata.isFile() || installedMetadata.isSymbolicLink() ||
          installedMetadata.dev !== temporaryMetadata.dev || installedMetadata.ino !== temporaryMetadata.ino ||
          (installedMetadata.mode & 0o777) !== 0o444 ||
          directoryAfterLink.isSymbolicLink() || directoryAfterLink.dev !== directoryLeaf.dev ||
          directoryAfterLink.ino !== directoryLeaf.ino || directoryAfterLink.mode !== directoryLeaf.mode ||
          await realpath(receiptDirectory) !== canonicalDirectory) {
        throw new Error("immutable_receipt_install_validation_failed");
      }
      await fsyncDirectory(canonicalDirectory);
      installed = true;
    } catch (error) {
      await unlink(destinationPath).catch(() => undefined);
      await fsyncDirectory(canonicalDirectory).catch(() => undefined);
      throw error;
    }
  } finally {
    await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT" && !installed) throw error;
    });
    if (installed) await fsyncDirectory(canonicalDirectory).catch(() => undefined);
  }
  return createHash("sha256").update(bytes).digest("hex");
}

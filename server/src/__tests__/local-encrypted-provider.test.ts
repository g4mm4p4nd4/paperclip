import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  localEncryptedProvider,
  resolveLocalEncryptedVersionFromKey,
  validateWindowsMasterKeyAclEvidence,
  windowsMasterKeyAclTargets,
} from "../secrets/local-encrypted-provider.js";

describe("local encrypted secret provider key lifecycle", () => {
  const roots: string[] = [];
  const priorKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const priorInlineKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;

  afterEach(async () => {
    if (priorKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = priorKeyFile;
    if (priorInlineKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY = priorInlineKey;
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("never creates a replacement master key while resolving existing ciphertext", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-local-secret-missing-key-")));
    roots.push(root);
    const keyPath = path.join(root, "master.key");
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = keyPath;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;

    await expect(localEncryptedProvider.resolveVersion({
      material: {
        scheme: "local_encrypted_v1",
        iv: Buffer.alloc(12).toString("base64"),
        tag: Buffer.alloc(16).toString("base64"),
        ciphertext: "",
      },
      externalRef: null,
    })).rejects.toThrow("Secrets master key does not exist");
    expect(existsSync(keyPath)).toBe(false);
  });

  it("creates only on version creation and supports filesystem-free in-memory resolution", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-local-secret-create-key-")));
    roots.push(root);
    const keyPath = path.join(root, "master.key");
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = keyPath;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;

    const prepared = await localEncryptedProvider.createVersion({ value: "bounded-fixture-secret" });
    expect(existsSync(keyPath)).toBe(true);
    await expect(localEncryptedProvider.resolveVersion({
      material: prepared.material,
      externalRef: prepared.externalRef,
    })).resolves.toBe("bounded-fixture-secret");

    const raw = (await readFile(keyPath, "utf8")).trim();
    const key = /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    await rm(keyPath);
    expect(resolveLocalEncryptedVersionFromKey(key, prepared.material)).toBe("bounded-fixture-secret");
    expect(existsSync(keyPath)).toBe(false);
    key.fill(0);
  });

  it("rejects symlinked or group-readable existing key files without following them", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-local-secret-unsafe-key-")));
    roots.push(root);
    const actualKey = path.join(root, "actual.key");
    const configuredKey = path.join(root, "master.key");
    await writeFile(actualKey, Buffer.alloc(32, 7).toString("base64"), { mode: 0o600 });
    await symlink(actualKey, configuredKey);
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = configuredKey;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    await expect(localEncryptedProvider.resolveVersion({
      material: { scheme: "local_encrypted_v1", iv: "", tag: "", ciphertext: "" },
      externalRef: null,
    })).rejects.toThrow("Unsafe secrets master key");

    await rm(configuredKey);
    await chmod(actualKey, 0o640);
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = actualKey;
    await expect(localEncryptedProvider.resolveVersion({
      material: { scheme: "local_encrypted_v1", iv: "", tag: "", ciphertext: "" },
      externalRef: null,
    })).rejects.toThrow("Unsafe secrets master key");
  });

  it("rejects writable or symlinked key-directory hierarchies", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-local-secret-unsafe-parent-")));
    roots.push(root);
    const writableParent = path.join(root, "writable");
    await mkdir(writableParent, { mode: 0o700 });
    const writableKey = path.join(writableParent, "master.key");
    await writeFile(writableKey, Buffer.alloc(32, 9).toString("base64"), { mode: 0o600 });
    await chmod(writableParent, 0o770);
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = writableKey;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    await expect(localEncryptedProvider.resolveVersion({
      material: { scheme: "local_encrypted_v1", iv: "", tag: "", ciphertext: "" },
      externalRef: null,
    })).rejects.toThrow("Unsafe secrets master key directory");

    await chmod(writableParent, 0o700);
    const actualParent = path.join(root, "actual");
    const linkedParent = path.join(root, "linked");
    await mkdir(actualParent, { mode: 0o700 });
    await symlink(actualParent, linkedParent);
    await writeFile(path.join(actualParent, "master.key"), Buffer.alloc(32, 11).toString("base64"), { mode: 0o600 });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(linkedParent, "master.key");
    await expect(localEncryptedProvider.resolveVersion({
      material: { scheme: "local_encrypted_v1", iv: "", tag: "", ciphertext: "" },
      externalRef: null,
    })).rejects.toThrow("Unsafe secrets master key directory");
  });

  it("accepts only the current user, SYSTEM, and Administrators in Windows ACL evidence", () => {
    const userRoot = "/Users/fixture/.paperclip";
    const keyPath = path.join(userRoot, "instances/default/secrets/master.key");
    const currentSid = "S-1-5-21-111-222-333-1001";
    const safe = windowsMasterKeyAclTargets(keyPath, userRoot).map((target) => ({
      path: target,
      ownerSid: currentSid,
      currentSid,
      unexpectedAllowSids: [],
    }));
    expect(() => validateWindowsMasterKeyAclEvidence(keyPath, userRoot, safe)).not.toThrow();
    expect(() => validateWindowsMasterKeyAclEvidence(keyPath, userRoot, safe.map((entry, index) =>
      index === 0 ? { ...entry, unexpectedAllowSids: ["S-1-1-0"] } : entry,
    ))).toThrow("Unsafe Windows ACL");
    expect(() => validateWindowsMasterKeyAclEvidence(
      "/Users/other/master.key",
      userRoot,
      safe,
    )).toThrow("selected Windows user root");
  });
});

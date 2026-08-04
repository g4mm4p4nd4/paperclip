import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProviderPolicyV2 } from "../services/provider-policy.js";
import {
  isQualifyingProviderRuntimeExternalMetadata,
  prepareProviderRuntimeProfile,
  removeProviderRuntimeProfile,
  runProviderRuntimeProfileStartupRecovery,
  sweepProviderRuntimeProfiles,
} from "../services/provider-runtime-profile.js";

const roots: string[] = [];

async function rootsFixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-provider-profile-")));
  roots.push(root);
  const instanceRoot = path.join(root, "instance");
  const userHome = path.join(root, "user");
  await Promise.all([mkdir(instanceRoot), mkdir(userHome)]);
  return { instanceRoot, userHome };
}

async function metadataSnapshot(target: string) {
  const [observed, bytes] = await Promise.all([lstat(target), readFile(target)]);
  return {
    dev: observed.dev,
    ino: observed.ino,
    mode: observed.mode,
    uid: observed.uid,
    gid: observed.gid,
    nlink: observed.nlink,
    size: observed.size,
    mtimeMs: observed.mtimeMs,
    ctimeMs: observed.ctimeMs,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("managed provider runtime profiles", () => {
  it("gives Hermes a private empty home without copying user configuration", async () => {
    const [{ instanceRoot, userHome }, policy] = await Promise.all([rootsFixture(), loadProviderPolicyV2()]);
    const { env, exactRedactionValues } = await prepareProviderRuntimeProfile({
      companyId: "company-1",
      executionId: "run-1",
      route: policy.policy.routes.opencode_go_flash,
      instanceRoot,
      userHome,
    });
    expect(env).toMatchObject({
      HERMES_MANAGED_PROFILE: "1",
      HERMES_DISABLE_PROJECT_DOTENV: "1",
      HERMES_DISABLE_FALLBACK_MODEL: "1",
    });
    expect(env.HOME).toContain("/provider-runtime/hermes_local/run-1/home");
    expect(env.HERMES_HOME).toBe(path.join(env.HOME, ".hermes"));
    expect(exactRedactionValues.size).toBe(0);
    const dotenv = path.join(env.HERMES_HOME, ".env");
    const dotenvStat = await lstat(dotenv);
    expect(dotenvStat.isFile()).toBe(true);
    expect(dotenvStat.mode & 0o777).toBe(0o600);
    expect(await readFile(dotenv, "utf8")).toBe("");
  });

  it("empties and owner-locks an existing Hermes dotenv before every run", async () => {
    const [{ instanceRoot, userHome }, policy] = await Promise.all([rootsFixture(), loadProviderPolicyV2()]);
    const { env } = await prepareProviderRuntimeProfile({
      companyId: "company-1",
      executionId: "run-1",
      route: policy.policy.routes.opencode_go_flash,
      instanceRoot,
      userHome,
    });
    const dotenv = path.join(env.HERMES_HOME, ".env");
    await writeFile(dotenv, "UNRELATED_API_KEY=must-never-survive\n", { mode: 0o666 });

    await prepareProviderRuntimeProfile({
      companyId: "company-1",
      executionId: "run-1",
      route: policy.policy.routes.opencode_go_flash,
      instanceRoot,
      userHome,
    });

    const observed = await lstat(dotenv);
    expect(observed.mode & 0o777).toBe(0o600);
    expect(await readFile(dotenv, "utf8")).toBe("");
  });

  it("rejects a symlinked profile ancestor without writing through it", async () => {
    const [{ instanceRoot, userHome }, policy] = await Promise.all([rootsFixture(), loadProviderPolicyV2()]);
    const outside = path.join(path.dirname(instanceRoot), "outside");
    await mkdir(outside);
    await symlink(outside, path.join(instanceRoot, "companies"), "dir");

    await expect(prepareProviderRuntimeProfile({
      companyId: "company-1",
      executionId: "run-1",
      route: policy.policy.routes.opencode_go_flash,
      instanceRoot,
      userHome,
    })).rejects.toThrow(/partial profile could not be securely removed/i);
    await expect(lstat(path.join(outside, "company-1"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("exposes only a verified Claude credential symlink to the isolated profile", async () => {
    const [{ instanceRoot, userHome }, policy] = await Promise.all([rootsFixture(), loadProviderPolicyV2()]);
    const sourceRoot = path.join(userHome, ".claude");
    await mkdir(sourceRoot);
    const source = path.join(sourceRoot, ".credentials.json");
    await Promise.all([
      writeFile(source, "{\"oauth\":{\"access\":\"test-access-token\",\"refresh\":\"  test-refresh-token  \"}}\n", { mode: 0o600 }),
      writeFile(path.join(sourceRoot, "settings.json"), "{\"personal\":true}\n", { mode: 0o600 }),
    ]);
    const { env, exactRedactionValues } = await prepareProviderRuntimeProfile({
      companyId: "company-1",
      executionId: "run-1",
      route: policy.policy.routes.claude_sonnet,
      instanceRoot,
      userHome,
    });
    const linked = path.join(env.CLAUDE_CONFIG_DIR, ".credentials.json");
    expect((await lstat(linked)).isSymbolicLink()).toBe(true);
    expect(path.resolve(path.dirname(linked), await readlink(linked))).toBe(source);
    await expect(lstat(path.join(env.CLAUDE_CONFIG_DIR, "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect([...exactRedactionValues]).toEqual(expect.arrayContaining([
      "test-access-token",
      "  test-refresh-token  ",
      "test-refresh-token",
    ]));
  });

  it("materializes current Claude Code macOS Keychain auth into the private run profile", async () => {
    const [{ instanceRoot, userHome }, policy] = await Promise.all([rootsFixture(), loadProviderPolicyV2()]);
    const keychainCredential = Buffer.from(
      '{"claudeAiOauth":{"accessToken":"keychain-access-token","refreshToken":"keychain-refresh-token"}}',
    );
    let issuedCredential: Buffer | null = null;
    let requested: { service: string; account: string } | null = null;
    const { env, exactRedactionValues } = await prepareProviderRuntimeProfile({
      companyId: "company-keychain",
      executionId: "run-keychain",
      route: policy.policy.routes.claude_sonnet,
      instanceRoot,
      userHome,
      credentialStore: {
        platform: "darwin",
        account: "test-account",
        readMacosGenericPassword: async (service, account) => {
          requested = { service, account };
          issuedCredential = Buffer.from(keychainCredential);
          return issuedCredential;
        },
      },
    });

    expect(requested).toEqual({ service: "Claude Code-credentials", account: "test-account" });
    const materialized = path.join(env.CLAUDE_CONFIG_DIR, ".credentials.json");
    const observed = await lstat(materialized);
    expect(observed.isFile()).toBe(true);
    expect(observed.isSymbolicLink()).toBe(false);
    expect(observed.mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(materialized, "utf8"))).toEqual(JSON.parse(keychainCredential.toString("utf8")));
    expect(exactRedactionValues.has("keychain-access-token")).toBe(true);
    expect(exactRedactionValues.has("keychain-refresh-token")).toBe(true);
    expect(issuedCredential).not.toBeNull();
    expect(issuedCredential?.every((byte) => byte === 0)).toBe(true);
  });

  it("fails closed when neither Claude credential files nor a supported credential store exist", async () => {
    const [{ instanceRoot, userHome }, policy] = await Promise.all([rootsFixture(), loadProviderPolicyV2()]);
    await expect(prepareProviderRuntimeProfile({
      companyId: "company-no-claude-auth",
      executionId: "run-no-claude-auth",
      route: policy.policy.routes.claude_sonnet,
      instanceRoot,
      userHome,
      credentialStore: { platform: "linux" },
    })).rejects.toThrow(/\.credentials\.json/);
  });

  it("rejects malformed Claude Keychain JSON, clears the buffer, and rolls back the partial profile", async () => {
    const [{ instanceRoot, userHome }, policy] = await Promise.all([rootsFixture(), loadProviderPolicyV2()]);
    const issuedCredential = Buffer.from("not-json-keychain-credential");
    await expect(prepareProviderRuntimeProfile({
      companyId: "company-bad-keychain",
      executionId: "run-bad-keychain",
      route: policy.policy.routes.claude_sonnet,
      instanceRoot,
      userHome,
      credentialStore: {
        platform: "darwin",
        account: "test-account",
        readMacosGenericPassword: async () => issuedCredential,
      },
    })).rejects.toThrow(/valid JSON/);
    expect(issuedCredential.every((byte) => byte === 0)).toBe(true);
    await expect(lstat(path.join(
      instanceRoot,
      "companies/company-bad-keychain/provider-runtime/claude_cli/run-bad-keychain",
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("exposes only Gemini OAuth/account symlinks and fails closed when OAuth is absent", async () => {
    const [{ instanceRoot, userHome }, policy] = await Promise.all([rootsFixture(), loadProviderPolicyV2()]);
    const sourceRoot = path.join(userHome, ".gemini");
    await mkdir(sourceRoot);
    await expect(prepareProviderRuntimeProfile({
      companyId: "company-1",
      executionId: "run-missing-auth",
      route: policy.policy.routes.gemini_flash,
      instanceRoot,
      userHome,
    })).rejects.toThrow(/oauth_creds\.json/);
    const oauth = path.join(sourceRoot, "oauth_creds.json");
    await writeFile(oauth, "{\"oauth\":\"test-only\"}\n", { mode: 0o600 });
    const { env, exactRedactionValues } = await prepareProviderRuntimeProfile({
      companyId: "company-1",
      executionId: "run-1",
      route: policy.policy.routes.gemini_flash,
      instanceRoot,
      userHome,
    });
    const linked = path.join(env.HOME, ".gemini", "oauth_creds.json");
    expect((await lstat(linked)).isSymbolicLink()).toBe(true);
    expect(path.resolve(path.dirname(linked), await readlink(linked))).toBe(oauth);
    expect(exactRedactionValues.has("test-only")).toBe(true);
  });

  it("uses exclusive per-run homes and a minimal Codex auth profile", async () => {
    const [{ instanceRoot, userHome }, policy] = await Promise.all([rootsFixture(), loadProviderPolicyV2()]);
    const sourceRoot = path.join(userHome, ".codex");
    await mkdir(sourceRoot);
    const auth = path.join(sourceRoot, "auth.json");
    await Promise.all([
      writeFile(auth, "{\"auth\":\"test-only\"}\n", { mode: 0o600 }),
      writeFile(path.join(sourceRoot, "config.toml"), "personal = true\n", { mode: 0o600 }),
    ]);

    const [first, second] = await Promise.all([
      prepareProviderRuntimeProfile({
        companyId: "company-1",
        executionId: "run-a",
        route: policy.policy.routes.codex_fast,
        instanceRoot,
        userHome,
      }),
      prepareProviderRuntimeProfile({
        companyId: "company-1",
        executionId: "run-b",
        route: policy.policy.routes.codex_fast,
        instanceRoot,
        userHome,
      }),
    ]);

    expect(first.env.HOME).not.toBe(second.env.HOME);
    expect(first.env.CODEX_HOME).toBe(path.join(first.env.HOME, ".codex"));
    expect((await lstat(path.join(first.env.CODEX_HOME, "auth.json"))).isSymbolicLink()).toBe(true);
    await expect(lstat(path.join(first.env.CODEX_HOME, "config.toml"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(first.exactRedactionValues.has("test-only")).toBe(true);
  });

  it("fails closed on symlinked, broad-mode, oversized, deep, or excessive credential JSON", async () => {
    const [{ instanceRoot, userHome }, policy] = await Promise.all([rootsFixture(), loadProviderPolicyV2()]);
    const sourceRoot = path.join(userHome, ".codex");
    await mkdir(sourceRoot);
    const auth = path.join(sourceRoot, "auth.json");
    const target = path.join(sourceRoot, "target.json");
    await writeFile(target, "{\"token\":\"symlink-secret\"}\n", { mode: 0o600 });
    await symlink(target, auth);

    await expect(prepareProviderRuntimeProfile({
      companyId: "company-credentials",
      executionId: "run-symlink",
      route: policy.policy.routes.codex_fast,
      instanceRoot,
      userHome,
    })).rejects.toThrow(/bounded regular JSON file|symlink/i);
    await unlink(auth);

    await writeFile(auth, "{\"token\":\"broad-mode-secret\"}\n", { mode: 0o600 });
    await chmod(auth, 0o644);
    await expect(prepareProviderRuntimeProfile({
      companyId: "company-credentials",
      executionId: "run-mode",
      route: policy.policy.routes.codex_fast,
      instanceRoot,
      userHome,
    })).rejects.toThrow(/owner-only/i);

    await chmod(auth, 0o600);
    await writeFile(auth, JSON.stringify({ token: "x".repeat(1024 * 1024) }), { mode: 0o600 });
    await expect(prepareProviderRuntimeProfile({
      companyId: "company-credentials",
      executionId: "run-size",
      route: policy.policy.routes.codex_fast,
      instanceRoot,
      userHome,
    })).rejects.toThrow(/bounded regular JSON file|byte limit/i);

    let deep: unknown = "deep-secret";
    for (let index = 0; index < 17; index += 1) deep = { child: deep };
    await writeFile(auth, JSON.stringify(deep), { mode: 0o600 });
    await expect(prepareProviderRuntimeProfile({
      companyId: "company-credentials",
      executionId: "run-depth",
      route: policy.policy.routes.codex_fast,
      instanceRoot,
      userHome,
    })).rejects.toThrow(/depth limit/i);

    await writeFile(auth, JSON.stringify(Array.from({ length: 4097 }, (_, index) => `secret-${index}`)), { mode: 0o600 });
    await expect(prepareProviderRuntimeProfile({
      companyId: "company-credentials",
      executionId: "run-leaves",
      route: policy.policy.routes.codex_fast,
      instanceRoot,
      userHome,
    })).rejects.toThrow(/leaf limit/i);

    for (const executionId of ["run-symlink", "run-mode", "run-size", "run-depth", "run-leaves"]) {
      await expect(lstat(path.join(
        instanceRoot,
        "companies",
        "company-credentials",
        "provider-runtime",
        "codex_cli",
        executionId,
      ))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("enforces owner-only permissions on optional approved credential files", async () => {
    const [{ instanceRoot, userHome }, policy] = await Promise.all([rootsFixture(), loadProviderPolicyV2()]);
    const sourceRoot = path.join(userHome, ".claude");
    await mkdir(sourceRoot);
    await writeFile(path.join(sourceRoot, ".credentials.json"), "{\"token\":\"required-secret\"}\n", { mode: 0o600 });
    const optional = path.join(sourceRoot, "credentials.json");
    await writeFile(optional, "{\"token\":\"optional-secret\"}\n", { mode: 0o600 });
    await chmod(optional, 0o644);

    await expect(prepareProviderRuntimeProfile({
      companyId: "company-optional-mode",
      executionId: "run-optional-mode",
      route: policy.policy.routes.claude_sonnet,
      instanceRoot,
      userHome,
    })).rejects.toThrow(/owner-only/i);
  });

  it("reaps a terminal SIGKILL orphan and a stale crash quarantine", async () => {
    const [{ instanceRoot, userHome }, policy] = await Promise.all([rootsFixture(), loadProviderPolicyV2()]);
    const orphan = await prepareProviderRuntimeProfile({
      companyId: "company-sigkill",
      executionId: "run-sigkill",
      route: policy.policy.routes.opencode_go_flash,
      instanceRoot,
      userHome,
    });
    const crash = await prepareProviderRuntimeProfile({
      companyId: "company-sigkill",
      executionId: "run-quarantine",
      route: policy.policy.routes.opencode_go_flash,
      instanceRoot,
      userHome,
    });
    const crashProfileRoot = path.dirname(crash.env.HOME);
    const adapterRoot = path.dirname(crashProfileRoot);
    const staleQuarantine = path.join(adapterRoot, ".cleanup-run-quarantine-0123456789abcdef");
    await rename(crashProfileRoot, staleQuarantine);
    const staleAt = new Date(Date.now() - 60_000);
    await utimes(staleQuarantine, staleAt, staleAt);

    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await once(child, "spawn");
    if (!child.pid) throw new Error("SIGKILL fixture failed to obtain a child pid");
    const killedPid = child.pid;
    const exited = once(child, "exit");
    expect(child.kill("SIGKILL")).toBe(true);
    await exited;

    const result = await sweepProviderRuntimeProfiles({
      instanceRoot,
      quarantineStaleMs: 1_000,
      resolveRunAuthority: async (_companyId, executionId) => executionId === "run-sigkill"
        ? { status: "failed", processPid: killedPid, processGroupId: null }
        : null,
    });

    expect(result.status).toBe("cleaned");
    expect(result.counts).toMatchObject({
      profilesRemoved: 1,
      terminalRunProfilesRemoved: 1,
      quarantinesRemoved: 1,
      failures: 0,
    });
    await expect(lstat(orphan.env.HOME)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(staleQuarantine)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves queued/running and terminal PID-owned profiles", async () => {
    const [{ instanceRoot, userHome }, policy] = await Promise.all([rootsFixture(), loadProviderPolicyV2()]);
    const active = await prepareProviderRuntimeProfile({
      companyId: "company-active",
      executionId: "run-active",
      route: policy.policy.routes.opencode_go_flash,
      instanceRoot,
      userHome,
    });
    const pidOwned = await prepareProviderRuntimeProfile({
      companyId: "company-active",
      executionId: "run-pid-owned",
      route: policy.policy.routes.opencode_go_flash,
      instanceRoot,
      userHome,
    });

    const result = await sweepProviderRuntimeProfiles({
      instanceRoot,
      resolveRunAuthority: async (_companyId, executionId) => executionId === "run-active"
        ? { status: "running", processPid: null, processGroupId: null }
        : { status: "failed", processPid: process.pid, processGroupId: null },
    });

    expect(result.status).toBe("clean");
    expect(result.counts).toMatchObject({
      profilesRemoved: 0,
      activeProfilesPreserved: 1,
      pidOwnedProfilesPreserved: 1,
      failures: 0,
    });
    expect((await lstat(active.env.HOME)).isDirectory()).toBe(true);
    expect((await lstat(pidOwned.env.HOME)).isDirectory()).toBe(true);
  });

  it("preserves qualifying external metadata at all three scan depths with count-only receipts", async () => {
    const { instanceRoot } = await rootsFixture();
    const companiesRoot = path.join(instanceRoot, "companies");
    const providerRoot = path.join(companiesRoot, "company-metadata", "provider-runtime");
    const adapterRoot = path.join(providerRoot, "hermes_local");
    await mkdir(adapterRoot, { recursive: true });
    const metadata = [
      path.join(companiesRoot, ".DS_Store"),
      path.join(providerRoot, ".DS_Store"),
      path.join(adapterRoot, ".DS_Store"),
    ];
    const custodyValues = ["company-root-custody", "provider-root-custody", "adapter-root-custody"];
    await Promise.all(metadata.map((target, index) => writeFile(target, custodyValues[index]!, { mode: 0o644 })));
    const before = await Promise.all(metadata.map(metadataSnapshot));
    let authorityLookups = 0;
    const order: string[] = [];

    const recovery = await runProviderRuntimeProfileStartupRecovery({
      reapOrphanedRuns: async () => { order.push("reap"); },
      sweepProviderRuntimeProfiles: async () => {
        order.push("sweep");
        return sweepProviderRuntimeProfiles({
          instanceRoot,
          resolveRunAuthority: async () => {
            authorityLookups += 1;
            throw new Error("external metadata must not reach authority lookup");
          },
        });
      },
      resumeQueuedRuns: async () => { order.push("resume"); },
    });
    const repeated = await sweepProviderRuntimeProfiles({
      instanceRoot,
      resolveRunAuthority: async () => {
        authorityLookups += 1;
        throw new Error("external metadata must not reach authority lookup");
      },
    });

    expect(recovery.status).toBe("ready");
    expect(order).toEqual(["reap", "sweep", "resume"]);
    if (recovery.status !== "ready") throw new Error("expected clean startup recovery");
    for (const result of [recovery.cleanup, repeated]) {
      expect(result.status).toBe("clean");
      expect(result.counts).toMatchObject({
        companiesScanned: 1,
        adapterRootsScanned: 1,
        externalMetadataEntriesPreserved: 3,
        unsafeEntriesPreserved: 0,
        failures: 0,
      });
      const rawReceipt = await readFile(result.receiptPath, "utf8");
      expect(rawReceipt).not.toContain(".DS_Store");
      for (const value of custodyValues) expect(rawReceipt).not.toContain(value);
      expect(JSON.parse(rawReceipt)).toMatchObject({
        schemaVersion: "paperclip.provider_runtime_profile_cleanup.v1",
        counts: { externalMetadataEntriesPreserved: 3 },
      });
    }
    expect(authorityLookups).toBe(0);
    expect(await Promise.all(metadata.map(metadataSnapshot))).toEqual(before);
  });

  it("accepts external metadata appearance, replacement, and disappearance without touching it", async () => {
    const { instanceRoot } = await rootsFixture();
    const companiesRoot = path.join(instanceRoot, "companies");
    await mkdir(companiesRoot);
    const target = path.join(companiesRoot, ".DS_Store");
    const sweep = () => sweepProviderRuntimeProfiles({
      instanceRoot,
      resolveRunAuthority: async () => {
        throw new Error("external metadata must not reach authority lookup");
      },
    });

    expect((await sweep()).counts.externalMetadataEntriesPreserved).toBe(0);
    await writeFile(target, "first-custody-value", { mode: 0o644 });
    const appeared = await metadataSnapshot(target);
    expect((await sweep()).counts.externalMetadataEntriesPreserved).toBe(1);
    expect(await metadataSnapshot(target)).toEqual(appeared);

    await unlink(target);
    await writeFile(target, "replacement-custody-value", { mode: 0o644 });
    const replaced = await metadataSnapshot(target);
    expect((await sweep()).counts.externalMetadataEntriesPreserved).toBe(1);
    expect(await metadataSnapshot(target)).toEqual(replaced);

    await unlink(target);
    expect((await sweep()).counts.externalMetadataEntriesPreserved).toBe(0);
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires every bounded external metadata stat predicate", () => {
    const observed = {
      dev: 7,
      uid: 501,
      nlink: 1,
      mode: 0o100644,
      size: 6_148,
      isFile: () => true,
      isSymbolicLink: () => false,
    };
    const qualifies = (overrides: Partial<typeof observed> = {}, inputOverrides: {
      basename?: string;
      parentDevice?: number;
      currentUserId?: number | null;
    } = {}) => isQualifyingProviderRuntimeExternalMetadata({
      basename: inputOverrides.basename ?? ".DS_Store",
      parentDevice: inputOverrides.parentDevice ?? 7,
      currentUserId: inputOverrides.currentUserId === undefined ? 501 : inputOverrides.currentUserId,
      observed: { ...observed, ...overrides },
    });

    expect(qualifies()).toBe(true);
    expect(qualifies({}, { basename: ".ds_store" })).toBe(false);
    expect(qualifies({}, { basename: ".DS_Stor\u00e9" })).toBe(false);
    expect(qualifies({}, { currentUserId: 502 })).toBe(false);
    expect(qualifies({}, { currentUserId: null })).toBe(false);
    expect(qualifies({}, { parentDevice: 8 })).toBe(false);
    expect(qualifies({ nlink: 2 })).toBe(false);
    expect(qualifies({ mode: 0o100744 })).toBe(false);
    expect(qualifies({ size: 1_048_577 })).toBe(false);
    expect(qualifies({ isFile: () => false })).toBe(false);
    expect(qualifies({ isSymbolicLink: () => true })).toBe(false);
  });

  it("fails closed on nonqualifying external metadata nodes without touching them", async () => {
    const cases: Array<{
      name: string;
      setup: (root: string, target: string) => Promise<string | null>;
    }> = [
      {
        name: "symlink",
        setup: async (root, target) => {
          const outside = path.join(root, "outside-symlink-target");
          await writeFile(outside, "keep-symlink-target", { mode: 0o644 });
          await symlink(outside, target);
          return outside;
        },
      },
      {
        name: "directory",
        setup: async (_root, target) => {
          await mkdir(target);
          return null;
        },
      },
      {
        name: "hardlink",
        setup: async (root, target) => {
          const outside = path.join(root, "outside-hardlink-target");
          await writeFile(outside, "keep-hardlink-target", { mode: 0o644 });
          await link(outside, target);
          return outside;
        },
      },
      {
        name: "executable",
        setup: async (_root, target) => {
          await writeFile(target, "keep-executable", { mode: 0o744 });
          return target;
        },
      },
      {
        name: "oversize",
        setup: async (_root, target) => {
          await writeFile(target, Buffer.alloc(1_048_577, 0x61), { mode: 0o644 });
          return target;
        },
      },
    ];

    for (const testCase of cases) {
      const { instanceRoot } = await rootsFixture();
      const companiesRoot = path.join(instanceRoot, "companies");
      await mkdir(companiesRoot);
      const target = path.join(companiesRoot, ".DS_Store");
      const contentTarget = await testCase.setup(path.dirname(instanceRoot), target);
      const before = contentTarget && (await lstat(contentTarget)).isFile()
        ? await metadataSnapshot(contentTarget)
        : null;
      const result = await sweepProviderRuntimeProfiles({
        instanceRoot,
        resolveRunAuthority: async () => {
          throw new Error(`${testCase.name} metadata must not reach authority lookup`);
        },
      });

      expect(result.status, testCase.name).toBe("partial_failure");
      expect(result.counts, testCase.name).toMatchObject({
        externalMetadataEntriesPreserved: 0,
        unsafeEntriesPreserved: 1,
        failures: 1,
      });
      expect((await lstat(target)).isSymbolicLink(), testCase.name).toBe(testCase.name === "symlink");
      if (before && contentTarget) expect(await metadataSnapshot(contentTarget)).toEqual(before);
    }
  });

  it("keeps case variants, other dotfiles, invalid IDs, and concurrent unsafe entries fail-closed", async () => {
    const caseFixture = await rootsFixture();
    const caseCompaniesRoot = path.join(caseFixture.instanceRoot, "companies");
    await mkdir(caseCompaniesRoot);
    await writeFile(path.join(caseCompaniesRoot, ".ds_store"), "reject-case", { mode: 0o644 });
    const caseResult = await sweepProviderRuntimeProfiles({
      instanceRoot: caseFixture.instanceRoot,
      resolveRunAuthority: async () => {
        throw new Error("case-variant metadata must not reach authority lookup");
      },
    });
    expect(caseResult.status).toBe("partial_failure");
    expect(caseResult.counts).toMatchObject({
      externalMetadataEntriesPreserved: 0,
      unsafeEntriesPreserved: 1,
      failures: 1,
    });

    const { instanceRoot } = await rootsFixture();
    const companiesRoot = path.join(instanceRoot, "companies");
    const providerRoot = path.join(companiesRoot, "company-valid", "provider-runtime");
    const adapterRoot = path.join(providerRoot, "hermes_local");
    await mkdir(adapterRoot, { recursive: true });
    await Promise.all([
      writeFile(path.join(companiesRoot, ".DS_Store"), "preserve-company", { mode: 0o644 }),
      writeFile(path.join(providerRoot, ".DS_Store"), "preserve-provider", { mode: 0o644 }),
      writeFile(path.join(adapterRoot, ".DS_Store"), "preserve-adapter", { mode: 0o644 }),
      writeFile(path.join(companiesRoot, ".DS_Stor\u00e9"), "reject-unicode", { mode: 0o644 }),
      writeFile(path.join(companiesRoot, ".hidden"), "reject-dotfile", { mode: 0o644 }),
      mkdir(path.join(companiesRoot, "invalid company")),
      mkdir(path.join(providerRoot, "invalid-adapter")),
      mkdir(path.join(adapterRoot, "invalid execution")),
    ]);
    let authorityLookups = 0;

    const result = await sweepProviderRuntimeProfiles({
      instanceRoot,
      resolveRunAuthority: async () => {
        authorityLookups += 1;
        throw new Error("unsafe entries must not reach authority lookup");
      },
    });

    expect(result.status).toBe("partial_failure");
    expect(result.counts).toMatchObject({
      externalMetadataEntriesPreserved: 3,
      unsafeEntriesPreserved: 5,
      failures: 5,
    });
    expect(authorityLookups).toBe(0);
  });

  it("fails closed on a symlink ancestor containing external metadata", async () => {
    const { instanceRoot } = await rootsFixture();
    const companyRoot = path.join(instanceRoot, "companies", "company-symlink-ancestor");
    const outside = path.join(path.dirname(instanceRoot), "outside-provider-runtime");
    await Promise.all([mkdir(companyRoot, { recursive: true }), mkdir(outside)]);
    const outsideMetadata = path.join(outside, ".DS_Store");
    await writeFile(outsideMetadata, "keep-outside-custody", { mode: 0o644 });
    await symlink(outside, path.join(companyRoot, "provider-runtime"), "dir");
    const before = await metadataSnapshot(outsideMetadata);

    const result = await sweepProviderRuntimeProfiles({
      instanceRoot,
      resolveRunAuthority: async () => {
        throw new Error("symlink ancestor must not reach authority lookup");
      },
    });

    expect(result.status).toBe("partial_failure");
    expect(result.counts).toMatchObject({
      externalMetadataEntriesPreserved: 0,
      unsafeEntriesPreserved: 1,
      failures: 1,
    });
    expect(await metadataSnapshot(outsideMetadata)).toEqual(before);
  });

  it("fails closed on a symlinked managed entry without touching its target", async () => {
    const { instanceRoot } = await rootsFixture();
    const adapterRoot = path.join(instanceRoot, "companies", "company-attack", "provider-runtime", "hermes_local");
    const outside = path.join(path.dirname(instanceRoot), "sweep-outside");
    await Promise.all([mkdir(adapterRoot, { recursive: true }), mkdir(outside)]);
    await writeFile(path.join(outside, "marker"), "keep", "utf8");
    await symlink(outside, path.join(adapterRoot, "run-attack"), "dir");

    const result = await sweepProviderRuntimeProfiles({
      instanceRoot,
      resolveRunAuthority: async () => {
        throw new Error("authority must not be consulted for an unsafe profile");
      },
    });

    expect(result.status).toBe("partial_failure");
    expect(result.counts).toMatchObject({ unsafeEntriesPreserved: 1, profilesRemoved: 0, failures: 1 });
    expect(result.failures).toEqual([
      expect.objectContaining({
        blockerCode: "provider_runtime_profile_cleanup_failed",
        failureCode: "unsafe_managed_entry",
        phase: "scan",
        count: 1,
      }),
    ]);
    expect(await readFile(path.join(outside, "marker"), "utf8")).toBe("keep");
    const receipt = await readFile(result.receiptPath, "utf8");
    expect(receipt).not.toContain(instanceRoot);
    expect(receipt).not.toContain(outside);
    expect(receipt).not.toContain("run-attack");
  });

  it("is idempotent and writes immutable count-only receipts without credential or profile identifiers", async () => {
    const [{ instanceRoot, userHome }, policy] = await Promise.all([rootsFixture(), loadProviderPolicyV2()]);
    const sourceRoot = path.join(userHome, ".codex");
    await mkdir(sourceRoot);
    const secret = "receipt-must-not-persist-this-secret";
    await writeFile(path.join(sourceRoot, "auth.json"), JSON.stringify({ auth: { token: secret } }), { mode: 0o600 });
    const prepared = await prepareProviderRuntimeProfile({
      companyId: "company-idempotent",
      executionId: "run-once",
      route: policy.policy.routes.codex_fast,
      instanceRoot,
      userHome,
    });
    expect(prepared.exactRedactionValues.has(secret)).toBe(true);

    const resolveRunAuthority = async () => null;
    const first = await sweepProviderRuntimeProfiles({ instanceRoot, resolveRunAuthority });
    const second = await sweepProviderRuntimeProfiles({ instanceRoot, resolveRunAuthority });

    expect(first.status).toBe("cleaned");
    expect(first.counts).toMatchObject({ profilesRemoved: 1, missingRunProfilesRemoved: 1 });
    expect(second.status).toBe("clean");
    expect(second.counts.profilesRemoved).toBe(0);
    expect(first.receiptPath).not.toBe(second.receiptPath);
    for (const result of [first, second]) {
      const [receipt, receiptStat] = await Promise.all([
        readFile(result.receiptPath),
        lstat(result.receiptPath),
      ]);
      expect(receiptStat.isFile()).toBe(true);
      expect(receiptStat.isSymbolicLink()).toBe(false);
      expect(receiptStat.mode & 0o777).toBe(0o444);
      expect(createHash("sha256").update(receipt).digest("hex")).toBe(result.receiptSha256);
      const raw = receipt.toString("utf8");
      for (const forbidden of [secret, instanceRoot, userHome, "company-idempotent", "run-once", "auth.json"]) {
        expect(raw).not.toContain(forbidden);
      }
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        schemaVersion: "paperclip.provider_runtime_profile_cleanup.v1",
        immutable: true,
      });
      expect(Object.keys(parsed).sort()).toEqual([
        "completedAt",
        "counts",
        "failureCodeCounts",
        "immutable",
        "root",
        "schemaVersion",
        "startedAt",
        "status",
      ]);
    }
  });

  it("orders orphan reaping before sweeping and blocks queued resumption on partial cleanup", async () => {
    const readyFixture = await rootsFixture();
    const readyOrder: string[] = [];
    const ready = await runProviderRuntimeProfileStartupRecovery({
      reapOrphanedRuns: async () => { readyOrder.push("reap"); },
      sweepProviderRuntimeProfiles: async () => {
        readyOrder.push("sweep");
        return sweepProviderRuntimeProfiles({ instanceRoot: readyFixture.instanceRoot, resolveRunAuthority: async () => null });
      },
      resumeQueuedRuns: async () => { readyOrder.push("resume"); },
    });
    expect(ready.status).toBe("ready");
    expect(readyOrder).toEqual(["reap", "sweep", "resume"]);

    const blockedFixture = await rootsFixture();
    const outside = path.join(path.dirname(blockedFixture.instanceRoot), "blocked-outside");
    await mkdir(outside);
    await symlink(outside, path.join(blockedFixture.instanceRoot, "companies"), "dir");
    const blockedOrder: string[] = [];
    const blocked = await runProviderRuntimeProfileStartupRecovery({
      reapOrphanedRuns: async () => { blockedOrder.push("reap"); },
      sweepProviderRuntimeProfiles: async () => {
        blockedOrder.push("sweep");
        return sweepProviderRuntimeProfiles({ instanceRoot: blockedFixture.instanceRoot, resolveRunAuthority: async () => null });
      },
      resumeQueuedRuns: async () => { blockedOrder.push("resume"); },
    });
    expect(blocked.status).toBe("blocked");
    expect(blockedOrder).toEqual(["reap", "sweep"]);
    if (blocked.status === "blocked") {
      expect(blocked.failure).toMatchObject({
        blockerCode: "provider_runtime_profile_cleanup_failed",
        failureCode: "unsafe_managed_entry",
        nextOwner: "paperclip_runtime_owner",
      });
      expect(JSON.stringify(blocked.failure)).not.toContain(blockedFixture.instanceRoot);
    }
  });

  it("quarantines and removes a completed per-run profile", async () => {
    const [{ instanceRoot, userHome }, policy] = await Promise.all([rootsFixture(), loadProviderPolicyV2()]);
    const { env } = await prepareProviderRuntimeProfile({
      companyId: "company-1",
      executionId: "run-cleanup",
      route: policy.policy.routes.opencode_go_flash,
      instanceRoot,
      userHome,
    });
    await removeProviderRuntimeProfile({
      companyId: "company-1",
      executionId: "run-cleanup",
      route: policy.policy.routes.opencode_go_flash,
      instanceRoot,
    });
    await expect(lstat(env.HOME)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses cleanup when an ancestor was replaced by a symlink", async () => {
    const [{ instanceRoot, userHome }, policy] = await Promise.all([rootsFixture(), loadProviderPolicyV2()]);
    await prepareProviderRuntimeProfile({
      companyId: "company-1",
      executionId: "run-tampered",
      route: policy.policy.routes.opencode_go_flash,
      instanceRoot,
      userHome,
    });
    const outside = path.join(path.dirname(instanceRoot), "cleanup-outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "marker"), "keep", "utf8");
    await rm(path.join(instanceRoot, "companies"), { recursive: true, force: true });
    await symlink(outside, path.join(instanceRoot, "companies"), "dir");

    await expect(removeProviderRuntimeProfile({
      companyId: "company-1",
      executionId: "run-tampered",
      route: policy.policy.routes.opencode_go_flash,
      instanceRoot,
    })).rejects.toThrow(/provider_runtime_profile_cleanup_failed/);
    expect(await readFile(path.join(outside, "marker"), "utf8")).toBe("keep");
  });
});

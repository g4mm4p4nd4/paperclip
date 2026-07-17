import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedAdapterBundleIdentity } from "../services/managed-adapter-bundle.js";
import type { AdapterPluginRecord } from "../services/adapter-plugin-store.js";
import { errorHandler } from "../middleware/index.js";

const mocks = vi.hoisted(() => ({
  getAdapterPluginByType: vi.fn(),
  listAdapterPlugins: vi.fn(() => []),
  compareAndSwapManagedAdapterPlugin: vi.fn(),
  listServerAdapters: vi.fn(() => []),
  registerLoadedExternalAdapter: vi.fn(),
  setOverridePaused: vi.fn(),
  reloadExternalAdapter: vi.fn(),
  loadExternalAdapterPackage: vi.fn(),
  verifyManagedAdapterPluginRecord: vi.fn(),
  verifyManagedAdapterBundleIdentity: vi.fn(),
  managedAdapterIdentityFromRecord: vi.fn(),
  writeManagedAdapterTransitionReceipt: vi.fn(),
  listCompanyIds: vi.fn(),
  logActivity: vi.fn(),
}));

vi.mock("../services/adapter-plugin-store.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/adapter-plugin-store.js")>(),
  getAdapterPluginByType: mocks.getAdapterPluginByType,
  listAdapterPlugins: mocks.listAdapterPlugins,
  compareAndSwapManagedAdapterPlugin: mocks.compareAndSwapManagedAdapterPlugin,
  getDisabledAdapterTypes: vi.fn(() => []),
}));

vi.mock("../adapters/registry.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../adapters/registry.js")>(),
  listServerAdapters: mocks.listServerAdapters,
  registerLoadedExternalAdapter: mocks.registerLoadedExternalAdapter,
  setOverridePaused: mocks.setOverridePaused,
  isOverridePaused: vi.fn(() => false),
}));

vi.mock("../adapters/plugin-loader.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../adapters/plugin-loader.js")>(),
  reloadExternalAdapter: mocks.reloadExternalAdapter,
  loadExternalAdapterPackage: mocks.loadExternalAdapterPackage,
}));

vi.mock("../services/managed-adapter-bundle.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/managed-adapter-bundle.js")>(),
  verifyManagedAdapterPluginRecord: mocks.verifyManagedAdapterPluginRecord,
  verifyManagedAdapterBundleIdentity: mocks.verifyManagedAdapterBundleIdentity,
  managedAdapterIdentityFromRecord: mocks.managedAdapterIdentityFromRecord,
  writeManagedAdapterTransitionReceipt: mocks.writeManagedAdapterTransitionReceipt,
}));

vi.mock("../services/index.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/index.js")>(),
  instanceSettingsService: vi.fn(() => ({ listCompanyIds: mocks.listCompanyIds })),
  logActivity: mocks.logActivity,
}));

import { adapterRoutes } from "../routes/adapters.js";

function identity(seed: string, version: string): ManagedAdapterBundleIdentity {
  const digest = seed.repeat(64).slice(0, 64);
  return {
    kind: "managed_immutable_bundle",
    objectRoot: `/managed/${digest}`,
    packageRoot: `/managed/${digest}/package`,
    archivePath: `/managed/${digest}/bundle.tgz`,
    bundleSha256: digest,
    packageName: "@henkey/hermes-paperclip-adapter",
    packageVersion: version,
    manifestPath: `/managed/${digest}/package/immutable-adapter-manifest.json`,
    manifestSha256: seed.toUpperCase().repeat(64).slice(0, 64).toLowerCase(),
    payloadTreeSha256: "c".repeat(64),
    installReceiptPath: `/managed/${digest}/install.json`,
    installReceiptSha256: "d".repeat(64),
    sourceGitHead: "e".repeat(40),
    sourceGitTree: "f".repeat(40),
    files: [{ path: "index.js", sha256: "1".repeat(64), bytes: 1, mode: "0444" }],
  };
}

const current = identity("a", "0.3.0");
const target = identity("b", "0.2.0");
const managedRecord: AdapterPluginRecord = {
  packageName: "@henkey/hermes-paperclip-adapter",
  version: current.packageVersion,
  type: "hermes_local",
  installedAt: "2026-07-15T00:00:00.000Z",
  installKind: "managed_immutable_bundle",
  managedBundle: current,
  managedBundleHistory: [target],
};

const instanceAdmin = {
  type: "board",
  userId: "admin-user",
  companyIds: ["company-1"],
  source: "session",
  isInstanceAdmin: true,
};

const ordinaryBoard = {
  ...instanceAdmin,
  userId: "ordinary-user",
  isInstanceAdmin: false,
};

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", adapterRoutes({} as never));
  app.use(errorHandler);
  return app;
}

function rollback(app: ReturnType<typeof createApp>, overrides: Record<string, unknown> = {}) {
  return request(app).post("/api/adapters/hermes_local/managed-rollback").send({
    expectedCurrentBundleSha256: current.bundleSha256,
    targetBundleSha256: target.bundleSha256,
    confirm: true,
    ...overrides,
  });
}

describe("managed adapter routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAdapterPluginByType.mockReturnValue(managedRecord);
    mocks.listAdapterPlugins.mockReturnValue([managedRecord]);
    mocks.listServerAdapters.mockReturnValue([{ type: "hermes_local", models: [] }]);
    mocks.managedAdapterIdentityFromRecord.mockReturnValue(current);
    mocks.verifyManagedAdapterPluginRecord.mockResolvedValue(current);
    mocks.verifyManagedAdapterBundleIdentity.mockResolvedValue(target);
    mocks.loadExternalAdapterPackage.mockResolvedValue({
      type: "hermes_local",
      execute: vi.fn(),
      testEnvironment: vi.fn(),
    });
    mocks.compareAndSwapManagedAdapterPlugin.mockReturnValue(true);
    mocks.writeManagedAdapterTransitionReceipt.mockResolvedValue({
      receiptPath: "/receipts/transition.json",
      receiptSha256: "9".repeat(64),
      body: {},
    });
    mocks.listCompanyIds.mockResolvedValue(["company-1", "company-2"]);
    mocks.logActivity.mockResolvedValue(undefined);
  });

  it("performs an exact verified rollback, attributes it, and logs every company", async () => {
    const response = await rollback(createApp(instanceAdmin));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({
      priorBundleSha256: current.bundleSha256,
      activeBundleSha256: target.bundleSha256,
      transitionReceiptSha256: "9".repeat(64),
    });
    expect(mocks.writeManagedAdapterTransitionReceipt).toHaveBeenCalledWith(expect.objectContaining({
      operation: "rollback",
      actor: { type: "user", id: "admin-user" },
      occurredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    }));
    const nextRecord = mocks.compareAndSwapManagedAdapterPlugin.mock.calls[0]?.[2] as AdapterPluginRecord;
    expect(nextRecord.managedBundle?.bundleSha256).toBe(target.bundleSha256);
    expect(nextRecord.managedBundleHistory?.map((entry) => entry.bundleSha256)).toEqual([current.bundleSha256]);
    expect(mocks.registerLoadedExternalAdapter).toHaveBeenCalledOnce();
    expect(mocks.logActivity).toHaveBeenCalledTimes(4);
    expect(mocks.logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      actorType: "user",
      actorId: "admin-user",
      action: "adapter.managed_rollback_authorized",
      entityId: target.bundleSha256,
    }));
    expect(mocks.logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "adapter.managed_rollback_completed",
    }));
  });

  it("returns 409 without verification or mutation when the active fencing hash is stale", async () => {
    const response = await rollback(createApp(instanceAdmin), {
      expectedCurrentBundleSha256: "0".repeat(64),
    });
    expect(response.status).toBe(409);
    expect(mocks.verifyManagedAdapterBundleIdentity).not.toHaveBeenCalled();
    expect(mocks.compareAndSwapManagedAdapterPlugin).not.toHaveBeenCalled();
  });

  it("forbids the legacy delete route from unregistering a managed immutable adapter", async () => {
    const ordinary = await request(createApp(ordinaryBoard)).delete("/api/adapters/hermes_local");
    expect(ordinary.status).toBe(403);

    const admin = await request(createApp(instanceAdmin)).delete("/api/adapters/hermes_local");
    expect(admin.status).toBe(409);
    expect(admin.body.error).toContain("legacy route");
    expect(mocks.compareAndSwapManagedAdapterPlugin).not.toHaveBeenCalled();
  });

  it("returns 409 without mutation when the target is absent from managed history", async () => {
    const response = await rollback(createApp(instanceAdmin), {
      targetBundleSha256: "0".repeat(64),
    });
    expect(response.status).toBe(409);
    expect(mocks.compareAndSwapManagedAdapterPlugin).not.toHaveBeenCalled();
  });

  it("returns 422 with zero state change when target byte verification fails", async () => {
    mocks.verifyManagedAdapterBundleIdentity.mockRejectedValueOnce(new Error("target bytes changed"));
    const response = await rollback(createApp(instanceAdmin));
    expect(response.status).toBe(422);
    expect(mocks.compareAndSwapManagedAdapterPlugin).not.toHaveBeenCalled();
    expect(mocks.registerLoadedExternalAdapter).not.toHaveBeenCalled();
    expect(mocks.logActivity).not.toHaveBeenCalled();
  });

  it("quarantines a corrupt active bundle instead of retaining it as a rollback target", async () => {
    mocks.verifyManagedAdapterPluginRecord.mockRejectedValueOnce(new Error("active bytes changed"));
    const response = await rollback(createApp(instanceAdmin));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const nextRecord = mocks.compareAndSwapManagedAdapterPlugin.mock.calls[0]?.[2] as AdapterPluginRecord;
    expect(nextRecord.managedBundleHistory).toEqual([]);
    expect(mocks.writeManagedAdapterTransitionReceipt).toHaveBeenCalledWith(expect.objectContaining({
      currentVerification: "failed",
    }));
  });

  it("returns 409 and records only the authorized attempt when compare-and-swap loses", async () => {
    mocks.compareAndSwapManagedAdapterPlugin.mockReturnValueOnce(false);
    const response = await rollback(createApp(instanceAdmin));
    expect(response.status).toBe(409);
    expect(mocks.registerLoadedExternalAdapter).not.toHaveBeenCalled();
    expect(mocks.logActivity).toHaveBeenCalledTimes(2);
    expect(mocks.logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "adapter.managed_rollback_authorized",
    }));
    expect(mocks.logActivity).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "adapter.managed_rollback_completed",
    }));
  });

  it("fails closed before compare-and-swap when the required authorization audit cannot be written", async () => {
    mocks.logActivity.mockRejectedValueOnce(new Error("activity database unavailable"));
    const response = await rollback(createApp(instanceAdmin));
    expect(response.status).toBe(422);
    expect(mocks.compareAndSwapManagedAdapterPlugin).not.toHaveBeenCalled();
    expect(mocks.registerLoadedExternalAdapter).not.toHaveBeenCalled();
  });

  it("reports a completed pointer swap as success when only completion fanout fails", async () => {
    mocks.logActivity
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("completion fanout unavailable"));
    const response = await rollback(createApp(instanceAdmin));
    expect(response.status).toBe(200);
    expect(mocks.compareAndSwapManagedAdapterPlugin).toHaveBeenCalledOnce();
    expect(mocks.registerLoadedExternalAdapter).toHaveBeenCalledOnce();
  });

  it("redacts rollback candidates and authority from ordinary board users", async () => {
    const ordinary = await request(createApp(ordinaryBoard)).get("/api/adapters");
    expect(ordinary.status).toBe(200);
    expect(ordinary.body[0]).toMatchObject({ canManageManagedRuntime: false });
    expect(ordinary.body[0]).not.toHaveProperty("rollbackTargets");

    const admin = await request(createApp(instanceAdmin)).get("/api/adapters");
    expect(admin.status).toBe(200);
    expect(admin.body[0]).toMatchObject({
      canManageManagedRuntime: true,
      rollbackTargets: [{ bundleSha256: target.bundleSha256 }],
    });
  });

  it.each([
    ["patch", "/api/adapters/hermes_local/override", { paused: true }],
    ["post", "/api/adapters/hermes_local/reload", {}],
    ["post", "/api/adapters/hermes_local/reinstall", {}],
  ] as const)("blocks ordinary board access to managed %s %s", async (method, url, body) => {
    const response = await request(createApp(ordinaryBoard))[method](url).send(body);
    expect(response.status).toBe(403);
    expect(mocks.setOverridePaused).not.toHaveBeenCalled();
    expect(mocks.reloadExternalAdapter).not.toHaveBeenCalled();
  });

  it.each([
    ["patch", "/api/adapters/hermes_local/override", { paused: true }],
    ["post", "/api/adapters/hermes_local/reload", {}],
    ["post", "/api/adapters/hermes_local/reinstall", {}],
  ] as const)("rejects in-place managed mutation even for an admin via %s %s", async (method, url, body) => {
    const response = await request(createApp(instanceAdmin))[method](url).send(body);
    expect(response.status).toBe(409);
    expect(mocks.setOverridePaused).not.toHaveBeenCalled();
    expect(mocks.reloadExternalAdapter).not.toHaveBeenCalled();
  });
});

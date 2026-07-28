import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createAppMock,
  createDbMock,
  createPortfolioDispatchIngestWorkerMock,
  createTokenomicsWatchSupervisorMock,
  detectPortMock,
  feedbackExportServiceMock,
  feedbackServiceFactoryMock,
  fakeServer,
  profitFlywheelReconcilerMock,
  providerPolicyCanarySchedulerMock,
  portfolioDispatchWorkerMock,
  runHermesTokenomicsWatchMock,
  tokenomicsWatchSupervisorMock,
  factoryBaselineRefreshSupervisorMock,
} = vi.hoisted(() => {
  const createAppMock = vi.fn(async () => ((_: unknown, __: unknown) => {}) as never);
  const createDbMock = vi.fn(() => ({}) as never);
  const portfolioDispatchWorkerMock = {
    start: vi.fn(),
    stop: vi.fn(),
  };
  const createPortfolioDispatchIngestWorkerMock = vi.fn(() => portfolioDispatchWorkerMock);
  const detectPortMock = vi.fn(async (port: number) => port);
  const feedbackExportServiceMock = {
    flushPendingFeedbackTraces: vi.fn(async () => ({ attempted: 0, sent: 0, failed: 0 })),
  };
  const feedbackServiceFactoryMock = vi.fn(() => feedbackExportServiceMock);
  const profitFlywheelReconcilerMock = { start: vi.fn(), stop: vi.fn() };
  const providerPolicyCanarySchedulerMock = { start: vi.fn(), stop: vi.fn() };
  const tokenomicsWatchSupervisorMock = {
    start: vi.fn(),
    stop: vi.fn(),
    snapshot: vi.fn(() => ({
      state: "disabled",
      running: false,
      lastStartedAt: null,
      lastCompletedAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureCode: null,
      lastReportStatus: null,
      lastPromotionStatus: null,
      lastReceiptPath: null,
      freshnessAgeSeconds: null,
      consecutiveFailures: 0,
    })),
  };
  const factoryBaselineRefreshSupervisorMock = {
    start: vi.fn(),
    stop: vi.fn(),
    runOnce: vi.fn(),
    snapshot: vi.fn(() => ({ enabled: false, state: "disabled" })),
  };
  const createTokenomicsWatchSupervisorMock = vi.fn(() => tokenomicsWatchSupervisorMock);
  const runHermesTokenomicsWatchMock = vi.fn(async () => ({}));
  const fakeServer = {
    once: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    listen: vi.fn((_port: number, _host: string, callback?: () => void) => {
      callback?.();
      return fakeServer;
    }),
    close: vi.fn(),
  };

  return {
    createAppMock,
    createDbMock,
    createPortfolioDispatchIngestWorkerMock,
    createTokenomicsWatchSupervisorMock,
    detectPortMock,
    feedbackExportServiceMock,
    feedbackServiceFactoryMock,
    fakeServer,
    profitFlywheelReconcilerMock,
    providerPolicyCanarySchedulerMock,
    portfolioDispatchWorkerMock,
    runHermesTokenomicsWatchMock,
    tokenomicsWatchSupervisorMock,
    factoryBaselineRefreshSupervisorMock,
  };
});

vi.mock("node:http", () => ({
  createServer: vi.fn(() => fakeServer),
}));

vi.mock("detect-port", () => ({
  default: detectPortMock,
}));

vi.mock("@paperclipai/db", () => ({
  createDb: createDbMock,
  ensurePostgresDatabase: vi.fn(),
  getPostgresDataDirectory: vi.fn(),
  inspectMigrations: vi.fn(async () => ({ status: "upToDate" })),
  applyPendingMigrations: vi.fn(),
  reconcilePendingMigrationHistory: vi.fn(async () => ({ repairedMigrations: [] })),
  formatDatabaseBackupResult: vi.fn(() => "ok"),
  runDatabaseBackup: vi.fn(),
  authUsers: {},
  companies: {},
  companyMemberships: {},
  instanceUserRoles: {},
}));

vi.mock("../app.js", () => ({
  createApp: createAppMock,
}));

vi.mock("../config.js", () => ({
  loadConfig: vi.fn(() => ({
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    host: "127.0.0.1",
    port: 3210,
    allowedHostnames: [],
    authBaseUrlMode: "auto",
    authPublicBaseUrl: undefined,
    authDisableSignUp: false,
    databaseMode: "postgres",
    databaseUrl: "postgres://paperclip:paperclip@127.0.0.1:5432/paperclip",
    embeddedPostgresDataDir: "/tmp/paperclip-test-db",
    embeddedPostgresPort: 54329,
    databaseBackupEnabled: false,
    databaseBackupIntervalMinutes: 60,
    databaseBackupRetentionDays: 30,
    databaseBackupDir: "/tmp/paperclip-test-backups",
    serveUi: false,
    uiDevMiddleware: false,
    secretsProvider: "local_encrypted",
    secretsStrictMode: false,
    secretsMasterKeyFilePath: "/tmp/paperclip-master.key",
    storageProvider: "local_disk",
    storageLocalDiskBaseDir: "/tmp/paperclip-storage",
    storageS3Bucket: "paperclip-test",
    storageS3Region: "us-east-1",
    storageS3Endpoint: undefined,
    storageS3Prefix: "",
    storageS3ForcePathStyle: false,
    feedbackExportBackendUrl: "https://telemetry.example.com",
    feedbackExportBackendToken: "telemetry-token",
    heartbeatSchedulerEnabled: false,
    heartbeatSchedulerIntervalMs: 30000,
    companyDeletionEnabled: false,
    factoryMode: "fixture",
    factoryPauseNewWork: true,
    factoryBaselinePointerPath: undefined,
    factoryBaselineRefresh: undefined,
    factoryTokenomicsWatchEnabled: false,
    factoryTokenomicsWatchIntervalSeconds: 300,
    factoryTokenomicsWatchBaselineHours: 360,
    factoryTokenomicsWatchReceiptDir: "/tmp/paperclip-test-tokenomics-watch",
    factoryTokenomicsWatchApplyBalanceOnDrift: false,
    portfolioOsRuntimeRoot: undefined,
    portfolioOsRuntimeManifestPath: undefined,
    posConsumerAttemptReceiptDir: "/tmp/paperclip-test-pos-attempts",
  })),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../realtime/live-events-ws.js", () => ({
  setupLiveEventsWebSocketServer: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  createHealthGatedFactoryLaunchAuthority: vi.fn(() => ({
    claim: vi.fn(async () => ({
      allowed: false,
      code: "factory_test_authority",
      detail: "Startup wiring test authority",
      terminal: false,
    })),
  })),
  createDbFactoryLaunchAuthority: vi.fn(() => ({
    claim: vi.fn(async () => ({
      allowed: false,
      code: "factory_test_db_authority",
      detail: "Startup wiring test DB authority",
      terminal: false,
    })),
  })),
  verifyFactoryLaunchProposalBindings: vi.fn(async () => true),
  createProfitFlywheelReconciler: vi.fn(() => profitFlywheelReconcilerMock),
  createPortfolioDispatchIngestWorker: createPortfolioDispatchIngestWorkerMock,
  createTokenomicsWatchSupervisor: createTokenomicsWatchSupervisorMock,
  createFactoryBaselineRefreshSupervisor: vi.fn(() => factoryBaselineRefreshSupervisorMock),
  crossCompanyAgentMembershipService: vi.fn(() => ({
    ensureForAllCompanies: vi.fn(async () => ({
      companyIds: [],
      policyAgentIds: [],
      inserted: 0,
      updated: 0,
      unchanged: 0,
      skippedMissingAgents: 0,
    })),
  })),
  feedbackService: feedbackServiceFactoryMock,
  flywheelHealthService: vi.fn(() => ({
    persistHourlyReports: vi.fn(async () => ({
      source: "startup",
      windowStart: "2026-06-13T00:00:00.000Z",
      windowEnd: "2026-06-13T01:00:00.000Z",
      companies: 0,
      reportsWritten: 0,
    })),
  })),
  heartbeatService: vi.fn(() => ({
    reapOrphanedRuns: vi.fn(async () => undefined),
    resumeQueuedRuns: vi.fn(async () => undefined),
    tickTimers: vi.fn(async () => ({ enqueued: 0 })),
  })),
  instanceSettingsService: vi.fn(() => ({
    getGeneral: vi.fn(),
  })),
  reconcilePersistedRuntimeServicesOnStartup: vi.fn(async () => ({ reconciled: 0 })),
  routineService: vi.fn(() => ({
    tickScheduledTriggers: vi.fn(async () => ({ triggered: 0 })),
  })),
}));

vi.mock("../ops/provider-policy-canary.js", () => ({
  createProviderPolicyCanaryScheduler: vi.fn(() => providerPolicyCanarySchedulerMock),
}));

vi.mock("../ops/hermes-tokenomics-watch.js", () => ({
  runHermesTokenomicsWatch: runHermesTokenomicsWatchMock,
}));

vi.mock("../services/provider-runtime-profile.js", () => ({
  ProviderRuntimeProfileCleanupError: class ProviderRuntimeProfileCleanupError extends Error {},
  runProviderRuntimeProfileStartupRecovery: vi.fn(async () => ({
    status: "ready",
    cleanup: {
      status: "clean",
      counts: { scanned: 0, preserved: 0, quarantined: 0, removed: 0, failed: 0 },
      receiptSha256: "a".repeat(64),
    },
  })),
  sweepProviderRuntimeProfiles: vi.fn(),
}));

vi.mock("../storage/index.js", () => ({
  createStorageServiceFromConfig: vi.fn(() => ({ id: "storage-service" })),
}));

vi.mock("../services/feedback-share-client.js", () => ({
  createFeedbackTraceShareClientFromConfig: vi.fn(() => ({ id: "feedback-share-client" })),
}));

vi.mock("../startup-banner.js", () => ({
  printStartupBanner: vi.fn(),
}));

vi.mock("../board-claim.js", () => ({
  getBoardClaimWarningUrl: vi.fn(() => null),
  initializeBoardClaimChallenge: vi.fn(async () => undefined),
}));

vi.mock("../auth/better-auth.js", () => ({
  createBetterAuthHandler: vi.fn(() => undefined),
  createBetterAuthInstance: vi.fn(() => ({})),
  deriveAuthTrustedOrigins: vi.fn(() => []),
  resolveBetterAuthSession: vi.fn(async () => null),
  resolveBetterAuthSessionFromHeaders: vi.fn(async () => null),
}));

import { startServer } from "../index.ts";

describe("startServer feedback export wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BETTER_AUTH_SECRET = "test-secret";
  });

  it("passes the feedback export service into createApp so pending traces flush in runtime", async () => {
    const started = await startServer();

    expect(started.server).toBe(fakeServer);
    expect(feedbackServiceFactoryMock).toHaveBeenCalledTimes(1);
    expect(createPortfolioDispatchIngestWorkerMock).toHaveBeenCalledTimes(1);
    expect(portfolioDispatchWorkerMock.start).toHaveBeenCalledTimes(1);
    expect(fakeServer.listen.mock.invocationCallOrder[0]).toBeLessThan(
      portfolioDispatchWorkerMock.start.mock.invocationCallOrder[0]!,
    );
    expect(createAppMock).toHaveBeenCalledTimes(1);
    expect(createAppMock.mock.calls[0]?.[1]).toMatchObject({
      feedbackExportService: feedbackExportServiceMock,
      storageService: { id: "storage-service" },
      serverPort: 3210,
    });
  });

  it("passes the configured tokenomics baseline window into the supervised watch run", async () => {
    await startServer();

    const supervisorOptions = createTokenomicsWatchSupervisorMock.mock.calls[0]?.[0];
    expect(supervisorOptions).toBeDefined();
    if (!supervisorOptions) throw new Error("tokenomics_watch_supervisor_not_created");

    await supervisorOptions.run();

    expect(runHermesTokenomicsWatchMock).toHaveBeenCalledWith(expect.objectContaining({
      connectionString: "postgres://paperclip:paperclip@127.0.0.1:5432/paperclip",
      receiptDir: "/tmp/paperclip-test-tokenomics-watch",
      baselineHours: 360,
      applyBalanceOnDrift: false,
    }));
  });
});

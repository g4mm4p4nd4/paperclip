import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createAppMock,
  createDbMock,
  createPortfolioDispatchIngestWorkerMock,
  detectPortMock,
  feedbackExportServiceMock,
  feedbackServiceFactoryMock,
  fakeServer,
  profitFlywheelReconcilerMock,
  providerPolicyCanarySchedulerMock,
  portfolioDispatchWorkerMock,
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
    detectPortMock,
    feedbackExportServiceMock,
    feedbackServiceFactoryMock,
    fakeServer,
    profitFlywheelReconcilerMock,
    providerPolicyCanarySchedulerMock,
    portfolioDispatchWorkerMock,
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
  createProfitFlywheelReconciler: vi.fn(() => profitFlywheelReconcilerMock),
  createPortfolioDispatchIngestWorker: createPortfolioDispatchIngestWorkerMock,
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
    expect(createAppMock).toHaveBeenCalledTimes(1);
    expect(createAppMock.mock.calls[0]?.[1]).toMatchObject({
      feedbackExportService: feedbackExportServiceMock,
      storageService: { id: "storage-service" },
      serverPort: 3210,
    });
  });
});

/// <reference path="./types/express.d.ts" />
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import type { Request as ExpressRequest, RequestHandler } from "express";
import { and, eq } from "drizzle-orm";
import {
  createDb,
  ensurePostgresDatabase,
  formatEmbeddedPostgresError,
  getPostgresDataDirectory,
  inspectMigrations,
  applyPendingMigrations,
  createEmbeddedPostgresLogBuffer,
  reconcilePendingMigrationHistory,
  formatDatabaseBackupResult,
  runDatabaseBackup,
  authUsers,
  companies,
  companyMemberships,
  heartbeatRuns,
  instanceUserRoles,
} from "@paperclipai/db";
import detectPort from "detect-port";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { persistFactoryPauseNewWork } from "./config-file.js";
import { logger } from "./middleware/logger.js";
import { setupLiveEventsWebSocketServer } from "./realtime/live-events-ws.js";
import {
  feedbackService,
  heartbeatService,
  createProfitFlywheelReconciler,
  createPortfolioDispatchIngestWorker,
  createHealthGatedFactoryLaunchAuthority,
  createDbFactoryLaunchAuthority,
  verifyFactoryLaunchProposalBindings,
  createFactoryBaselineRefreshSupervisor,
  createTokenomicsWatchSupervisor,
  crossCompanyAgentMembershipService,
  flywheelHealthService,
  instanceSettingsService,
  reconcilePersistedRuntimeServicesOnStartup,
  routineService,
} from "./services/index.js";
import { createFeedbackTraceShareClientFromConfig } from "./services/feedback-share-client.js";
import { createStorageServiceFromConfig } from "./storage/index.js";
import { printStartupBanner } from "./startup-banner.js";
import { getBoardClaimWarningUrl, initializeBoardClaimChallenge } from "./board-claim.js";
import { maybePersistWorktreeRuntimePorts } from "./worktree-config.js";
import { initTelemetry, getTelemetryClient } from "./telemetry.js";
import { createProviderPolicyCanaryScheduler } from "./ops/provider-policy-canary.js";
import { notifyProfitFlywheelReconciliation } from "./services/profit-flywheel-reconcile-signal.js";
import {
  resolvePaperclipHomeDir,
  resolvePaperclipInstanceId,
  resolvePaperclipInstanceRoot,
} from "./home-paths.js";
import { runHermesTokenomicsWatch } from "./ops/hermes-tokenomics-watch.js";
import { createFactoryPauseControl } from "./services/factory-pause-control.js";
import {
  collectFactoryBaseline,
  installFactoryBaselineReceipt,
} from "./ops/zero-touch-factory-baseline.js";
import {
  ProviderRuntimeProfileCleanupError,
  runProviderRuntimeProfileStartupRecovery,
  sweepProviderRuntimeProfiles,
} from "./services/provider-runtime-profile.js";

type BetterAuthSessionUser = {
  id: string;
  email?: string | null;
  name?: string | null;
};

type BetterAuthSessionResult = {
  session: { id: string; userId: string } | null;
  user: BetterAuthSessionUser | null;
};

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;


export interface StartedServer {
  server: ReturnType<typeof createServer>;
  host: string;
  listenPort: number;
  apiUrl: string;
  databaseUrl: string;
}

export async function startServer(): Promise<StartedServer> {
  let config = loadConfig();
  initTelemetry({ enabled: config.telemetryEnabled });
  if (process.env.PAPERCLIP_SECRETS_PROVIDER === undefined) {
    process.env.PAPERCLIP_SECRETS_PROVIDER = config.secretsProvider;
  }
  if (process.env.PAPERCLIP_SECRETS_STRICT_MODE === undefined) {
    process.env.PAPERCLIP_SECRETS_STRICT_MODE = config.secretsStrictMode ? "true" : "false";
  }
  if (process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE === undefined) {
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = config.secretsMasterKeyFilePath;
  }
  
  type MigrationSummary =
    | "skipped"
    | "already applied"
    | "applied (empty database)"
    | "applied (pending migrations)";
  
  function formatPendingMigrationSummary(migrations: string[]): string {
    if (migrations.length === 0) return "none";
    return migrations.length > 3
      ? `${migrations.slice(0, 3).join(", ")} (+${migrations.length - 3} more)`
      : migrations.join(", ");
  }
  
  async function promptApplyMigrations(migrations: string[]): Promise<boolean> {
    if (process.env.PAPERCLIP_MIGRATION_AUTO_APPLY === "true") return true;
    if (process.env.PAPERCLIP_MIGRATION_PROMPT === "never") return false;
    if (!stdin.isTTY || !stdout.isTTY) return true;
  
    const prompt = createInterface({ input: stdin, output: stdout });
    try {
      const answer = (await prompt.question(
        `Apply pending migrations (${formatPendingMigrationSummary(migrations)}) now? (y/N): `,
      )).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    } finally {
      prompt.close();
    }
  }
  
  type EnsureMigrationsOptions = {
    autoApply?: boolean;
  };
  
  async function ensureMigrations(
    connectionString: string,
    label: string,
    opts?: EnsureMigrationsOptions,
  ): Promise<MigrationSummary> {
    const autoApply = opts?.autoApply === true;
    let state = await inspectMigrations(connectionString);
    if (state.status === "needsMigrations" && state.reason === "pending-migrations") {
      const repair = await reconcilePendingMigrationHistory(connectionString);
      if (repair.repairedMigrations.length > 0) {
        logger.warn(
          { repairedMigrations: repair.repairedMigrations },
          `${label} had drifted migration history; repaired migration journal entries from existing schema state.`,
        );
        state = await inspectMigrations(connectionString);
        if (state.status === "upToDate") return "already applied";
      }
    }
    if (state.status === "upToDate") return "already applied";
    if (state.status === "needsMigrations" && state.reason === "no-migration-journal-non-empty-db") {
      logger.warn(
        { tableCount: state.tableCount },
        `${label} has existing tables but no migration journal. Run migrations manually to sync schema.`,
      );
      const apply = autoApply ? true : await promptApplyMigrations(state.pendingMigrations);
      if (!apply) {
        throw new Error(
          `${label} has pending migrations (${formatPendingMigrationSummary(state.pendingMigrations)}). ` +
            "Refusing to start against a stale schema. Run pnpm db:migrate or set PAPERCLIP_MIGRATION_AUTO_APPLY=true.",
        );
      }
  
      logger.info({ pendingMigrations: state.pendingMigrations }, `Applying ${state.pendingMigrations.length} pending migrations for ${label}`);
      await applyPendingMigrations(connectionString);
      return "applied (pending migrations)";
    }
  
    const apply = autoApply ? true : await promptApplyMigrations(state.pendingMigrations);
    if (!apply) {
      throw new Error(
        `${label} has pending migrations (${formatPendingMigrationSummary(state.pendingMigrations)}). ` +
          "Refusing to start against a stale schema. Run pnpm db:migrate or set PAPERCLIP_MIGRATION_AUTO_APPLY=true.",
      );
    }
  
    logger.info({ pendingMigrations: state.pendingMigrations }, `Applying ${state.pendingMigrations.length} pending migrations for ${label}`);
    await applyPendingMigrations(connectionString);
    return "applied (pending migrations)";
  }
  
  function isLoopbackHost(host: string): boolean {
    const normalized = host.trim().toLowerCase();
    return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
  }

  function rewriteLocalUrlPort(rawUrl: string | undefined, port: number): string | undefined {
    if (!rawUrl) return undefined;
    try {
      const parsed = new URL(rawUrl);
      if (!isLoopbackHost(parsed.hostname)) return rawUrl;
      parsed.port = String(port);
      return parsed.toString();
    } catch {
      return rawUrl;
    }
  }
  
  const LOCAL_BOARD_USER_ID = "local-board";
  const LOCAL_BOARD_USER_EMAIL = "local@paperclip.local";
  const LOCAL_BOARD_USER_NAME = "Board";
  
  async function ensureLocalTrustedBoardPrincipal(db: any): Promise<void> {
    const now = new Date();
    const existingUser = await db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.id, LOCAL_BOARD_USER_ID))
      .then((rows: Array<{ id: string }>) => rows[0] ?? null);
  
    if (!existingUser) {
      await db.insert(authUsers).values({
        id: LOCAL_BOARD_USER_ID,
        name: LOCAL_BOARD_USER_NAME,
        email: LOCAL_BOARD_USER_EMAIL,
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
      });
    }
  
    const role = await db
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, LOCAL_BOARD_USER_ID), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows: Array<{ id: string }>) => rows[0] ?? null);
    if (!role) {
      await db.insert(instanceUserRoles).values({
        userId: LOCAL_BOARD_USER_ID,
        role: "instance_admin",
      });
    }
  
    const companyRows = await db.select({ id: companies.id }).from(companies);
    for (const company of companyRows) {
      const membership = await db
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, company.id),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, LOCAL_BOARD_USER_ID),
          ),
        )
        .then((rows: Array<{ id: string }>) => rows[0] ?? null);
      if (membership) continue;
      await db.insert(companyMemberships).values({
        companyId: company.id,
        principalType: "user",
        principalId: LOCAL_BOARD_USER_ID,
        status: "active",
        membershipRole: "owner",
      });
    }
  }
  
  let db;
  let embeddedPostgres: EmbeddedPostgresInstance | null = null;
  let embeddedPostgresStartedByThisProcess = false;
  let migrationSummary: MigrationSummary = "skipped";
  let activeDatabaseConnectionString: string;
  let resolvedEmbeddedPostgresPort: number | null = null;
  let startupDbInfo:
    | { mode: "external-postgres"; connectionString: string }
    | { mode: "embedded-postgres"; dataDir: string; port: number };
  if (config.databaseUrl) {
    migrationSummary = await ensureMigrations(config.databaseUrl, "PostgreSQL");
  
    db = createDb(config.databaseUrl);
    logger.info("Using external PostgreSQL via DATABASE_URL/config");
    activeDatabaseConnectionString = config.databaseUrl;
    startupDbInfo = { mode: "external-postgres", connectionString: config.databaseUrl };
  } else {
    const moduleName = "embedded-postgres";
    let EmbeddedPostgres: EmbeddedPostgresCtor;
    try {
      const mod = await import(moduleName);
      EmbeddedPostgres = mod.default as EmbeddedPostgresCtor;
    } catch {
      throw new Error(
        "Embedded PostgreSQL mode requires dependency `embedded-postgres`. Reinstall dependencies (without omitting required packages), or set DATABASE_URL for external Postgres.",
      );
    }
  
    const dataDir = resolve(config.embeddedPostgresDataDir);
    const configuredPort = config.embeddedPostgresPort;
    let port = configuredPort;
    const logBuffer = createEmbeddedPostgresLogBuffer(120);
    const verboseEmbeddedPostgresLogs = process.env.PAPERCLIP_EMBEDDED_POSTGRES_VERBOSE === "true";
    const appendEmbeddedPostgresLog = (message: unknown) => {
      logBuffer.append(message);
      if (!verboseEmbeddedPostgresLogs) {
        return;
      }
      const lines = typeof message === "string"
        ? message.split(/\r?\n/)
        : message instanceof Error
          ? [message.message]
          : [String(message ?? "")];
      for (const lineRaw of lines) {
        const line = lineRaw.trim();
        if (!line) continue;
        logger.info({ embeddedPostgresLog: line }, "embedded-postgres");
      }
    };
    const logEmbeddedPostgresFailure = (phase: "initialise" | "start", err: unknown) => {
      const recentLogs = logBuffer.getRecentLogs();
      if (recentLogs.length > 0) {
        logger.error(
          {
            phase,
            recentLogs,
            err,
          },
          "Embedded PostgreSQL failed; showing buffered startup logs",
        );
      }
    };
  
    if (config.databaseMode === "postgres") {
      logger.warn("Database mode is postgres but no connection string was set; falling back to embedded PostgreSQL");
    }
  
    const clusterVersionFile = resolve(dataDir, "PG_VERSION");
    const clusterAlreadyInitialized = existsSync(clusterVersionFile);
    const postmasterPidFile = resolve(dataDir, "postmaster.pid");
    const isPidRunning = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
  
    const getRunningPid = (): number | null => {
      if (!existsSync(postmasterPidFile)) return null;
      try {
        const pidLine = readFileSync(postmasterPidFile, "utf8").split("\n")[0]?.trim();
        const pid = Number(pidLine);
        if (!Number.isInteger(pid) || pid <= 0) return null;
        if (!isPidRunning(pid)) return null;
        return pid;
      } catch {
        return null;
      }
    };
  
    const runningPid = getRunningPid();
    if (runningPid) {
      logger.warn(`Embedded PostgreSQL already running; reusing existing process (pid=${runningPid}, port=${port})`);
    } else {
      const configuredAdminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${configuredPort}/postgres`;
      try {
        const actualDataDir = await getPostgresDataDirectory(configuredAdminConnectionString);
        if (
          typeof actualDataDir !== "string" ||
          resolve(actualDataDir) !== resolve(dataDir)
        ) {
          throw new Error("reachable postgres does not use the expected embedded data directory");
        }
        await ensurePostgresDatabase(configuredAdminConnectionString, "paperclip");
        logger.warn(
          `Embedded PostgreSQL appears to already be reachable without a pid file; reusing existing server on configured port ${configuredPort}`,
        );
      } catch {
        const detectedPort = await detectPort(configuredPort);
        if (detectedPort !== configuredPort) {
          logger.warn(`Embedded PostgreSQL port is in use; using next free port (requestedPort=${configuredPort}, selectedPort=${detectedPort})`);
        }
        port = detectedPort;
        logger.info(`Using embedded PostgreSQL because no DATABASE_URL set (dataDir=${dataDir}, port=${port})`);
        embeddedPostgres = new EmbeddedPostgres({
          databaseDir: dataDir,
          user: "paperclip",
          password: "paperclip",
          port,
          persistent: true,
          initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
          onLog: appendEmbeddedPostgresLog,
          onError: appendEmbeddedPostgresLog,
        });

        if (!clusterAlreadyInitialized) {
          try {
            await embeddedPostgres.initialise();
          } catch (err) {
            logEmbeddedPostgresFailure("initialise", err);
            throw formatEmbeddedPostgresError(err, {
              fallbackMessage: `Failed to initialize embedded PostgreSQL cluster in ${dataDir} on port ${port}`,
              recentLogs: logBuffer.getRecentLogs(),
            });
          }
        } else {
          logger.info(`Embedded PostgreSQL cluster already exists (${clusterVersionFile}); skipping init`);
        }

        if (existsSync(postmasterPidFile)) {
          logger.warn("Removing stale embedded PostgreSQL lock file");
          rmSync(postmasterPidFile, { force: true });
        }
        try {
          await embeddedPostgres.start();
        } catch (err) {
          logEmbeddedPostgresFailure("start", err);
          throw formatEmbeddedPostgresError(err, {
            fallbackMessage: `Failed to start embedded PostgreSQL on port ${port}`,
            recentLogs: logBuffer.getRecentLogs(),
          });
        }
        embeddedPostgresStartedByThisProcess = true;
      }
    }
  
    const embeddedAdminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
    const dbStatus = await ensurePostgresDatabase(embeddedAdminConnectionString, "paperclip");
    if (dbStatus === "created") {
      logger.info("Created embedded PostgreSQL database: paperclip");
    }
  
    const embeddedConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
    const shouldAutoApplyFirstRunMigrations = !clusterAlreadyInitialized || dbStatus === "created";
    if (shouldAutoApplyFirstRunMigrations) {
      logger.info("Detected first-run embedded PostgreSQL setup; applying pending migrations automatically");
    }
    migrationSummary = await ensureMigrations(embeddedConnectionString, "Embedded PostgreSQL", {
      autoApply: shouldAutoApplyFirstRunMigrations,
    });
  
    db = createDb(embeddedConnectionString);
    logger.info("Embedded PostgreSQL ready");
    activeDatabaseConnectionString = embeddedConnectionString;
    resolvedEmbeddedPostgresPort = port;
    startupDbInfo = { mode: "embedded-postgres", dataDir, port };
  }
  
  if (config.deploymentMode === "local_trusted" && !isLoopbackHost(config.host)) {
    throw new Error(
      `local_trusted mode requires loopback host binding (received: ${config.host}). ` +
        "Use authenticated mode for non-loopback deployments.",
    );
  }
  
  if (config.deploymentMode === "local_trusted" && config.deploymentExposure !== "private") {
    throw new Error("local_trusted mode only supports private exposure");
  }
  
  if (config.deploymentMode === "authenticated") {
    if (config.authBaseUrlMode === "explicit" && !config.authPublicBaseUrl) {
      throw new Error("auth.baseUrlMode=explicit requires auth.publicBaseUrl");
    }
    if (config.deploymentExposure === "public") {
      if (config.authBaseUrlMode !== "explicit") {
        throw new Error("authenticated public exposure requires auth.baseUrlMode=explicit");
      }
      if (!config.authPublicBaseUrl) {
        throw new Error("authenticated public exposure requires auth.publicBaseUrl");
      }
    }
  }
  
  let authReady = config.deploymentMode === "local_trusted";
  let betterAuthHandler: RequestHandler | undefined;
  let resolveSession:
    | ((req: ExpressRequest) => Promise<BetterAuthSessionResult | null>)
    | undefined;
  let resolveSessionFromHeaders:
    | ((headers: Headers) => Promise<BetterAuthSessionResult | null>)
    | undefined;
  if (config.deploymentMode === "local_trusted") {
    await ensureLocalTrustedBoardPrincipal(db as any);
  }
  const crossCompanyMemberships = await crossCompanyAgentMembershipService(db as any).ensureForAllCompanies();
  if (crossCompanyMemberships.inserted > 0 || crossCompanyMemberships.updated > 0) {
    logger.info(
      {
        companyCount: crossCompanyMemberships.companyIds.length,
        policyAgentIds: crossCompanyMemberships.policyAgentIds,
        inserted: crossCompanyMemberships.inserted,
        updated: crossCompanyMemberships.updated,
        unchanged: crossCompanyMemberships.unchanged,
        skippedMissingAgents: crossCompanyMemberships.skippedMissingAgents,
      },
      "Cross-company agent memberships reconciled",
    );
  }
  if (config.deploymentMode === "authenticated") {
    const {
      createBetterAuthHandler,
      createBetterAuthInstance,
      deriveAuthTrustedOrigins,
      resolveBetterAuthSession,
      resolveBetterAuthSessionFromHeaders,
    } = await import("./auth/better-auth.js");
    const derivedTrustedOrigins = deriveAuthTrustedOrigins(config);
    const envTrustedOrigins = (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    const effectiveTrustedOrigins = Array.from(new Set([...derivedTrustedOrigins, ...envTrustedOrigins]));
    logger.info(
      {
        authBaseUrlMode: config.authBaseUrlMode,
        authPublicBaseUrl: config.authPublicBaseUrl ?? null,
        trustedOrigins: effectiveTrustedOrigins,
        trustedOriginsSource: {
          derived: derivedTrustedOrigins.length,
          env: envTrustedOrigins.length,
        },
      },
      "Authenticated mode auth origin configuration",
    );
    const auth = createBetterAuthInstance(db as any, config, effectiveTrustedOrigins);
    betterAuthHandler = createBetterAuthHandler(auth);
    resolveSession = (req) => resolveBetterAuthSession(auth, req);
    resolveSessionFromHeaders = (headers) => resolveBetterAuthSessionFromHeaders(auth, headers);
    await initializeBoardClaimChallenge(db as any, { deploymentMode: config.deploymentMode });
    authReady = true;
  }
  
  const listenPort = await detectPort(config.port);
  if (listenPort !== config.port) {
    config.port = listenPort;
  }
  if (resolvedEmbeddedPostgresPort !== null && resolvedEmbeddedPostgresPort !== config.embeddedPostgresPort) {
    config.embeddedPostgresPort = resolvedEmbeddedPostgresPort;
  }
  if (config.authBaseUrlMode === "explicit" && config.authPublicBaseUrl) {
    config.authPublicBaseUrl = rewriteLocalUrlPort(config.authPublicBaseUrl, listenPort);
  }
  maybePersistWorktreeRuntimePorts({
    serverPort: listenPort,
    databasePort: resolvedEmbeddedPostgresPort,
  });
  const uiMode = config.uiDevMiddleware ? "vite-dev" : config.serveUi ? "static" : "none";
  const storageService = createStorageServiceFromConfig(config);
  const feedback = feedbackService(db as any, {
    shareClient: createFeedbackTraceShareClientFromConfig(config),
  });
  const tokenomicsWatch = createTokenomicsWatchSupervisor({
    enabled: config.factoryTokenomicsWatchEnabled,
    intervalSeconds: config.factoryTokenomicsWatchIntervalSeconds,
    run: () => runHermesTokenomicsWatch({
      connectionString: activeDatabaseConnectionString,
      homeDir: resolvePaperclipHomeDir(),
      instanceId: resolvePaperclipInstanceId(),
      receiptDir: config.factoryTokenomicsWatchReceiptDir,
      baselineHours: config.factoryTokenomicsWatchBaselineHours,
      applyBalanceOnDrift: config.factoryTokenomicsWatchApplyBalanceOnDrift,
    }),
    onSuccess: (snapshot) => logger.info({
      state: snapshot.state,
      reportStatus: snapshot.lastReportStatus,
      receiptPath: snapshot.lastReceiptPath,
      freshnessAgeSeconds: snapshot.freshnessAgeSeconds,
    }, "supervised tokenomics watch completed"),
    onFailure: (_error, snapshot) => logger.error({
      state: snapshot.state,
      failureCode: snapshot.lastFailureCode,
      consecutiveFailures: snapshot.consecutiveFailures,
      freshnessAgeSeconds: snapshot.freshnessAgeSeconds,
    }, "supervised tokenomics watch failed"),
  });
  const baselineRefreshConfig = config.factoryBaselineRefresh;
  const baselineRefresh = createFactoryBaselineRefreshSupervisor({
    enabled: baselineRefreshConfig?.enabled ?? false,
    intervalSeconds: baselineRefreshConfig?.intervalSeconds ?? 60,
    run: async () => {
      if (!baselineRefreshConfig) throw new Error("factory_baseline_refresh_unconfigured");
      const tokenomicsSnapshot = tokenomicsWatch.snapshot();
      if (tokenomicsSnapshot.state !== "healthy" || tokenomicsSnapshot.lastReportStatus !== "pass" ||
          !tokenomicsSnapshot.lastReceiptPath) {
        throw new Error("factory_baseline_refresh_tokenomics_unhealthy");
      }
      const tokenomicsReceiptPath = tokenomicsSnapshot.lastReceiptPath;
      const receipt = await collectFactoryBaseline(db as any, {
        companyId: baselineRefreshConfig.companyId,
        targetWorkflowRunId: baselineRefreshConfig.workflowRunId,
        instanceRoot: baselineRefreshConfig.instanceRoot,
        pluginStorePath: baselineRefreshConfig.pluginStorePath,
        tokenomicsReceiptPath,
        repositories: [
          { name: "portfolio-os", path: baselineRefreshConfig.repositories.portfolioOs },
          { name: "paperclip", path: baselineRefreshConfig.repositories.paperclip },
          { name: "hermes-agent", path: baselineRefreshConfig.repositories.hermesAgent },
          { name: "hermes-paperclip-adapter", path: baselineRefreshConfig.repositories.hermesPaperclipAdapter },
        ],
      });
      const installed = await installFactoryBaselineReceipt(baselineRefreshConfig.instanceRoot, receipt);
      if (config.factoryBaselinePointerPath && installed.pointerPath !== config.factoryBaselinePointerPath) {
        throw new Error("factory_baseline_refresh_pointer_mismatch");
      }
      return installed;
    },
    onSuccess: (snapshot) => logger.info({
      state: snapshot.state,
      receiptPath: snapshot.lastReceiptPath,
      receiptSha256: snapshot.lastReceiptSha256,
      freshnessAgeSeconds: snapshot.freshnessAgeSeconds,
    }, "supervised factory baseline refresh completed"),
    onFailure: (_error, snapshot) => logger.error({
      state: snapshot.state,
      failureCode: snapshot.lastFailureCode,
      consecutiveFailures: snapshot.consecutiveFailures,
      freshnessAgeSeconds: snapshot.freshnessAgeSeconds,
    }, "supervised factory baseline refresh failed"),
  });
  const factoryPause = createFactoryPauseControl({
    initiallyPaused: config.factoryPauseNewWork,
    persistPause: () => persistFactoryPauseNewWork(true),
  });
  const liveFactoryLaunchAuthority = createDbFactoryLaunchAuthority(db as any, {
    receiptDir: resolve(resolvePaperclipInstanceRoot(), "data/ops/factory-launch-approvals"),
    verifyBindings: async (payload) => {
      if (!config.portfolioOsRuntimeRoot) return false;
      try {
        return await verifyFactoryLaunchProposalBindings(
          db as any,
          payload,
          config.portfolioOsRuntimeRoot,
        );
      } catch {
        return false;
      }
    },
  });
  const factoryLaunchAuthority = createHealthGatedFactoryLaunchAuthority(db as any, {
    mode: config.factoryMode,
    pauseNewWork: factoryPause.isPaused,
    baselinePointerPath: config.factoryBaselinePointerPath,
    portfolioOsRuntimeRoot: config.portfolioOsRuntimeRoot,
    liveAuthority: liveFactoryLaunchAuthority,
  });
  const app = await createApp(db as any, {
    uiMode,
    serverPort: listenPort,
    storageService,
    feedbackExportService: feedback,
    deploymentMode: config.deploymentMode,
    deploymentExposure: config.deploymentExposure,
    allowedHostnames: config.allowedHostnames,
    allowedClientIps: config.allowedClientIps,
    bindHost: config.host,
    authReady,
    companyDeletionEnabled: config.companyDeletionEnabled,
    betterAuthHandler,
    resolveSession,
    factoryHealth: {
      mode: config.factoryMode,
      pauseNewWork: factoryPause.isPaused,
      pause: factoryPause.pause,
      baselinePointerPath: config.factoryBaselinePointerPath,
      portfolioOsRuntimeRoot: config.portfolioOsRuntimeRoot,
    },
    factoryLaunchAuthority,
    tokenomicsWatchSnapshot: () => tokenomicsWatch.snapshot(),
    factoryBaselineRefreshSnapshot: () => baselineRefresh.snapshot(),
  });
  const server = createServer(app as unknown as Parameters<typeof createServer>[0]);

  // Increase keep-alive timeouts to safely outlive default idle timeouts
  // of common reverse proxies and load balancers (like AWS ALB, Nginx, or Traefik).
  // This prevents intermittent 502/ECONNRESET errors caused by Node's 5s default.
  server.keepAliveTimeout = 185000;
  server.headersTimeout = 186000;
  
  if (listenPort !== config.port) {
    logger.warn(`Requested port is busy; using next free port (requestedPort=${config.port}, selectedPort=${listenPort})`);
  }
  
  const runtimeListenHost = config.host;
  const runtimeApiHost =
    runtimeListenHost === "0.0.0.0" || runtimeListenHost === "::"
      ? "localhost"
      : runtimeListenHost;
  process.env.PAPERCLIP_LISTEN_HOST = runtimeListenHost;
  process.env.PAPERCLIP_LISTEN_PORT = String(listenPort);
  process.env.PAPERCLIP_API_URL = `http://${runtimeApiHost}:${listenPort}`;
  
  setupLiveEventsWebSocketServer(server, db as any, {
    deploymentMode: config.deploymentMode,
    resolveSessionFromHeaders,
  });

  void reconcilePersistedRuntimeServicesOnStartup(db as any)
    .then((result) => {
      if (result.reconciled > 0) {
        logger.warn(
          { reconciled: result.reconciled },
          "reconciled persisted runtime services from a previous server process",
        );
      }
    })
    .catch((err) => {
      logger.error({ err }, "startup reconciliation of persisted runtime services failed");
    });

  const heartbeat = heartbeatService(db as any);
  const providerRuntimeRecovery = await runProviderRuntimeProfileStartupRecovery({
    reapOrphanedRuns: () => heartbeat.reapOrphanedRuns(),
    sweepProviderRuntimeProfiles: () => sweepProviderRuntimeProfiles({
      instanceRoot: resolvePaperclipInstanceRoot(),
      resolveRunAuthority: async (companyId, executionId) => db
        .select({
          status: heartbeatRuns.status,
          processPid: heartbeatRuns.processPid,
          processGroupId: heartbeatRuns.processGroupId,
        })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, executionId)))
        .then((rows) => rows[0] ?? null),
    }),
    resumeQueuedRuns: config.heartbeatSchedulerEnabled
      ? () => heartbeat.resumeQueuedRuns()
      : async () => undefined,
  });
  if (providerRuntimeRecovery.status === "blocked") {
    logger.error(
      {
        failure: providerRuntimeRecovery.failure,
        cleanup: {
          status: providerRuntimeRecovery.cleanup.status,
          counts: providerRuntimeRecovery.cleanup.counts,
          receiptSha256: providerRuntimeRecovery.cleanup.receiptSha256,
        },
      },
      "provider runtime profile startup recovery blocked provider work",
    );
    throw new ProviderRuntimeProfileCleanupError(providerRuntimeRecovery.failure);
  }
  logger.info(
    {
      status: providerRuntimeRecovery.cleanup.status,
      counts: providerRuntimeRecovery.cleanup.counts,
      receiptSha256: providerRuntimeRecovery.cleanup.receiptSha256,
    },
    "provider runtime profile startup recovery completed",
  );

  const portfolioDispatch = createPortfolioDispatchIngestWorker(db as any, {
    pollIntervalMs: config.heartbeatSchedulerIntervalMs,
    factoryMode: config.factoryMode,
    factoryPauseNewWork: factoryPause.isPaused,
    factoryLaunchAuthority,
  });
  const profitFlywheelReconciler = createProfitFlywheelReconciler(db as any, {
    reconciliationIntervalMs: Math.max(30_000, config.heartbeatSchedulerIntervalMs),
    runtimeRoot: config.portfolioOsRuntimeRoot,
    runtimeManifestPath: config.factoryMode === "fixture" && !config.portfolioOsRuntimeRoot
      ? config.portfolioOsRuntimeManifestPath
      : undefined,
    attemptReceiptDirectory: config.posConsumerAttemptReceiptDir,
    factoryMode: config.factoryMode,
    factoryPauseNewWork: factoryPause.isPaused,
    factoryLaunchAuthority,
  });
  const providerPolicyCanaryScheduler = createProviderPolicyCanaryScheduler(db as any, {
    onRefresh: () => notifyProfitFlywheelReconciliation(),
  });
  
  if (config.heartbeatSchedulerEnabled) {
    const routines = routineService(db as any);
    let heartbeatTickInFlight = false;
    setInterval(() => {
      if (heartbeatTickInFlight) {
        logger.debug("skipping heartbeat tick because the previous tick is still running");
        return;
      }
      heartbeatTickInFlight = true;
      void (async () => {
        const scheduledAt = new Date();
        const [timerResult, routineResult] = await Promise.allSettled([
          heartbeat.tickTimers(scheduledAt),
          routines.tickScheduledTriggers(scheduledAt),
        ]);

        if (timerResult.status === "fulfilled") {
          const result = timerResult.value;
          const activeSkips = result.skippedByReason.already_active ?? 0;
          const attentionSkips = result.skipped - activeSkips;
          if (result.enqueued > 0 || attentionSkips > 0) {
            logger.info({ ...result }, "heartbeat timer tick completed");
          } else if (result.due > 0 && result.skipped > 0) {
            logger.debug({ ...result }, "heartbeat timer tick skipped due agents");
          }
        } else {
          logger.error({ err: timerResult.reason }, "heartbeat timer tick failed");
        }

        if (routineResult.status === "fulfilled") {
          const result = routineResult.value;
          if (result.triggered > 0) {
            logger.info({ ...result }, "routine scheduler tick completed");
          }
        } else {
          logger.error({ err: routineResult.reason }, "routine scheduler tick failed");
        }

        // Periodically reap orphaned runs (5-min staleness threshold) and make sure
        // persisted queued work is still being driven forward.
        try {
          await heartbeat.reapOrphanedRuns({ staleThresholdMs: 5 * 60 * 1000 });
          await heartbeat.resumeQueuedRuns();
        } catch (err) {
          logger.error({ err }, "periodic heartbeat recovery failed");
        }
      })().finally(() => {
        heartbeatTickInFlight = false;
      });
    }, config.heartbeatSchedulerIntervalMs);
  }

  const flywheelHealth = flywheelHealthService(db as any);
  const flywheelHealthIntervalMs = 60 * 60 * 1000;
  let flywheelHealthInFlight = false;
  const runFlywheelHealthSnapshot = async (source: "scheduler" | "startup") => {
    if (flywheelHealthInFlight) {
      logger.debug("skipping flywheel health snapshot because the previous snapshot is still running");
      return;
    }
    flywheelHealthInFlight = true;
    try {
      const result = await flywheelHealth.persistHourlyReports({ source });
      logger.info(
        {
          source: result.source,
          windowStart: result.windowStart,
          windowEnd: result.windowEnd,
          companies: result.companies,
          reportsWritten: result.reportsWritten,
        },
        "flywheel health snapshot written",
      );
    } catch (err) {
      logger.error({ err }, "flywheel health snapshot failed");
    } finally {
      flywheelHealthInFlight = false;
    }
  };
  void runFlywheelHealthSnapshot("startup");
  setInterval(() => {
    void runFlywheelHealthSnapshot("scheduler");
  }, flywheelHealthIntervalMs);
  
  if (config.databaseBackupEnabled) {
    const backupIntervalMs = config.databaseBackupIntervalMinutes * 60 * 1000;
    const settingsSvc = instanceSettingsService(db);
    const keepLatestBackups = 2;
    let backupInFlight = false;

    const runScheduledBackup = async () => {
      if (backupInFlight) {
        logger.warn("Skipping scheduled database backup because a previous backup is still running");
        return;
      }

      backupInFlight = true;
      try {
        // Read retention from Instance Settings (DB) so changes take effect without restart
        const generalSettings = await settingsSvc.getGeneral();
        const retentionDays = generalSettings.backupRetention.dailyDays;

        const result = await runDatabaseBackup({
          connectionString: activeDatabaseConnectionString,
          backupDir: config.databaseBackupDir,
          retentionDays,
          keepLatestBackups,
          filenamePrefix: "paperclip",
          compression: "gzip",
        });
        logger.info(
          {
            backupFile: result.backupFile,
            sizeBytes: result.sizeBytes,
            prunedCount: result.prunedCount,
            backupDir: config.databaseBackupDir,
            retentionDays,
          },
          `Automatic database backup complete: ${formatDatabaseBackupResult(result)}`,
        );
      } catch (err) {
        logger.error({ err, backupDir: config.databaseBackupDir }, "Automatic database backup failed");
      } finally {
        backupInFlight = false;
      }
    };

    logger.info(
      {
        intervalMinutes: config.databaseBackupIntervalMinutes,
        retentionSource: "instance-settings-db",
        keepLatestBackups,
        backupDir: config.databaseBackupDir,
      },
      "Automatic database backups enabled",
    );
    setInterval(() => {
      void runScheduledBackup();
    }, backupIntervalMs);
  }
  
  // Wait for external adapters to finish loading before accepting requests.
  // Without this, adapter type validation (assertKnownAdapterType) would
  // reject valid external adapter types during the startup loading window.
  const { waitForExternalAdapters } = await import("./adapters/registry.js");
  await waitForExternalAdapters();

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (err: Error) => {
      server.off("error", onError);
      rejectListen(err);
    };

    server.once("error", onError);
    server.listen(listenPort, config.host, () => {
      server.off("error", onError);
      // External POS consumers call this HTTP server. Start their event-driven
      // drain only after listen readiness so restarts never burn retry budget
      // on a guaranteed connection-refused window.
      profitFlywheelReconciler.start();
      portfolioDispatch.start();
      providerPolicyCanaryScheduler.start();
      tokenomicsWatch.start();
      baselineRefresh.start();
      logger.info(`Server listening on ${config.host}:${listenPort}`);
      if (process.env.PAPERCLIP_OPEN_ON_LISTEN === "true") {
        const openHost = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
        const url = `http://${openHost}:${listenPort}`;
        void import("open")
          .then((mod) => mod.default(url))
          .then(() => {
            logger.info(`Opened browser at ${url}`);
          })
          .catch((err) => {
            logger.warn({ err, url }, "Failed to open browser on startup");
          });
      }
      printStartupBanner({
        host: config.host,
        deploymentMode: config.deploymentMode,
        deploymentExposure: config.deploymentExposure,
        authReady,
        requestedPort: config.port,
        listenPort,
        uiMode,
        db: startupDbInfo,
        migrationSummary,
        heartbeatSchedulerEnabled: config.heartbeatSchedulerEnabled,
        heartbeatSchedulerIntervalMs: config.heartbeatSchedulerIntervalMs,
        databaseBackupEnabled: config.databaseBackupEnabled,
        databaseBackupIntervalMinutes: config.databaseBackupIntervalMinutes,
        databaseBackupRetentionDays: config.databaseBackupRetentionDays,
        databaseBackupKeepLatestBackups: 2,
        databaseBackupDir: config.databaseBackupDir,
      });

      const boardClaimUrl = getBoardClaimWarningUrl(config.host, listenPort);
      if (boardClaimUrl) {
        const red = "\x1b[41m\x1b[30m";
        const yellow = "\x1b[33m";
        const reset = "\x1b[0m";
        console.log(
          [
            `${red}  BOARD CLAIM REQUIRED  ${reset}`,
            `${yellow}This instance was previously local_trusted and still has local-board as the only admin.${reset}`,
            `${yellow}Sign in with a real user and open this one-time URL to claim ownership:${reset}`,
            `${yellow}${boardClaimUrl}${reset}`,
            `${yellow}If you are connecting over Tailscale, replace the host in this URL with your Tailscale IP/MagicDNS name.${reset}`,
          ].join("\n"),
        );
      }

      resolveListen();
    });
  });
  
  {
    const shutdown = async (signal: "SIGINT" | "SIGTERM") => {
      profitFlywheelReconciler.stop();
      providerPolicyCanaryScheduler.stop();
      portfolioDispatch.stop();
      tokenomicsWatch.stop();
      baselineRefresh.stop();
      const telemetryClient = getTelemetryClient();
      if (telemetryClient) {
        telemetryClient.stop();
        await telemetryClient.flush();
      }

      if (embeddedPostgres && embeddedPostgresStartedByThisProcess) {
        logger.info({ signal }, "Stopping embedded PostgreSQL");
        try {
          await embeddedPostgres?.stop();
        } catch (err) {
          logger.error({ err }, "Failed to stop embedded PostgreSQL cleanly");
        }
      }

      process.exit(0);
    };

    process.once("SIGINT", () => {
      void shutdown("SIGINT");
    });
    process.once("SIGTERM", () => {
      void shutdown("SIGTERM");
    });
  }

  return {
    server,
    host: config.host,
    listenPort,
    apiUrl: process.env.PAPERCLIP_API_URL ?? `http://${runtimeApiHost}:${listenPort}`,
    databaseUrl: activeDatabaseConnectionString,
  };
}

function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(resolve(entry)).href === metaUrl;
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) {
  void startServer().catch((err) => {
    logger.error({ err }, "Paperclip server failed to start");
    process.exit(1);
  });
}

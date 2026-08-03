import { createHash, randomBytes } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse as parseEnvFileContents } from "dotenv";
import { and, eq } from "drizzle-orm";
import {
  createDb,
  researchPortfolioPromotionDecisions,
  type ResearchPortfolioPromotionDecision,
} from "@paperclipai/db";
import { researchPortfolioPromotionService } from "../services/research-portfolio-promotion.js";

const DEFAULT_HOME = "/Users/mnm/.paperclip-local/portfolio-os-cockpit";
const DEFAULT_INSTANCE_ID = "default";
const SHA256_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ConfigFile = {
  database?: {
    connectionString?: string;
    embeddedPostgresPort?: number;
  };
};

type PortfolioLane = {
  lane_id: string;
  outcome: {
    hard_gate_pass: boolean;
    failed_gates: string[];
  };
};

type ResearchPortfolio = {
  schema_version: string;
  portfolio_run_id: string;
  immutable: boolean;
  promotion_requested: boolean;
  disposition: string;
  promoted_lane_id: string | null;
  lanes: PortfolioLane[];
};

export type ResearchPortfolioPromotionOptions = {
  companyId: string;
  portfolioPath: string;
  receiptPath: string;
  homeDir?: string;
  instanceId?: string;
  connectionString?: string;
};

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readImmutableJson<T>(filePath: string): Promise<{ bytes: Buffer; value: T }> {
  const canonicalPath = path.resolve(filePath);
  if (canonicalPath !== filePath || !path.isAbsolute(filePath)) {
    throw new Error(`Artifact path must be canonical and absolute: ${filePath}`);
  }
  const metadata = await lstat(canonicalPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o222) !== 0) {
    throw new Error(`Artifact must be an immutable regular file: ${canonicalPath}`);
  }
  const bytes = await readFile(canonicalPath);
  return { bytes, value: JSON.parse(bytes.toString("utf8")) as T };
}

async function writeImmutableJson(filePath: string, value: unknown) {
  const canonicalPath = path.resolve(filePath);
  if (canonicalPath !== filePath || !path.isAbsolute(filePath)) {
    throw new Error("Receipt path must be canonical and absolute");
  }
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  await mkdir(path.dirname(canonicalPath), { recursive: true, mode: 0o700 });
  try {
    const existing = await readImmutableJson<unknown>(canonicalPath);
    if (!existing.bytes.equals(bytes)) throw new Error(`Immutable receipt collision: ${canonicalPath}`);
    return { path: canonicalPath, sha256: sha256(bytes), bytes: bytes.length, reused: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporaryPath = path.join(
    path.dirname(canonicalPath),
    `.${path.basename(canonicalPath)}.${randomBytes(12).toString("hex")}.tmp`,
  );
  const handle = await open(temporaryPath, "wx", 0o400);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporaryPath, canonicalPath);
    await chmod(canonicalPath, 0o400);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return { path: canonicalPath, sha256: sha256(bytes), bytes: bytes.length, reused: false };
}

function validatePortfolio(portfolio: ResearchPortfolio) {
  if (
    portfolio.schema_version !== "pos.research_portfolio.v1" ||
    portfolio.immutable !== true ||
    portfolio.promotion_requested !== false ||
    !Array.isArray(portfolio.lanes) ||
    portfolio.lanes.length !== 5
  ) {
    throw new Error("Portfolio artifact is not an immutable five-lane research-only authority");
  }
  if (
    (portfolio.disposition !== "research_only" && portfolio.disposition !== "no_go") ||
    portfolio.promoted_lane_id !== null
  ) {
    throw new Error("Portfolio artifact attempted an unsupported promotion");
  }
  if (!portfolio.portfolio_run_id || portfolio.lanes.some((lane) => (
    !lane.lane_id ||
    typeof lane.outcome?.hard_gate_pass !== "boolean" ||
    !Array.isArray(lane.outcome?.failed_gates)
  ))) {
    throw new Error("Portfolio artifact has incomplete lane outcomes");
  }
}

export function deriveResearchPortfolioPromotionDecision(
  portfolio: ResearchPortfolio,
): ResearchPortfolioPromotionDecision {
  validatePortfolio(portfolio);
  const incompleteLanes = portfolio.lanes.filter((lane) => !lane.outcome.hard_gate_pass);
  return {
    schema_version: "paperclip.research_portfolio_promotion_decision.v1",
    disposition: portfolio.disposition as "research_only" | "no_go",
    winner_count: 0,
    winner_lane_id: null,
    reasons: incompleteLanes.length > 0
      ? [`${incompleteLanes.length} lane(s) retain noncompensating hard-gate failures`]
      : ["The signed scheduled wave requested research only and selected no winner"],
    non_compensating_gates_complete: incompleteLanes.length === 0,
  };
}

async function readConfig(homeDir: string, instanceId: string): Promise<ConfigFile> {
  const configPath = path.join(homeDir, "instances", instanceId, "config.json");
  return JSON.parse(await readFile(configPath, "utf8")) as ConfigFile;
}

async function loadInstanceEnvFile(homeDir: string, instanceId: string) {
  const envPath = path.join(homeDir, "instances", instanceId, ".env");
  const contents = await readFile(envPath, "utf8").catch(() => "");
  const parsed = parseEnvFileContents(contents);
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] !== undefined) continue;
    if (typeof value === "string" && value.trim()) process.env[key] = value;
  }
}

function resolveConnectionString(config: ConfigFile, explicit?: string) {
  if (explicit?.trim()) return { connectionString: explicit.trim(), source: "injected" };
  if (process.env.DATABASE_URL?.trim()) {
    return { connectionString: process.env.DATABASE_URL.trim(), source: "DATABASE_URL" };
  }
  if (config.database?.connectionString?.trim()) {
    return {
      connectionString: config.database.connectionString.trim(),
      source: "config.database.connectionString",
    };
  }
  const port = config.database?.embeddedPostgresPort ?? 54329;
  return {
    connectionString: `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`,
    source: `embedded-postgres@${port}`,
  };
}

export async function runResearchPortfolioPromotion(options: ResearchPortfolioPromotionOptions) {
  if (!UUID_RE.test(options.companyId)) throw new Error("Company id must be a UUID");
  const homeDir = options.homeDir ?? DEFAULT_HOME;
  const instanceId = options.instanceId ?? DEFAULT_INSTANCE_ID;
  await loadInstanceEnvFile(homeDir, instanceId);
  const config = options.connectionString ? {} : await readConfig(homeDir, instanceId);
  const connection = resolveConnectionString(config, options.connectionString);
  const portfolioArtifact = await readImmutableJson<ResearchPortfolio>(options.portfolioPath);
  const portfolioSha256 = sha256(portfolioArtifact.bytes);
  if (!SHA256_RE.test(portfolioSha256)) throw new Error("Portfolio artifact hash is invalid");
  const decision = deriveResearchPortfolioPromotionDecision(portfolioArtifact.value);
  const db = createDb(connection.connectionString);
  try {
    const recorded = await researchPortfolioPromotionService(db).record({
      companyId: options.companyId,
      portfolioRunId: portfolioArtifact.value.portfolio_run_id,
      portfolioArtifactPath: options.portfolioPath,
      portfolioSha256,
      decision,
    });
    const rows = await db
      .select()
      .from(researchPortfolioPromotionDecisions)
      .where(and(
        eq(researchPortfolioPromotionDecisions.companyId, options.companyId),
        eq(researchPortfolioPromotionDecisions.portfolioRunId, portfolioArtifact.value.portfolio_run_id),
      ));
    if (rows.length !== 1 || rows[0]?.id !== recorded.row.id) {
      throw new Error("Database promotion idempotency cardinality is not exactly one");
    }
    const receipt = {
      schema_version: "paperclip.research_portfolio_promotion_receipt.v1",
      status: "accepted",
      generated_at: new Date().toISOString(),
      company_id: options.companyId,
      portfolio_run_id: portfolioArtifact.value.portfolio_run_id,
      portfolio: {
        path: options.portfolioPath,
        sha256: portfolioSha256,
      },
      decision,
      database: {
        decision_id: recorded.row.id,
        input_hash: recorded.inputHash,
        decision_hash: recorded.decisionHash,
        replayed: recorded.replayed,
        matching_row_count: rows.length,
        duplicate_rows_absent: true,
      },
      connection_source: connection.source,
      secrets_exposed: false,
      immutable: true,
    };
    const artifact = await writeImmutableJson(options.receiptPath, receipt);
    return { ...receipt, receipt: artifact };
  } finally {
    await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  }
}

type CliOptions = Omit<ResearchPortfolioPromotionOptions, "connectionString">;

export function parseResearchPortfolioPromotionArgs(argv: string[]): CliOptions {
  const parsed: Partial<CliOptions> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--company-id") parsed.companyId = argv[++index];
    else if (arg === "--portfolio") parsed.portfolioPath = argv[++index];
    else if (arg === "--receipt") parsed.receiptPath = argv[++index];
    else if (arg === "--home") parsed.homeDir = argv[++index];
    else if (arg === "--instance") parsed.instanceId = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage: pnpm ops:research-portfolio-promotion --company-id <uuid> --portfolio <path> --receipt <path>",
        "",
        "The database connection is resolved from the instance environment/config and is never accepted in argv.",
      ].join("\n"));
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!parsed.companyId || !parsed.portfolioPath || !parsed.receiptPath) {
    throw new Error("--company-id, --portfolio, and --receipt are required");
  }
  return parsed as CliOptions;
}

async function main() {
  const result = await runResearchPortfolioPromotion(
    parseResearchPortfolioPromotionArgs(process.argv.slice(2)),
  );
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}

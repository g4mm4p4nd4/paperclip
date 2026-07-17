/**
 * External adapter plugin loader.
 *
 * Loads external adapter packages from the adapter-plugin-store and returns
 * their ServerAdapterModule instances. The caller (registry.ts) is
 * responsible for registering them.
 *
 * This avoids circular initialization: plugin-loader imports only
 * adapter-utils, never registry.ts.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ServerAdapterModule } from "./types.js";
import { logger } from "../middleware/logger.js";

import {
  listAdapterPlugins,
  getAdapterPluginsDir,
  getAdapterPluginByType,
} from "../services/adapter-plugin-store.js";
import type { AdapterPluginRecord } from "../services/adapter-plugin-store.js";
import {
  verifyManagedAdapterBundleIdentity,
  verifyManagedAdapterPluginRecord,
  type ManagedAdapterBundleIdentity,
} from "../services/managed-adapter-bundle.js";

// ---------------------------------------------------------------------------
// In-memory UI parser cache
// ---------------------------------------------------------------------------

const uiParserCache = new Map<string, string>();

export type ExternalAdapterRuntimeProvenance = Readonly<
  | {
      kind: "external";
      installKind: "npm" | "local_path";
      packageName: string;
      packageRoot: string;
      modulePath: string;
      moduleSha256: string;
    }
  | {
      kind: "managed_immutable_bundle";
      packageName: string;
      packageVersion: string;
      packageRoot: string;
      modulePath: string;
      moduleSha256: string;
      bundleSha256: string;
      manifestSha256: string;
      payloadTreeSha256: string;
      installReceiptSha256: string;
      sourceGitHead: string;
      sourceGitTree: string;
      files: ManagedAdapterBundleIdentity["files"];
    }
>;

const externalAdapterProvenance = new WeakMap<ServerAdapterModule, ExternalAdapterRuntimeProvenance>();

function recordExternalAdapterProvenance(
  adapter: ServerAdapterModule,
  packageName: string,
  packageDir: string,
  modulePath: string,
  externalInstallKind: "npm" | "local_path",
  managedBundle?: ManagedAdapterBundleIdentity,
) {
  const canonicalRoot = fs.realpathSync(packageDir);
  const canonicalModule = fs.realpathSync(modulePath);
  const relative = path.relative(canonicalRoot, canonicalModule);
  if (
    canonicalRoot !== path.resolve(packageDir) ||
    canonicalModule !== path.resolve(modulePath) ||
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`External adapter "${packageName}" entry point is not a canonical file within its package root.`);
  }
  const moduleStat = fs.lstatSync(canonicalModule);
  if (!moduleStat.isFile() || moduleStat.isSymbolicLink()) {
    throw new Error(`External adapter "${packageName}" entry point is not a regular file.`);
  }
  const common = {
    packageName,
    packageRoot: canonicalRoot,
    modulePath: canonicalModule,
    moduleSha256: createHash("sha256").update(fs.readFileSync(canonicalModule)).digest("hex"),
  };
  const provenance: ExternalAdapterRuntimeProvenance = Object.freeze(managedBundle ? {
    kind: "managed_immutable_bundle" as const,
    ...common,
    packageVersion: managedBundle.packageVersion,
    bundleSha256: managedBundle.bundleSha256,
    manifestSha256: managedBundle.manifestSha256,
    payloadTreeSha256: managedBundle.payloadTreeSha256,
    installReceiptSha256: managedBundle.installReceiptSha256,
    sourceGitHead: managedBundle.sourceGitHead,
    sourceGitTree: managedBundle.sourceGitTree,
    files: managedBundle.files,
  } : {
    kind: "external" as const,
    installKind: externalInstallKind,
    ...common,
  });
  externalAdapterProvenance.set(adapter, provenance);
  return provenance;
}

export function getExternalAdapterRuntimeProvenance(
  adapter: ServerAdapterModule,
): ExternalAdapterRuntimeProvenance | null {
  return externalAdapterProvenance.get(adapter) ?? null;
}

export function getUiParserSource(adapterType: string): string | undefined {
  return uiParserCache.get(adapterType);
}

/**
 * On cache miss, attempt on-demand extraction from the plugin store.
 * Makes the ui-parser.js endpoint self-healing.
 */
export function getOrExtractUiParserSource(adapterType: string): string | undefined {
  const cached = uiParserCache.get(adapterType);
  if (cached) return cached;

  const record = getAdapterPluginByType(adapterType);
  if (!record) return undefined;

  const packageDir = resolvePackageDir(record);
  const source = extractUiParserSource(packageDir, record.packageName);
  if (source) {
    uiParserCache.set(adapterType, source);
    logger.info(
      { type: adapterType, packageName: record.packageName, origin: "lazy" },
      "UI parser extracted on-demand (cache miss)",
    );
  }
  return source;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function resolvePackageDir(record: Pick<AdapterPluginRecord, "localPath" | "packageName">): string {
  const managed = (record as AdapterPluginRecord).managedBundle;
  return managed
    ? path.resolve(managed.packageRoot)
    : record.localPath
    ? path.resolve(record.localPath)
    : path.resolve(getAdapterPluginsDir(), "node_modules", record.packageName);
}

function resolvePackageEntryPoint(packageDir: string): string {
  const pkgJsonPath = path.join(packageDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));

  if (pkg.exports && typeof pkg.exports === "object" && pkg.exports["."]) {
    const exp = pkg.exports["."];
    return typeof exp === "string" ? exp : (exp.import ?? exp.default ?? "index.js");
  }
  return pkg.main ?? "index.js";
}

// ---------------------------------------------------------------------------
// UI parser extraction
// ---------------------------------------------------------------------------

const SUPPORTED_PARSER_CONTRACT = "1";

function extractUiParserSource(
  packageDir: string,
  packageName: string,
): string | undefined {
  const pkgJsonPath = path.join(packageDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));

  if (!pkg.exports || typeof pkg.exports !== "object" || !pkg.exports["./ui-parser"]) {
    return undefined;
  }

  const contractVersion = pkg.paperclip?.adapterUiParser;
  if (contractVersion) {
    const major = contractVersion.split(".")[0];
    if (major !== SUPPORTED_PARSER_CONTRACT) {
      logger.warn(
        { packageName, contractVersion, supported: `${SUPPORTED_PARSER_CONTRACT}.x` },
        "Adapter declares unsupported UI parser contract version — skipping UI parser",
      );
      return undefined;
    }
  } else {
    logger.info(
      { packageName },
      "Adapter has ./ui-parser export but no paperclip.adapterUiParser version — loading anyway (future versions may require it)",
    );
  }

  const uiParserExp = pkg.exports["./ui-parser"];
  const uiParserFile = typeof uiParserExp === "string"
    ? uiParserExp
    : (uiParserExp.import ?? uiParserExp.default);
  const uiParserPath = path.resolve(packageDir, uiParserFile);

  if (!uiParserPath.startsWith(packageDir + path.sep) && uiParserPath !== packageDir) {
    logger.warn(
      { packageName, uiParserFile },
      "UI parser path escapes package directory — skipping",
    );
    return undefined;
  }

  if (!fs.existsSync(uiParserPath)) {
    return undefined;
  }

  try {
    const source = fs.readFileSync(uiParserPath, "utf-8");
    logger.info(
      { packageName, uiParserFile, size: source.length },
      `Loaded UI parser from adapter package${contractVersion ? "" : " (no version declared)"}`,
    );
    return source;
  } catch (err) {
    logger.warn({ err, packageName, uiParserFile }, "Failed to read UI parser from adapter package");
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Load / reload
// ---------------------------------------------------------------------------

function validateAdapterModule(mod: unknown, packageName: string): ServerAdapterModule {
  const m = mod as Record<string, unknown>;
  const createServerAdapter = m.createServerAdapter;
  if (typeof createServerAdapter !== "function") {
    throw new Error(
      `Package "${packageName}" does not export createServerAdapter(). ` +
      `Ensure the package's main entry exports a createServerAdapter function.`,
    );
  }

  const adapterModule = createServerAdapter() as ServerAdapterModule;
  if (!adapterModule || !adapterModule.type) {
    throw new Error(
      `createServerAdapter() from "${packageName}" returned an invalid module (missing "type").`,
    );
  }
  return adapterModule;
}

export async function loadExternalAdapterPackage(
  packageName: string,
  localPath?: string,
  managedBundle?: ManagedAdapterBundleIdentity,
): Promise<ServerAdapterModule> {
  if (managedBundle) await verifyManagedAdapterBundleIdentity(managedBundle);
  const packageDir = localPath
    ? path.resolve(localPath)
    : path.resolve(getAdapterPluginsDir(), "node_modules", packageName);

  const entryPoint = resolvePackageEntryPoint(packageDir);
  const modulePath = path.resolve(packageDir, entryPoint);
  const uiParserSource = extractUiParserSource(packageDir, packageName);

  logger.info({ packageName, packageDir, entryPoint, modulePath, hasUiParser: !!uiParserSource }, "Loading external adapter package");

  const mod = await import(modulePath);
  const adapterModule = validateAdapterModule(mod, packageName);
  recordExternalAdapterProvenance(adapterModule, packageName, packageDir, modulePath, localPath ? "local_path" : "npm", managedBundle);

  if (uiParserSource) {
    uiParserCache.set(adapterModule.type, uiParserSource);
  }

  return adapterModule;
}

async function loadFromRecord(record: AdapterPluginRecord): Promise<ServerAdapterModule | null> {
  try {
    const managed = record.installKind === "managed_immutable_bundle"
      ? await verifyManagedAdapterPluginRecord(record)
      : undefined;
    return await loadExternalAdapterPackage(record.packageName, managed?.packageRoot ?? record.localPath, managed);
  } catch (err) {
    logger.warn(
      { err, packageName: record.packageName, type: record.type },
      "Failed to dynamically load external adapter; skipping",
    );
    return null;
  }
}

/**
 * Reload an external adapter at runtime (dev iteration without server restart).
 * Busts the ESM module cache via a cache-busting query string.
 */
export async function reloadExternalAdapter(
  type: string,
): Promise<ServerAdapterModule | null> {
  const record = getAdapterPluginByType(type);
  if (!record) return null;

  const managed = record.installKind === "managed_immutable_bundle"
    ? await verifyManagedAdapterPluginRecord(record)
    : undefined;

  const packageDir = resolvePackageDir(record);
  const entryPoint = resolvePackageEntryPoint(packageDir);
  const modulePath = path.resolve(packageDir, entryPoint);
  const fileUrl = `file://${modulePath}`;

  // Bust ESM module cache so re-import loads fresh code from disk.
  // Query-string trick (?t=...) works in Node; Bun may need the file:// URL
  // to be evicted from its internal registry first.
  try {
    // @ts-expect-error -- Bun internal module cache
    const bunCache = globalThis.Bun?.__moduleCache as Map<string, unknown> | undefined;
    if (bunCache) {
      bunCache.delete(fileUrl);
      bunCache.delete(modulePath);
    }
  } catch {
    // Ignore — query-string fallback still works in Node
  }

  const cacheBustUrl = `${fileUrl}?t=${Date.now()}`;

  logger.info(
    { type, packageName: record.packageName, modulePath, cacheBustUrl },
    "Reloading external adapter (cache bust)",
  );

  const mod = await import(cacheBustUrl);
  const adapterModule = validateAdapterModule(mod, record.packageName);
  recordExternalAdapterProvenance(adapterModule, record.packageName, packageDir, modulePath, record.localPath ? "local_path" : "npm", managed);

  uiParserCache.delete(type);
  const uiParserSource = extractUiParserSource(packageDir, record.packageName);
  if (uiParserSource) {
    uiParserCache.set(adapterModule.type, uiParserSource);
  }

  logger.info(
    { type, packageName: record.packageName, hasUiParser: !!uiParserSource },
    "Successfully reloaded external adapter",
  );

  return adapterModule;
}

/**
 * Build all external adapter modules from the plugin store.
 */
export async function buildExternalAdapters(): Promise<ServerAdapterModule[]> {
  const results: ServerAdapterModule[] = [];

  const storeRecords = listAdapterPlugins();
  for (const record of storeRecords) {
    const adapter = await loadFromRecord(record);
    if (adapter) {
      results.push(adapter);
    }
  }

  if (results.length > 0) {
    logger.info(
      { count: results.length, adapters: results.map((a) => a.type) },
      "Loaded external adapters from plugin store",
    );
  }

  return results;
}

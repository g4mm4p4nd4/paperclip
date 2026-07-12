import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProviderPolicyV2 } from "../services/provider-policy.js";
import { verifyProviderRuntimeIdentity } from "./provider-policy-canary.js";

const ROUTE_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;

export function parseProviderRuntimeIdentityArgs(rawArgv: string[]) {
  const argv = rawArgv[0] === "--" ? rawArgv.slice(1) : rawArgv;
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    return { help: true, routeIds: undefined };
  }
  if (argv.length === 0) return { help: false, routeIds: undefined };
  if (argv.length !== 2 || argv[0] !== "--routes") {
    throw new Error("provider_runtime_identity_argument_invalid");
  }
  const routeIds = argv[1]!.split(",").filter(Boolean);
  if (routeIds.length === 0 || routeIds.some((routeId) => !ROUTE_ID.test(routeId)) ||
      new Set(routeIds).size !== routeIds.length) {
    throw new Error("provider_runtime_identity_routes_invalid");
  }
  return { help: false, routeIds };
}

async function main() {
  const args = parseProviderRuntimeIdentityArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: pnpm ops:provider-runtime-identity [-- --routes <route-id,...>]");
    return;
  }
  const loaded = await loadProviderPolicyV2();
  const routeIds = args.routeIds ?? Object.keys(loaded.policy.routes);
  const identities: Record<string, Awaited<ReturnType<typeof verifyProviderRuntimeIdentity>>> = {};
  for (const routeId of routeIds) {
    const route = loaded.policy.routes[routeId];
    if (!route) throw new Error(`provider_runtime_identity_route_unknown:${routeId}`);
    identities[routeId] = await verifyProviderRuntimeIdentity(route);
  }
  console.log(JSON.stringify({
    schema_version: "paperclip.provider_runtime_identity.v1",
    policy_revision: loaded.policy.revision,
    policy_sha256: loaded.sha256,
    policy_schema_sha256: loaded.schemaSha256,
    identities,
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({
      status: "failed",
      blocker: error instanceof Error ? error.message : "provider_runtime_identity_unknown_failure",
    }));
    process.exit(1);
  });
}

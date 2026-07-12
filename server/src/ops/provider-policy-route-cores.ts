import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildProviderPolicyRouteCore,
  loadProviderPolicyV2,
} from "../services/provider-policy.js";
import { canonicalProviderRouteJson, providerPolicyRouteCoreSha256 } from "../services/provider-route-hash.js";

export async function buildProviderPolicyRouteCoreManifest(routeIds?: string[]) {
  const loaded = await loadProviderPolicyV2();
  const selected = routeIds ?? Object.keys(loaded.policy.routes);
  const routes = Object.fromEntries(selected.map((routeId) => {
    const route = loaded.policy.routes[routeId];
    if (!route) throw new Error(`Unknown provider policy route ${routeId}`);
    const core = buildProviderPolicyRouteCore({ routeId, route });
    return [routeId, {
      policyRouteCoreSha256: providerPolicyRouteCoreSha256(core),
      core,
    }];
  }));
  return {
    schemaVersion: "paperclip-provider-route-core-manifest.v1" as const,
    policyId: loaded.policy.policyId,
    policyRevision: loaded.policy.revision,
    providerPolicyPath: loaded.path,
    providerPolicySha256: loaded.sha256,
    providerPolicySchemaPath: loaded.schemaPath,
    providerPolicySchemaSha256: loaded.schemaSha256,
    routes,
  };
}

async function main() {
  const routeArgIndex = process.argv.indexOf("--routes");
  const routes = routeArgIndex >= 0 ? process.argv[routeArgIndex + 1]?.split(",").filter(Boolean) : undefined;
  process.stdout.write(`${canonicalProviderRouteJson(await buildProviderPolicyRouteCoreManifest(routes))}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

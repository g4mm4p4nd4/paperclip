import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  completionCanaryRouteSha256,
  providerPolicyRouteCoreSha256,
} from "../services/provider-route-hash.js";
import { buildProviderPolicyRouteCore, loadProviderPolicyV2 } from "../services/provider-policy.js";

const fixturePath = new URL("../../../config/provider-route-hash-golden.v1.json", import.meta.url);
const externalModulePath = "/Users/mnm/Documents/Github/hermes-paperclip-adapter/route-hash.js";

type Golden = {
  route: Record<string, unknown>;
  expected: { policyRouteCoreSha256: string; resolvedRouteSha256: string };
};

describe("provider route hash compatibility", () => {
  it("matches the frozen Hermes golden vector", async () => {
    const golden = JSON.parse(await readFile(fixturePath, "utf8")) as Golden;
    expect(providerPolicyRouteCoreSha256(golden.route)).toBe(golden.expected.policyRouteCoreSha256);
    expect(completionCanaryRouteSha256(golden.route)).toBe(golden.expected.resolvedRouteSha256);
  });

  it.runIf(existsSync(externalModulePath))("matches the external Hermes implementation", async () => {
    const golden = JSON.parse(await readFile(fixturePath, "utf8")) as Golden;
    const external = await import(pathToFileURL(externalModulePath).href) as {
      providerPolicyRouteCoreSha256: (route: unknown) => string;
      completionCanaryRouteSha256: (route: unknown) => string;
    };
    expect(providerPolicyRouteCoreSha256(golden.route)).toBe(external.providerPolicyRouteCoreSha256(golden.route));
    expect(completionCanaryRouteSha256(golden.route)).toBe(external.completionCanaryRouteSha256(golden.route));
  });

  it.runIf(existsSync(externalModulePath))("matches Hermes on the actual frozen policy exporter cores", async () => {
    const loaded = await loadProviderPolicyV2();
    const expected = {
      opencode_go_flash: "b159479add346352f026ee0d1140a38ec88f9997ad52aa5eb612338f771d3d3f",
      opencode_go_deep: "e8f7e7d540262f8b196ce6592d02ffdb91db06e8336587d65918f1f5cb969b53",
      opencode_zen_free: "7b5ca0bf2b1d33ed22897efb6c740db24e8f956c2236f0a8e18a8d82067e2c92",
      minimax_m3: "f1fcdea8f7cb2251137d157f70269951c07843c1d1f0fd5ad8735c192a53aab3",
    } as const;
    const external = await import(pathToFileURL(externalModulePath).href) as {
      providerPolicyRouteCoreSha256: (route: unknown) => string;
    };
    for (const [routeId, expectedSha256] of Object.entries(expected)) {
      const core = buildProviderPolicyRouteCore({ routeId, route: loaded.policy.routes[routeId]! });
      expect(providerPolicyRouteCoreSha256(core)).toBe(expectedSha256);
      expect(external.providerPolicyRouteCoreSha256(core)).toBe(expectedSha256);
    }
  });
});

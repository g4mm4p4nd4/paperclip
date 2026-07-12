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
      opencode_go_flash: "c02f596844eb0671ac03b817c5e54146b72c96845a77a8266a10fedf1ff34d5e",
      opencode_go_deep: "d71262fd31f6925f01570751b9606c2ee51247e7184cc77f6c464d2ebe6eab3b",
      opencode_zen_free: "789a3b7d89ef6d0e78d08ae3b422645b850708dea67e7401cdafd485b209b294",
      minimax_m3: "30769bf7c034bcb7119e821deb587074c4fb829c7d3165b92177a867469ff301",
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

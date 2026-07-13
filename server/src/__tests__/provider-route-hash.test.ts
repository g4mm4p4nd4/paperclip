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
      opencode_go_flash: "e5ce90d9071d70d2cffcbbc67b8e9a9ef29b354348d25b2f9c19d86361477d6d",
      opencode_go_deep: "de0a35e4a63d2e3a025abffe2e1eef096e2c0965389dd4515b652320379f68ba",
      opencode_zen_free: "5bf9e8fa5fd5d19236a1b19a184b18db96ee3d5dec87d396773b4c5844be5d55",
      minimax_m3: "3395919842465b387a7ebd606d9a099f1454b23667f78c86a2ad69404f125840",
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

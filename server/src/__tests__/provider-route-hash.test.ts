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
      opencode_go_flash: "d89226cc02740924ebb90799c896627416b7754c0ced8c0cefe0b3bfd1066d75",
      opencode_go_deep: "053d2ab914897ff724fc0e74352ddf4e703c769bfff2aa356044a615942e30a2",
      opencode_zen_free: "921d2934e47f16d2633102992cfeda80ddc7ea575912d4e3a85fec7ca15d67f8",
      minimax_m3: "54075743e935ddba68336a52279e04819f4779cd379b390223d2fec8b0391406",
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

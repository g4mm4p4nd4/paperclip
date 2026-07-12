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
      opencode_go_flash: "3beacbc44edc038bdc9715c27307d7140273b0f7c34dd9bf27357ee1368bd681",
      opencode_go_deep: "d1b8900846a20dcb886eb2bdd48e33800647f2b3c265344a1c45508fdf0ebdd9",
      opencode_zen_free: "b4e20074064cb90e90e92d755c8293d69b4aa973e09fe287a32bd69032fc398b",
      minimax_m3: "f05d0fecf7bfeff949f0b2936ef43844137f87816e2832682a4ba740d8789f1f",
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

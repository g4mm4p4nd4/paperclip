import { createHash } from "node:crypto";

// Keep this projection byte-for-byte compatible with the external Hermes
// adapter's route-hash.js. The golden-vector test imports the adapter's frozen
// fixture so either repository fails loudly if this contract drifts.
const ROUTE_PROOF_FIELDS = new Set([
  "policyId",
  "policyRevision",
  "policyRouteCoreSha256",
  "providerPolicySchemaSha256",
  "providerPolicySha256",
  "resolvedRouteSha256",
  "routeSha256",
]);

type CanonicalJson = null | string | boolean | number | CanonicalJson[] | { [key: string]: CanonicalJson };

function canonicalJsonValue(value: unknown, seen = new WeakSet<object>()): CanonicalJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON does not allow non-finite numbers.");
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`Canonical JSON does not allow ${typeof value} values.`);
  }
  if (seen.has(value)) throw new TypeError("Canonical JSON does not allow circular references.");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalJsonValue(item, seen));
    const output: Record<string, CanonicalJson> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) throw new TypeError("Canonical JSON does not allow undefined object values.");
      output[key] = canonicalJsonValue(item, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function canonicalProviderRouteJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

export function resolvedProviderRouteProjection(value: unknown): Record<string, unknown> {
  const route = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return Object.fromEntries(Object.entries(route).filter(([key]) => !ROUTE_PROOF_FIELDS.has(key)));
}

export function providerPolicyRouteCoreProjection(value: unknown): Record<string, unknown> {
  const route = resolvedProviderRouteProjection(value);
  const { catalogEvidence: _catalogEvidence, ...core } = route;
  return core;
}

export function completionCanaryRouteSha256(value: unknown): string {
  return sha256(canonicalProviderRouteJson(resolvedProviderRouteProjection(value)));
}

export function providerPolicyRouteCoreSha256(value: unknown): string {
  return sha256(canonicalProviderRouteJson(providerPolicyRouteCoreProjection(value)));
}

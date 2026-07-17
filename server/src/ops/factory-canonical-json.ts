import { createHash } from "node:crypto";

function canonicalize(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("factory_canonical_json_non_finite_number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry, seen));
  if (typeof value !== "object" || value instanceof Date) {
    throw new Error("factory_canonical_json_value_invalid");
  }
  if (seen.has(value)) throw new Error("factory_canonical_json_cycle");
  seen.add(value);
  try {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort((left, right) => left.localeCompare(right, "en"))) {
      if (/[^\u0020-\u007e]/.test(key) || /[\r\n\0]/.test(key)) throw new Error("factory_canonical_json_key_invalid");
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined) throw new Error("factory_canonical_json_undefined");
      output[key] = canonicalize(entry, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function factoryCanonicalJsonValue(value: unknown) {
  return canonicalize(value, new Set());
}

export function factoryCanonicalJsonBytes(value: unknown) {
  return Buffer.from(`${JSON.stringify(factoryCanonicalJsonValue(value), null, 2)}\n`, "utf8");
}

export function factoryCanonicalJsonSha256(value: unknown) {
  return createHash("sha256").update(factoryCanonicalJsonBytes(value)).digest("hex");
}

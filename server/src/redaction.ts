const SECRET_PAYLOAD_KEY_RE =
  /(api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring|claim[-_]?nonce|execution[-_]?evidence[-_]?nonce|server[-_]?observation[-_]?nonce)/i;
const JWT_VALUE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/;
const SECRET_TEXT_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}\b/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{20,}\b/gi,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/gi,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gi,
  /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bsk-ant-o(?:at|rt)01-[A-Za-z0-9_-]{20,}\b/gi,
  /\bpaperclip-broker-[A-Za-z0-9_-]{20,}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi,
  /\b(?:api[_ -]?key|access[_ -]?token|auth(?:orization)?|secret|password|paperclip_api_key)\s*[:=]\s*["']?(?:Bearer\s+)?[A-Za-z0-9._~+\/-]{12,}/gi,
] as const;
export const REDACTED_EVENT_VALUE = "***REDACTED***";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function sanitizeSecretText(value: string) {
  let next = value;
  for (const pattern of SECRET_TEXT_PATTERNS) next = next.replace(pattern, REDACTED_EVENT_VALUE);
  return next;
}

export function containsSecretLikeText(value: string) {
  return sanitizeSecretText(value) !== value || JWT_VALUE_RE.test(value.trim());
}

export function sanitizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return JWT_VALUE_RE.test(value) ? REDACTED_EVENT_VALUE : sanitizeSecretText(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeSecretText(value.message),
      ...(value.stack ? { stack: sanitizeSecretText(value.stack) } : {}),
    };
  }
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (isSecretRefBinding(value)) return value;
  if (isPlainBinding(value)) return { type: "plain", value: sanitizeValue(value.value) };
  if (!isPlainObject(value)) return value;
  return sanitizeRecord(value);
}

function isSecretRefBinding(value: unknown): value is { type: "secret_ref"; secretId: string; version?: unknown } {
  if (!isPlainObject(value)) return false;
  return value.type === "secret_ref" && typeof value.secretId === "string";
}

function isPlainBinding(value: unknown): value is { type: "plain"; value: unknown } {
  if (!isPlainObject(value)) return false;
  return value.type === "plain" && "value" in value;
}

export function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (SECRET_PAYLOAD_KEY_RE.test(key)) {
      if (isSecretRefBinding(value)) {
        redacted[key] = sanitizeValue(value);
        continue;
      }
      if (isPlainBinding(value)) {
        redacted[key] = { type: "plain", value: REDACTED_EVENT_VALUE };
        continue;
      }
      redacted[key] = REDACTED_EVENT_VALUE;
      continue;
    }
    redacted[key] = sanitizeValue(value);
  }
  return redacted;
}

/**
 * Secret-write endpoints intentionally use the generic API field names
 * `value` and `externalRef`. Those names are not globally sensitive, but on
 * these routes they contain secret material and must never reach HTTP logs.
 */
export function sanitizeHttpRequestBodyForLogs(
  method: unknown,
  url: unknown,
  body: unknown,
): unknown {
  const sanitized = sanitizeValue(body);
  if (!isSecretWriteRequest(method, url) || !isPlainObject(sanitized)) {
    return sanitized;
  }

  return {
    ...sanitized,
    ...("value" in sanitized ? { value: REDACTED_EVENT_VALUE } : {}),
    ...("externalRef" in sanitized
      ? { externalRef: REDACTED_EVENT_VALUE }
      : {}),
  };
}

function isSecretWriteRequest(method: unknown, url: unknown) {
  if (method !== "POST" || typeof url !== "string") return false;
  const path = (url.split("#", 1)[0] ?? "").split("?", 1)[0] ?? "";
  return (
    /^\/api\/companies\/[^/]+\/secrets\/?$/.test(path) ||
    /^\/api\/secrets\/[^/]+\/rotate\/?$/.test(path)
  );
}

function requestSecretValues(method: unknown, url: unknown, body: unknown) {
  if (!isSecretWriteRequest(method, url) || !isPlainObject(body)) return [];
  return ["value", "externalRef"]
    .map((key) => body[key])
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

function redactExactStrings(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    return secrets.reduce(
      (current, secret) => current.replaceAll(secret, REDACTED_EVENT_VALUE),
      value,
    );
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactExactStrings(entry, secrets));
  }
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      redactExactStrings(entry, secrets),
    ]),
  );
}

/**
 * Providers can echo submitted secret material in exception messages. Apply
 * exact request-scoped replacement after normal structural redaction so the
 * message, stack, details, and raw error serializer cannot leak it.
 */
export function sanitizeHttpFailureForLogs(
  method: unknown,
  url: unknown,
  body: unknown,
  failure: unknown,
): unknown {
  const sanitized = sanitizeValue(failure);
  const secrets = requestSecretValues(method, url, body);
  return secrets.length > 0 ? redactExactStrings(sanitized, secrets) : sanitized;
}

export function sanitizeHttpErrorForLogs(
  method: unknown,
  url: unknown,
  body: unknown,
  error: Error,
) {
  const secrets = requestSecretValues(method, url, body);
  if (secrets.length === 0) return error;
  const sanitized = sanitizeHttpFailureForLogs(
    method,
    url,
    body,
    error,
  ) as { name?: unknown; message?: unknown; stack?: unknown };
  const safe = new Error(
    typeof sanitized.message === "string"
      ? sanitized.message
      : "Secret write failed",
  );
  safe.name =
    typeof sanitized.name === "string" ? sanitized.name : error.name;
  if (typeof sanitized.stack === "string") safe.stack = sanitized.stack;
  return safe;
}

export function redactEventPayload(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!payload) return null;
  if (!isPlainObject(payload)) return payload;
  return sanitizeRecord(payload);
}

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

export function redactEventPayload(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!payload) return null;
  if (!isPlainObject(payload)) return payload;
  return sanitizeRecord(payload);
}

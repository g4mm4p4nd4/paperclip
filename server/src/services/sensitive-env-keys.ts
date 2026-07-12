const COMPOUND_SENSITIVE_ENV_TOKENS = new Set([
  "apikey", "apikeys", "apikeyfile", "apikeyfiles", "accesstoken", "accesstokens",
  "refreshtoken", "refreshtokens", "clientsecret", "clientsecrets", "privatekey", "privatekeys",
  "connectionstring", "connectionstrings", "recoverycode", "recoverycodes", "verificationcode",
  "verificationcodes", "verificationtoken", "verificationtokens", "phonenumber", "phonenumbers",
  "pgpassword", "pgpassfile", "mysqlpwd",
]);

const CREDENTIAL_URI_KEY_RE = /(?:databaseurl|databaseuri|postgresurl|postgresqlurl|mongodburl|mongodburi|redisurl|redissurl)$/;

/**
 * Tokenize an environment/config key without treating an arbitrary sensitive
 * substring as a credential boundary.  This keeps names such as `tokenomics`
 * and `instructionsRootPath` out of the secret plane while still recognizing
 * camelCase, snake_case, and collapsed provider keys such as `OPENAI_APIKEY`.
 */
export function envKeyTokens(key: string) {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toLowerCase()
    .split("_")
    .filter(Boolean);
}

export function isSensitiveEnvKey(key: string) {
  const tokens = envKeyTokens(key);
  const compact = tokens.join("");
  if (compact === "authmode" || compact === "authenticationmode") return false;
  if (CREDENTIAL_URI_KEY_RE.test(compact)) return true;
  const tokenSet = new Set(tokens);
  const hasSequence = (...sequence: string[]) => tokens.some((_token, start) =>
    sequence.every((expected, offset) => tokens[start + offset] === expected));
  if (hasSequence("database", "url") || hasSequence("database", "uri") ||
      hasSequence("postgres", "url") || hasSequence("postgresql", "url") ||
      hasSequence("mongodb", "url") || hasSequence("mongodb", "uri") ||
      (tokenSet.has("redis") && tokenSet.has("url"))) return true;
  if (COMPOUND_SENSITIVE_ENV_TOKENS.has(compact) ||
      tokens.some((token) => COMPOUND_SENSITIVE_ENV_TOKENS.has(token))) return true;
  if (hasSequence("api", "key") || hasSequence("api", "keys") ||
      hasSequence("access", "token") || hasSequence("refresh", "token") ||
      hasSequence("client", "secret") || hasSequence("private", "key") ||
      hasSequence("connection", "string") || hasSequence("connection", "strings") ||
      hasSequence("recovery", "code") || hasSequence("recovery", "codes") ||
      hasSequence("verification", "code") || hasSequence("verification", "token") ||
      hasSequence("phone", "number")) {
    return true;
  }
  const secretAliases = new Set(["bearer", "passwd", "passphrase"]);
  const metadataSuffixes = new Set(["format", "mode", "style"]);
  if (tokens.some((token, index) => secretAliases.has(token) && !metadataSuffixes.has(tokens[index + 1] ?? ""))) {
    return true;
  }
  const terminalToken = tokens.at(-1);
  if (terminalToken === "pwd" && tokens.length > 1 && [
    "auth", "credential", "credentials", "database", "db", "mariadb", "mongo", "mongodb",
    "mssql", "mysql", "oracle", "postgres", "postgresql", "redis", "secret", "sqlserver",
  ].some((context) => tokens.slice(0, -1).includes(context))) {
    return true;
  }
  return [
    "auth", "authorization", "token", "tokens", "secret", "secrets", "password", "passwords",
    "credential", "credentials", "cookie", "cookies", "jwt", "phone", "mfa", "otp",
  ].some((token) => tokenSet.has(token));
}

function plainBindingValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const binding = value as Record<string, unknown>;
  return binding.type === "plain" && typeof binding.value === "string"
    ? binding.value
    : null;
}

/**
 * Detect a credential embedded in URI user-info without classifying ordinary
 * endpoint metadata such as `API_BASE_URL=https://api.example` as a secret.
 */
export function hasCredentialBearingUriUserInfo(value: unknown) {
  const plain = plainBindingValue(value)?.trim();
  if (!plain || !/^[a-z][a-z0-9+.-]*:\/\//i.test(plain)) return false;
  try {
    const uri = new URL(plain);
    return uri.username.length > 0 || uri.password.length > 0;
  } catch {
    return false;
  }
}

/**
 * Value-aware secret boundary shared by persistence and one-shot migrations.
 * Known connection URI keys are always secret references; any other key is
 * sensitive only when its value actually contains URI user-info.
 */
export function isSensitiveEnvBinding(key: string, value: unknown) {
  return isSensitiveEnvKey(key) || hasCredentialBearingUriUserInfo(value);
}

const NAMED_SECRET_RE = /\b(auth_token|refresh_token|access_token|authorization|password|api[_-]?key|cookie|secret)\b\s*[:=]\s*["']?([^\s"',}]+)/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const SECRET_KEY_RE = /token|password|cookie|credential|secret|authorization/i;

export function redactSecrets(value) {
  return String(value ?? "")
    .replace(BEARER_RE, "Bearer [REDACTED]")
    .replace(NAMED_SECRET_RE, "$1=[REDACTED]")
    .replace(JWT_RE, "[REDACTED]");
}

export function redactSensitiveValue(value) {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactSensitiveValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    SECRET_KEY_RE.test(key) ? "[REDACTED]" : redactSensitiveValue(child)
  ]));
}

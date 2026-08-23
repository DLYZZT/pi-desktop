const SENSITIVE_EXACT_KEYS = new Set([
  "API_KEY",
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "NODE_AUTH_TOKEN",
  "NPM_TOKEN",
  "NPM_CONFIG__AUTH",
  "NPM_CONFIG__AUTHTOKEN",
  "GH_TOKEN",
  "HF_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SECURITY_TOKEN",
]);

const SENSITIVE_KEY_SUFFIXES = [
  "_API_KEY",
  "_APIKEY",
  "_ACCESS_TOKEN",
  "_AUTH_TOKEN",
  "_REFRESH_TOKEN",
  "_SESSION_TOKEN",
  "_TOKEN",
  "_PRIVATE_KEY",
  "_SECRET",
  "_PASSWORD",
  "_PASSWD",
] as const;

function isSensitiveEnvironmentKey(key: string): boolean {
  const normalized = key.toUpperCase();
  return SENSITIVE_EXACT_KEYS.has(normalized) || SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function containsUrlCredentials(value: string): boolean {
  if (!value.includes("://") || !value.includes("@")) return false;
  try {
    const parsed = new URL(value);
    return Boolean(parsed.username || parsed.password);
  } catch {
    return /^[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i.test(value);
  }
}

/**
 * Build the environment inherited by project-controlled tools and processes.
 *
 * The Agent Host needs provider credentials, but arbitrary project commands do
 * not. Keeping those two trust domains separate prevents `env`, child-process
 * dumps, and compromised package scripts from disclosing the host's secrets.
 */
export function sanitizeToolEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value !== "string" || isSensitiveEnvironmentKey(key) || containsUrlCredentials(value)) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

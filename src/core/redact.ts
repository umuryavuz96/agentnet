// Redaction of secrets in free text. An identical copy lives in plugin/hooks/register.ts (the plugin cannot import from src);
// src/net/adopt-safe.test.ts fails when the two diverge.
export const redact = (v: string) => v.replace(/\b(authorization\s*[=:]\s*)(?:bearer\s+)?\S+/gi, "$1***").replace(/\b(bearer\s+)\S+/gi, "$1***").replace(/\b([\w-]*(?:token|api[-_]?key|secret|passw(?:or)?d)[\w-]*\s*[=:]\s*)\S+/gi, "$1***").replace(/\b[A-Za-z0-9+_-]{32,}={0,2}/g, "***");

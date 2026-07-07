// redact-secrets.ts — mask secret-bearing fields in a tool's input before it is
// written to an audit table or rendered to the dashboard.
//
// NOUVEAU-1 (audit sécu 2026-07-07): several meta-tools take secrets as
// arguments — create_connector (`apiKey`), create_mcp / attach_mcp (`apiKey`,
// and every value of the stdio `env` record). The destination row encrypts
// them, but the audit copy in `tool_calls.toolInput` and the pending
// `approval_requests.toolInput` used to store the RAW input, and the dashboard
// rendered it verbatim (approvals page + logs table) — cleartext keys visible
// to any entity member, and readable straight out of the DB. This masks them.
//
// IMPORTANT: this returns a COPY. The real values must keep flowing to the
// tool's own execute() (which encrypts at rest) and to the approval re-exec
// path (apps/runner reads the STORED approval_requests.toolInput to re-run the
// approved call) — so callers redact the audit/display copy only, never the
// value handed to execution.
//
// This is a name-based denylist, not a schema-driven marker. A schema-level
// `secret: true` annotation on tool input fields would be more robust to new
// tools; that is tracked as a follow-up. Until then, keep SECRET_FIELD_RE in
// sync with any new secret-bearing tool argument.

const REDACTED = '***';

// Field names whose VALUE is a secret. Anchored, case-insensitive; matches the
// real fields (apiKey / api_key / token / accessToken / refreshToken / secret /
// password / clientSecret / credential) without catching innocents like
// "keyword" or "tokenCount".
const SECRET_FIELD_RE =
  /^(api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|token|credential)$/i;

/**
 * Deep-copy `value`, replacing any secret-bearing field with `'***'`.
 *
 * - A key matching {@link SECRET_FIELD_RE} → its value is masked.
 * - A key named exactly `env` holding an object (create_mcp/attach_mcp stdio
 *   env vars) → every value is masked, keys kept visible so the reviewer still
 *   sees WHICH variables are set.
 * - Arrays and nested objects are walked recursively.
 * - Primitives pass through untouched.
 */
export function redactSecretsForAudit(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecretsForAudit);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_FIELD_RE.test(k)) {
        out[k] = v == null ? v : REDACTED;
      } else if (k.toLowerCase() === 'env' && v !== null && typeof v === 'object' && !Array.isArray(v)) {
        const envOut: Record<string, unknown> = {};
        for (const ek of Object.keys(v as Record<string, unknown>)) envOut[ek] = REDACTED;
        out[k] = envOut;
      } else {
        out[k] = redactSecretsForAudit(v);
      }
    }
    return out;
  }
  return value;
}

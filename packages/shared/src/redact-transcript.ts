// redact-transcript.ts — mask secrets in a job transcript BEFORE it is displayed.
//
// SECRET-001 (audit 2026-08-07). Job transcripts store tool results verbatim.
// `file_read` on a `.env`, a `run_command` printing an environment, an MCP
// server echoing its own config — all land in `agent_jobs.messages` in clear,
// and the dashboard renders them.
//
// Why `redactSecretsForAudit` is not enough
// -----------------------------------------
// That function is KEY-based: it masks a value whose FIELD NAME looks secret
// (`apiKey`, `token`, …). It is the right tool for a tool's structured input,
// which is what it was written for. A transcript's dominant leak has no key at
// all — the secret sits inside a free-text blob:
//
//     "content": "DISCORD_BOT_TOKEN=MTUyNTQ0…\nSLACK_APP_TOKEN=xapp-1-A0BG…"
//
// Demonstrated the hard way during this very audit: a `SELECT *` on a
// credentials table printed a live Discord bot token and two Slack tokens into
// a transcript. Nothing in the product would have masked them.
//
// Why the write path is untouched
// -------------------------------
// The runner re-reads stored messages to resume a job, and `approval_requests
// .toolInput` is re-executed after a human approves. Redacting at write would
// silently corrupt both. So this is display-only, exactly as the remediation
// plan requires.
//
// Deliberately conservative
// -------------------------
// Only shapes that are unambiguous credentials. A greedy pattern (any long
// base64 run, any `KEY=value`) would mask file hashes, ids and ordinary output,
// and a transcript nobody can read is a debugging surface nobody uses — which
// costs more than it protects.

import { redactSecretsForAudit } from './redact-secrets';

export const REDACTED_TEXT = '[secret masqué]';

/**
 * Credential shapes with a distinctive, vendor-assigned prefix.
 *
 * Every entry must be specific enough that a match is a credential and not a
 * coincidence — that is the whole bargain of a value-shaped redactor.
 */
const SECRET_VALUE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // OpenAI / Anthropic / OpenRouter / DeepSeek style
  [/\bsk-[A-Za-z0-9_-]{16,}/g, 'sk-'],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, 'sk-ant-'],
  // GitHub
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, 'gh*_'],
  // Slack — bot, user, app and legacy webhook tokens
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, 'xox*-'],
  [/\bxapp-[0-9]-[A-Za-z0-9-]{10,}/g, 'xapp-'],
  // Google API keys
  [/\bAIza[A-Za-z0-9_-]{30,}/g, 'AIza'],
  // AWS access key ids
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, 'AKIA/ASIA'],
  // Telegram bot tokens: <digits>:<35 base64url chars>
  [/\b\d{8,12}:[A-Za-z0-9_-]{30,}/g, 'telegram'],
  // Discord bot tokens: three dot-separated base64url segments, first is the id
  [/\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,40}\b/g, 'discord'],
  // Cogni and other `<prefix>_` API keys we ship in the connector catalogue
  [/\bcog_[A-Za-z0-9]{16,}/g, 'cog_'],
  [/\btvly-[A-Za-z0-9]{16,}/g, 'tvly-'],
  // Private key blocks — mask the whole body, not just the header
  [/-----BEGIN[^-]{0,40}PRIVATE KEY-----[\s\S]*?-----END[^-]{0,40}PRIVATE KEY-----/g, 'pem'],
  // `Authorization: Bearer <token>` in a captured HTTP exchange
  [/\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{20,}/g, 'bearer'],
];

/**
 * Mask credential-shaped substrings in free text.
 *
 * Returns the text unchanged when nothing matches, so the common case allocates
 * nothing and a clean transcript stays byte-identical.
 */
export function redactSecretsInText(text: string): string {
  let out = text;
  for (const [pattern, label] of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, `${REDACTED_TEXT} (${label})`);
  }
  return out;
}

/** Walk any JSON-ish value, masking secret-shaped STRINGS wherever they sit. */
function redactStringsDeep(value: unknown): unknown {
  if (typeof value === 'string') return redactSecretsInText(value);
  if (Array.isArray(value)) return value.map(redactStringsDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactStringsDeep(v);
    }
    return out;
  }
  return value;
}

/**
 * Prepare a stored transcript for DISPLAY.
 *
 * Both passes, because they catch different things: the key-based one masks a
 * structured `{ apiKey: "…" }` whose value carries no recognisable prefix, and
 * the value-based one masks a token embedded in prose where there is no key to
 * look at. Neither subsumes the other.
 *
 * Never call this on the copy handed back to the runner: resume re-reads these
 * messages, and a resumed job must see what actually happened.
 */
export function redactTranscriptForDisplay<T>(messages: readonly T[]): T[] {
  return messages.map((m) => redactStringsDeep(redactSecretsForAudit(m)) as T);
}

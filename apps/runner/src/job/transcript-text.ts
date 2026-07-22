// transcript-text.ts — flatten a job's transcript into a single plain-text blob
// for full-text search (Brick 2: episodic memory). Stored in agent_jobs.search_text;
// a generated `search_tsv` tsvector + GIN index makes it queryable by search_history.
//
// Deliberately format-agnostic: it deep-walks the messages structure and collects
// every human-readable string (user/assistant text, tool outputs, the final
// result), skipping binary/image fields so base64 never bloats the index. Pure,
// bounded, never throws.

// Keep the searchable text bounded so the tsvector + GIN index stay small even for
// a 50-turn job. Postgres tsvector tops out ~1MB; 60K chars is a safe, generous cap.
const MAX_SEARCH_TEXT = 60_000;

// Object keys whose VALUES are binary/opaque (image bytes, data URLs, mime types,
// tool-call ids) — searching them adds noise + bloat, so we skip their subtrees.
const SKIP_KEYS = new Set([
  // structural discriminators — pure noise in a search index
  'role',
  'type',
  // binary / opaque values
  'image',
  'data',
  'mediaType',
  'mimeType',
  'toolCallId',
  'tool_call_id',
  'id',
  'signature',
]);

function collectStrings(node: unknown, out: string[], depth = 0): void {
  if (depth > 8 || out.length > 5000) return; // guard against pathological nesting/size
  if (typeof node === 'string') {
    const t = node.trim();
    if (t) out.push(t);
    return;
  }
  if (Array.isArray(node)) {
    for (const x of node) collectStrings(x, out, depth + 1);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (SKIP_KEYS.has(k)) continue;
      collectStrings(v, out, depth + 1);
    }
  }
}

/**
 * Make a string safe for Postgres storage. Model/tool output occasionally
 * carries bytes Postgres rejects at write time — a raw NUL (0x00 → `invalid
 * byte sequence for encoding "UTF8"`) or a lone UTF-16 surrogate from a
 * truncated streamed emoji/CJK char (serialized as invalid UTF-8 on the wire,
 * same error class). Both killed real jobs (2026-07-17: two concurrent jobs
 * failed their agent_jobs UPDATE on upstream content — reproduced against the
 * live DB). This is byte-level normalization for storability, not a silent
 * data fallback: lone surrogates become U+FFFD, NULs are dropped.
 */
// A high surrogate not followed by a low one, or a low surrogate not preceded
// by a high one: the two shapes of a lone surrogate. Equivalent to
// String.prototype.toWellFormed() (ES2024, above this repo TS lib target),
// replacing each with U+FFFD.
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function toDbSafeString(s: string): string {
  return s.replace(LONE_SURROGATE_RE, '\uFFFD').replaceAll('\u0000', '');
}

/**
 * Deep-clone `value` with every string passed through {@link toDbSafeString}.
 * Used on the `messages` transcript before it is written to the jsonb column —
 * the same poisoned bytes reject the whole UPDATE there too. Depth-guarded like
 * collectStrings; non-plain values (functions, symbols) pass through untouched
 * (JSON serialization drops them later anyway).
 */
export function deepDbSafe<T>(value: T, depth = 0): T {
  if (depth > 16) return value;
  if (typeof value === 'string') return toDbSafeString(value) as unknown as T;
  if (Array.isArray(value)) {
    return value.map((x) => deepDbSafe(x, depth + 1)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepDbSafe(v, depth + 1);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Flatten a job's `messages` (+ optional final `result`) into one searchable
 * string. Returns '' when there's nothing textual. Result is capped at
 * MAX_SEARCH_TEXT chars and whitespace-collapsed. Always DB-safe (see
 * toDbSafeString).
 */
export function flattenTranscript(messages: unknown, result?: string | null): string {
  const out: string[] = [];
  collectStrings(messages, out);
  if (typeof result === 'string' && result.trim()) out.push(result.trim());
  return toDbSafeString(out.join(' \n ').replace(/\s+/g, ' ').trim().slice(0, MAX_SEARCH_TEXT));
}

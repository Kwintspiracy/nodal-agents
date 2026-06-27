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
 * Flatten a job's `messages` (+ optional final `result`) into one searchable
 * string. Returns '' when there's nothing textual. Result is capped at
 * MAX_SEARCH_TEXT chars and whitespace-collapsed.
 */
export function flattenTranscript(messages: unknown, result?: string | null): string {
  const out: string[] = [];
  collectStrings(messages, out);
  if (typeof result === 'string' && result.trim()) out.push(result.trim());
  return out.join(' \n ').replace(/\s+/g, ' ').trim().slice(0, MAX_SEARCH_TEXT);
}

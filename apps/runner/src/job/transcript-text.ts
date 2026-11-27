// transcript-text.ts — flatten a job's transcript into a single plain-text blob
// for full-text search (Brick 2: episodic memory). Stored in agent_jobs.search_text;
// a generated `search_tsv` tsvector + GIN index makes it queryable by search_history.
//
// Deliberately format-agnostic: it deep-walks the messages structure and collects
// every human-readable string (user/assistant text, tool outputs, the final
// result), skipping binary/image fields so base64 never bloats the index. Pure,
// bounded, never throws.

import { isInboxMessage } from '@nodal-agents/shared';

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
 * The value of `agent_jobs.runner_notes` for these lines: the ONE way it is
 * written (#562, Codex review of #576, pass 4). A runner line embeds text it
 * did not write \u2014 a checker's stderr tail, an error code's detail \u2014 and the
 * same bytes Postgres refuses in `result` are refused in `text[]`, with the
 * whole terminal UPDATE. Each line gets the normalization `result` gets, so a
 * note stays the exact suffix of the result the replay removes it from.
 */
export function runnerNotesValue(lines: readonly string[]): string[] {
  return lines.map(toDbSafeString);
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

/**
 * The text of a message, whatever its shape: a string, or the joined text parts.
 * Here, with the other transcript readers, so that a reader of past answers
 * (`thread-history.ts`) does not depend on the job's state machine.
 */
export function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const p of content) {
    const part = p as { type?: unknown; text?: unknown } | null;
    if (part && part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
  }
  return parts.join('');
}

/**
 * La tranche de la transcription qui appartient à CE tour : du message
 * utilisateur qui porte la tâche du job jusqu'à la fin.
 *
 * Une transcription commence par l'historique rejoué du fil (thread-history.ts) :
 * pour chaque tour passé, un message utilisateur, puis un message assistant
 * SYNTHÉTIQUE qui porte la réponse d'alors — un texte assistant que rien ne
 * distingue d'un texte écrit par l'agent à ce tour. Les lignes de grand livre
 * (`[Delegated to X (…) — actions: …]`) ne sont plus dans ce message depuis
 * #562 : elles suivent, dans un relevé `[système]` de rôle utilisateur. La
 * frontière reste nécessaire pour la réponse rejouée elle-même.
 *
 * Issue #419 : un tour Telegram qui a répondu par `telegram_send_message` puis
 * `return_result {status}` n'écrit aucun texte ; le « dernier texte assistant »
 * balayé sur TOUTE la transcription était alors la dernière ligne de grand
 * livre rejouée — la délégation du 15/09 devenait le résultat de chaque tour
 * suivant, et l'historique du tour d'après la rejouait comme si l'agent
 * l'avait envoyée sur Telegram.
 *
 * La frontière est la DERNIÈRE occurrence du message utilisateur égal à la
 * tâche : l'historique la précède toujours, les relances système (`[système]`,
 * les rappels de livrable) la suivent. Quand la tâche n'apparaît nulle part
 * (une transcription qui n'a pas la forme d'un job), la tranche est la
 * transcription entière : c'est l'ancien comportement, et il n'est pas caché —
 * un job dont on ne retrouve pas la tâche est un cas que ce fichier ne sait
 * pas mieux lire.
 */
export function findTaskBoundary(messages: readonly unknown[], task: string): number {
  if (task.trim() === '') return -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; content?: unknown } | null;
    // Un message remis pendant le run (#531) qui répète la tâche mot pour mot
    // n'est pas le début du tour : il en fait partie. Sa marque est
    // structurelle, jamais lue dans le texte.
    if (isInboxMessage(m)) continue;
    if (m && m.role === 'user' && messageText(m.content) === task) return i;
  }
  return -1;
}

export function currentTurnMessages<T>(messages: readonly T[], task: string): readonly T[] {
  const i = findTaskBoundary(messages, task);
  return i === -1 ? messages : messages.slice(i);
}

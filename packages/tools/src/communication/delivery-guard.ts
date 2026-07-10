// communication/delivery-guard.ts — shared boundary checks for the six
// outbound Telegram delivery tools (telegram_send_message, send_image,
// send_file, send_video, send_audio, send_voice).
//
// Consolidates what used to be copy-pasted per tool:
//   - bot token resolution (resolveBotToken)
//   - recipient chatId resolution + authorization (resolveRecipientChatId, F1)
//     — including the hard per-job delivery ceiling (L4)
//   - local source-path confinement (assertLocalSourceAllowed, F2)
//   - bounded, link-local-blocked URL fetch (fetchBoundedUrl, F3)
//
// Each tool keeps its OWN error names for the no-token/no-recipient/too-large
// cases (passed in as params) — only `telegram_chat_not_allowed`,
// `telegram_send_rate_limited`, and `source_path_not_allowed` are new,
// shared names.

import { eq } from '@nodal-agents/db';
import { agents, isChatAllowed, resolveOwnerChatId } from '@nodal-agents/db';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolContext } from '../types';

// ─── Bot token ──────────────────────────────────────────────────────────────

/**
 * The runner's resolved token wins (B3: a delegated worker inheriting its
 * entity's root agent's token so it can reply on the same chat as the
 * orchestrator); otherwise fall back to this agent's own token from DB
 * (credential isolation per agent, historical path). Returns undefined when
 * neither is configured — callers throw their own tool-specific error name.
 */
export async function resolveBotToken(ctx: ToolContext): Promise<string | undefined> {
  if (ctx.resolvedTelegramBotToken !== undefined) return ctx.resolvedTelegramBotToken;
  const agentRows = await ctx.db
    .select({ telegramBotToken: agents.telegramBotToken })
    .from(agents)
    .where(eq(agents.id, ctx.agentId))
    .limit(1);
  return agentRows[0]?.telegramBotToken ?? undefined;
}

// ─── Per-job delivery ceiling (L4) ─────────────────────────────────────────
//
// The advisory anti-spam guard on the runner side is heuristic; this is the
// deterministic backstop. resolveRecipientChatId is on the path of every one
// of the 6 delivery tools, so it is the natural choke point for a hard cap.

/**
 * 30 covers a very long multi-part delivery (long replies chunk at 4096
 * chars, so a single "reply" can legitimately take several sends) while
 * still stopping a genuinely runaway send loop — same anti-loop philosophy
 * as the chain/tool-call caps in packages/orchestration/src/chain-counters.ts.
 */
const MAX_DELIVERIES_PER_JOB = 30;

/** Bound on distinct jobIds tracked at once, so a long-lived runner process never leaks memory. */
const MAX_TRACKED_JOBS = 1000;

/** Module-level: successful deliveries so far, keyed by jobId. Insertion order = oldest first. */
const deliveryCountsByJob = new Map<string, number>();

function evictOldestIfOverCapacity(): void {
  let excess = deliveryCountsByJob.size - MAX_TRACKED_JOBS;
  const it = deliveryCountsByJob.keys();
  while (excess > 0) {
    const oldest = it.next();
    if (oldest.done) break;
    deliveryCountsByJob.delete(oldest.value);
    excess--;
  }
}

/**
 * Test-only helper to keep cases isolated: clears the counter for one jobId,
 * or every jobId when called with no argument. Not for production use.
 */
export function resetDeliveryCounterForTests(jobId?: string): void {
  if (jobId === undefined) {
    deliveryCountsByJob.clear();
  } else {
    deliveryCountsByJob.delete(jobId);
  }
}

// ─── Recipient chatId + authorization (F1) ─────────────────────────────────

/**
 * Resolve the target chatId and authorize it:
 *   - no explicit chatId → falls back to ctx.jobChatId; still null → falls
 *     back to the agent's OWNER chat (see below); no owner either → throws
 *     `noRecipientErrorName` (each tool keeps its historical name).
 *   - explicit chatId === ctx.jobChatId → allowed without a DB lookup (the
 *     job's origin chat is authorized by construction).
 *   - explicit chatId that diverges from ctx.jobChatId → must be an ACTIVE
 *     row in telegram_allowed_chats for this agent or its entity, else
 *     throws `telegram_chat_not_allowed`. No fallback, no silent redirect —
 *     an agent can never message an arbitrary chat id it wasn't approved for.
 *   - hard per-job delivery ceiling (L4): a real jobId that has already hit
 *     MAX_DELIVERIES_PER_JOB successful resolutions throws
 *     `telegram_send_rate_limited` before any lookup runs. An empty/absent
 *     jobId (minimal test contexts) is never counted or rate-limited.
 */
export async function resolveRecipientChatId(
  explicitChatId: string | undefined,
  ctx: ToolContext,
  noRecipientErrorName: string,
): Promise<string> {
  if (ctx.jobId && (deliveryCountsByJob.get(ctx.jobId) ?? 0) >= MAX_DELIVERIES_PER_JOB) {
    const err = new Error(
      `telegram_send_rate_limited: this job has already sent ${MAX_DELIVERIES_PER_JOB} ` +
        'messages, the per-job delivery ceiling. Stop sending and finish with return_result ' +
        'instead — do not retry this call.',
    );
    err.name = 'telegram_send_rate_limited';
    throw err;
  }

  let chatId = explicitChatId ?? ctx.jobChatId;

  // Owner fallback: an unsolicited run (cron watcher, notify_on_success=false,
  // any job with no originating chat) that decides on its own initiative to
  // speak must reach the OWNER — the same canonical target as every other
  // unsolicited delivery since commit 77c40b8 (`schedule.chatId ??
  // resolveOwnerChatId()`), never a guessed or last-seen chat. Only applies
  // when the caller omitted chatId entirely — an explicit chatId always goes
  // through the allowlist check below, never this shortcut, so the owner is
  // NOT allowlist-checked (it's the canonical target, not a guess).
  // For a DELEGATED child job running on its entity's inherited root token,
  // ctx.agentId is the CHILD agent — owner rows live on the root agent, so
  // this correctly resolves to null and the child still throws no-recipient;
  // it must deliver through its parent chain, never guess the root's owner.
  if (explicitChatId === undefined && chatId === null) {
    chatId = await resolveOwnerChatId(ctx.db, ctx.agentId);
  }

  if (!chatId) {
    const err = new Error(noRecipientErrorName);
    err.name = noRecipientErrorName;
    throw err;
  }

  if (explicitChatId !== undefined && explicitChatId !== ctx.jobChatId) {
    const allowed = await isChatAllowed(ctx.db, {
      entityId: ctx.entityId,
      agentId: ctx.agentId,
      chatId: explicitChatId,
    });
    if (!allowed) {
      const err = new Error(
        "telegram_chat_not_allowed: this chat id is not an approved chat for this agent's " +
          'entity. Only chats already approved (the owner, or a member the owner confirmed) ' +
          'may be messaged — do not guess, invent, or reuse a chat id from elsewhere.',
      );
      err.name = 'telegram_chat_not_allowed';
      throw err;
    }
  }

  if (ctx.jobId) {
    deliveryCountsByJob.set(ctx.jobId, (deliveryCountsByJob.get(ctx.jobId) ?? 0) + 1);
    evictOldestIfOverCapacity();
  }

  return chatId;
}

// ─── Local source-path confinement (F2) ────────────────────────────────────

/**
 * Confine a local `source` path to the agent's own filesystem surface: any
 * of its workspace roots, the community-skill store, or the OS temp dir.
 * Resolves symlinks via realpath BEFORE the containment check, so a symlink
 * planted inside an allowed root cannot point outside it. Windows-safe
 * (case-insensitive, separator-normalized) and guards prefix tricks like
 * `C:\workspace-evil` matching `C:\workspace` by comparing with a trailing
 * separator. Returns the resolved real path on success; throws
 * `source_path_not_allowed` otherwise.
 */
export async function assertLocalSourceAllowed(source: string, ctx: ToolContext): Promise<string> {
  const real = await realpath(source);

  const roots: string[] = [
    ...(ctx.workspaces ?? []).map((w) => w.path),
    ...(ctx.skillStoreDir ? [ctx.skillStoreDir] : []),
    tmpdir(),
  ];

  const normalize = (p: string): string => {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const normReal = normalize(real);

  const isInside = roots.some((root) => {
    const normRoot = normalize(root);
    return normReal === normRoot || normReal.startsWith(normRoot + path.sep);
  });

  if (!isInside) {
    const err = new Error(
      "source_path_not_allowed: local sources must be under one of the agent's workspaces, " +
        "the skill store, or the temp directory. For anything else, use the service's http " +
        "URL instead (e.g. ComfyUI's /view endpoint) rather than a raw local path.",
    );
    err.name = 'source_path_not_allowed';
    throw err;
  }

  return real;
}

// ─── Bounded, link-local-blocked URL fetch (F3) ────────────────────────────

const FETCH_TIMEOUT_MS = 30_000;

/** Literal hostname check for link-local ranges (cloud metadata on VPS deployments). */
function isLinkLocalHost(rawHostname: string): boolean {
  const h = rawHostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h.startsWith('fe80:')) return true;
  const octets = h.split('.');
  return octets.length === 4 && octets[0] === '169' && octets[1] === '254';
}

/** Read a Response body up to `maxBytes`, aborting the stream as soon as the cap is exceeded. */
async function readBoundedBody(
  res: Response,
  maxBytes: number,
  tooLargeErrorName: string,
): Promise<Uint8Array> {
  const throwTooLarge = (detail: string): never => {
    const err = new Error(`${tooLargeErrorName}: ${detail}`);
    err.name = tooLargeErrorName;
    throw err;
  };

  const contentLengthHeader = res.headers.get('content-length');
  if (contentLengthHeader !== null) {
    const declared = Number(contentLengthHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throwTooLarge(`declared size ${declared} bytes exceeds cap of ${maxBytes} bytes`);
    }
  }

  const reader = res.body?.getReader();
  if (!reader) {
    // No streaming body available — fall back to a single read, still capped.
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) {
      throwTooLarge(`${buf.byteLength} bytes exceeds cap of ${maxBytes} bytes`);
    }
    return new Uint8Array(buf);
  }

  // Stream and enforce the cap on actual bytes read — Content-Length can be
  // absent or wrong; this is the real backstop against an oversized download.
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throwTooLarge(`exceeded cap of ${maxBytes} bytes while streaming`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * Fetch an http(s) URL server-side, capped at `maxBytes` (streamed — the cap
 * is enforced as bytes arrive, not after a full buffer is built) and bounded
 * by a 30s timeout. localhost/loopback is intentionally ALLOWED (ComfyUI on
 * 127.0.0.1 is the documented core use case); only link-local ranges
 * (169.254.0.0/16, fe80::/10 — cloud metadata on VPS deployments) are
 * blocked, via a hostname-literal check (no DNS resolution).
 */
export async function fetchBoundedUrl(
  url: string,
  opts: { maxBytes: number; tooLargeErrorName: string },
): Promise<Uint8Array> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    const err = new Error(`fetch_failed: invalid URL ${url}`);
    err.name = 'fetch_failed';
    throw err;
  }

  if (isLinkLocalHost(parsed.hostname)) {
    const err = new Error(`fetch_failed: link-local address ${parsed.hostname} is not allowed`);
    err.name = 'fetch_failed';
    throw err;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (fetchErr) {
    const errMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    const err = new Error(`fetch_failed: ${errMsg}`);
    err.name = 'fetch_failed';
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const err = new Error(`fetch_failed: HTTP ${res.status} from ${url}`);
    err.name = 'fetch_failed';
    throw err;
  }

  // fetch follows redirects transparently, so the pre-flight hostname check
  // above can be bypassed by a benign-looking URL 302-ing to a link-local
  // address. Re-check the FINAL url before reading a single body byte — the
  // request may have been made, but nothing gets exfiltrated. The security
  // throw sits OUTSIDE any try so a body-cancel quirk can never swallow it.
  let finalHostname: string | null = null;
  if (res.url) {
    try {
      finalHostname = new URL(res.url).hostname;
    } catch {
      // res.url unparseable (exotic mock/environment) — the pre-flight check
      // on the original URL already ran; proceed.
    }
  }
  if (finalHostname !== null && isLinkLocalHost(finalHostname)) {
    try {
      await res.body?.cancel();
    } catch {
      // best-effort — refusing to read is what matters
    }
    const err = new Error(
      `fetch_failed: redirected to link-local address ${finalHostname}, refusing to read the response`,
    );
    err.name = 'fetch_failed';
    throw err;
  }

  return readBoundedBody(res, opts.maxBytes, opts.tooLargeErrorName);
}

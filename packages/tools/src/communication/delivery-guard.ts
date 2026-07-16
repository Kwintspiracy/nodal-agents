// communication/delivery-guard.ts — shared boundary checks for the six
// outbound delivery tools (telegram_send_message, send_image, send_file,
// send_video, send_audio, send_voice).
//
// Consolidates what used to be copy-pasted per tool:
//   - transport channel resolution (resolveChannelForJob)
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
import {
  agents,
  resolveOwnerConversation,
  isConversationAllowed,
  getBindingCredentials,
  getChannelBinding,
} from '@nodal-agents/db';
import { resolveTransportChannel, type ChannelKind } from '@nodal-agents/delivery';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveAndCheckPath, WorkspaceError } from '../builtin/file-ops/workspace';
import type { ToolContext } from '../types';

// ─── Transport channel ──────────────────────────────────────────────────────

/**
 * The channel a job delivers on BEFORE considering a send tool's own explicit
 * `channel` argument. `ctx.notifyChannelOverride` (B1: a cron fire whose
 * schedule chose an explicit notify channel) wins when present — it must
 * agree with the channel the job's chatId was resolved against
 * (run-schedules.ts). Otherwise falls through to the historical
 * `resolveTransportChannel(jobChannel, activeChannels)` default.
 */
function defaultChannelForJob(ctx: ToolContext): ChannelKind {
  return ctx.notifyChannelOverride ?? resolveTransportChannel(ctx.jobChannel, ctx.activeChannels);
}

/**
 * Which ChannelAdapter a delivery tool sends THIS job's messages through
 * (S3 of the multichannel plan, extended for cross-channel sends). `explicitChannel`
 * is the send tool's optional `channel` argument — a caller targeting a
 * platform OTHER than the one this job runs on. When given, it wins ONLY if
 * this agent has an ENABLED binding for it (verified via `getChannelBinding`)
 * — never assume credentials just because the LLM named a channel; absent
 * that binding, throws `channel_not_connected`. When `explicitChannel` names
 * the SAME channel the job already runs on (including when it is omitted),
 * behavior is byte-identical to before this parameter existed: `ctx.jobChannel`
 * (the job's trigger origin — `agent_jobs.channel`) wins when it already names
 * a registered transport (today: telegram/discord/slack/whatsapp); otherwise
 * the job was triggered by something that isn't itself a transport (cron,
 * webhook, dashboard, api, …), and the default is the agent's own active
 * channel (`ctx.activeChannels`, populated by the runner from the same checks
 * that gate comm-tool registration) — or `'telegram'` when that's absent/empty.
 * See resolveTransportChannel for the shared default rule (also used by
 * deliver-results.ts's, run-schedules.ts's, and notify.ts's channel-return
 * send sites).
 */
export async function resolveChannelForJob(
  ctx: ToolContext,
  explicitChannel?: ChannelKind,
): Promise<ChannelKind> {
  const jobChannel = defaultChannelForJob(ctx);
  if (explicitChannel === undefined || explicitChannel === jobChannel) {
    return jobChannel;
  }

  const binding = await getChannelBinding(ctx.db, ctx.agentId, explicitChannel);
  if (!binding || !binding.enabled) {
    const err = new Error(
      `channel_not_connected: this agent has no enabled ${explicitChannel} binding to send through.`,
    );
    err.name = 'channel_not_connected';
    throw err;
  }
  return explicitChannel;
}

// ─── Bot token ──────────────────────────────────────────────────────────────

/**
 * The runner's resolved token wins (B3: a delegated worker inheriting its
 * entity's root agent's token so it can reply on the same chat as the
 * orchestrator); otherwise fall back to this agent's own token from DB
 * (credential isolation per agent, historical path). Returns undefined when
 * neither is configured — callers throw their own tool-specific error name.
 *
 * Channel-parametric since D2 (Discord ingress): a non-telegram channel
 * (today: 'discord'/'slack', or an explicit cross-channel target — see
 * resolveChannelForJob) resolves its credential from that channel's
 * channel_bindings row instead, via the shared `getBindingCredentials`
 * (@nodal-agents/db) — the same helper approvals/notify.ts and the inbound
 * handlers use. NOTE: B3's delegation inheritance (`ctx.resolvedTelegramBotToken`)
 * is telegram-only — a delegated worker replying on a discord job does not yet
 * inherit its orchestrator's binding; generalizing that is cleanup-phase work
 * once a real delegated discord flow needs it.
 *
 * `explicitChannel` (a send tool's optional `channel` argument) is threaded
 * straight into `resolveChannelForJob` — credential resolution always follows
 * whichever channel that resolves to, the job's own or an explicit cross-
 * channel target.
 */
export async function resolveBotToken(
  ctx: ToolContext,
  explicitChannel?: ChannelKind,
): Promise<string | undefined> {
  const channel = await resolveChannelForJob(ctx, explicitChannel);
  if (channel !== 'telegram') {
    const creds = await getBindingCredentials(ctx.db, ctx.agentId, channel);
    return creds?.['botToken'] ?? undefined;
  }

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
 *     back to the agent's OWNER conversation on THIS job's transport channel
 *     (see below); no owner either → throws `noRecipientErrorName` (each tool
 *     keeps its historical name).
 *   - explicit chatId === ctx.jobChatId → allowed without a DB lookup (the
 *     job's origin chat is authorized by construction).
 *   - explicit chatId that diverges from ctx.jobChatId → must be an ACTIVE
 *     row for this agent or its entity on the job's transport channel, else
 *     throws `telegram_chat_not_allowed`. No fallback, no silent redirect —
 *     an agent can never message an arbitrary chat id it wasn't approved for.
 *   - hard per-job delivery ceiling (L4): a real jobId that has already hit
 *     MAX_DELIVERIES_PER_JOB successful resolutions throws
 *     `telegram_send_rate_limited` before any lookup runs. An empty/absent
 *     jobId (minimal test contexts) is never counted or rate-limited.
 *
 * Channel-parametric (S3, extended for cross-channel sends): resolves
 * `resolveChannelForJob(ctx, explicitChannel)` once and uses it for both the
 * owner fallback and the allowlist check, via the channel-neutral
 * `resolveOwnerConversation`/`isConversationAllowed` (@nodal-agents/db). For
 * channel='telegram' with no `explicitChannel` — every job before cross-
 * channel sends existed — these are byte-identical to the pre-S3
 * `resolveOwnerChatId`/`isChatAllowed` calls they replace (both are thin
 * wrappers pinned to channel='telegram').
 *
 * When `explicitChannel` names a channel OTHER than the job's own transport
 * channel (a cross-channel target), two things change from the same-channel
 * path above:
 *   - `ctx.jobChatId` is never used as a chatId fallback — it belongs to the
 *     JOB's channel, not the target one, so reusing it here would silently
 *     address the wrong platform's id space. Omitting `chatId` on a
 *     cross-channel call always goes through the owner fallback (see below),
 *     resolved on the TARGET channel via the `channel` this function computes.
 *   - the `explicitChatId === ctx.jobChatId` exemption (skips the allowlist
 *     check because "the job's origin chat is authorized by construction")
 *     NEVER applies — that exemption is meaningless once the destination
 *     platform differs, so a cross-channel target is ALWAYS allowlist-checked
 *     against the TARGET channel, even if the raw id string happens to
 *     coincide with `ctx.jobChatId` by coincidence.
 */
export async function resolveRecipientChatId(
  explicitChatId: string | undefined,
  ctx: ToolContext,
  noRecipientErrorName: string,
  explicitChannel?: ChannelKind,
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

  const channel = await resolveChannelForJob(ctx, explicitChannel);
  const crossChannel = explicitChannel !== undefined && explicitChannel !== defaultChannelForJob(ctx);
  let chatId = explicitChatId ?? (crossChannel ? null : ctx.jobChatId);

  // Owner fallback: an unsolicited run (cron watcher, notify_on_success=false,
  // any job with no originating chat — or a cross-channel target with no
  // explicit chatId, see above) that decides on its own initiative to speak
  // must reach the OWNER — the same canonical target as every other
  // unsolicited delivery since commit 77c40b8 (`schedule.chatId ??
  // resolveOwnerChatId()`), never a guessed or last-seen chat. Only applies
  // when the caller omitted chatId entirely — an explicit chatId always goes
  // through the allowlist check below, never this shortcut, so the owner is
  // NOT allowlist-checked (it's the canonical target, not a guess). Resolved
  // on `channel` — the TARGET channel for a cross-channel call.
  // For a DELEGATED child job running on its entity's inherited root token,
  // ctx.agentId is the CHILD agent — owner rows live on the root agent, so
  // this correctly resolves to null and the child still throws no-recipient;
  // it must deliver through its parent chain, never guess the root's owner.
  if (explicitChatId === undefined && chatId === null) {
    chatId = await resolveOwnerConversation(ctx.db, ctx.agentId, channel);
  }

  if (!chatId) {
    const err = new Error(noRecipientErrorName);
    err.name = noRecipientErrorName;
    throw err;
  }

  // Same-channel exemption (chatId === ctx.jobChatId skips the allowlist
  // lookup) NEVER applies cross-channel — see doc comment above.
  const needsAllowlistCheck =
    explicitChatId !== undefined && (crossChannel || explicitChatId !== ctx.jobChatId);

  if (needsAllowlistCheck) {
    const allowed = await isConversationAllowed(ctx.db, {
      entityId: ctx.entityId,
      agentId: ctx.agentId,
      channel,
      conversationId: explicitChatId!,
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
 *
 * A RELATIVE `source` is resolved against the agent's workspace(s) via the
 * SAME `resolveAndCheckPath` file_read/file_write use — never against the
 * runner process's CWD. Before this, a relative path that `file_write` had
 * just accepted (workspace-relative) came back ENOENT from `realpath()`
 * here, because it silently resolved against `process.cwd()` instead: one
 * call site used the agent's workspace as the relative root, the other used
 * the process's. An absolute `source` is untouched by this and keeps its
 * historical behavior (checked directly against the allowed roots below,
 * which is how the skill store and the OS temp dir — neither reachable
 * through workspace-label resolution — stay reachable).
 */
export async function assertLocalSourceAllowed(source: string, ctx: ToolContext): Promise<string> {
  let candidate = source;
  if (!path.isAbsolute(source)) {
    try {
      candidate = await resolveAndCheckPath(ctx, source);
    } catch (err) {
      if (err instanceof WorkspaceError) {
        const wrapped = new Error(`source_path_not_allowed: ${err.message}`);
        wrapped.name = 'source_path_not_allowed';
        throw wrapped;
      }
      throw err;
    }
  }

  let real: string;
  try {
    real = await realpath(candidate);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      const wrapped = new Error(
        path.isAbsolute(source)
          ? `source_path_not_allowed: no file found at "${source}".`
          : `source_path_not_allowed: no file found at workspace-relative path "${source}" ` +
              `(resolved to "${candidate}").`,
      );
      wrapped.name = 'source_path_not_allowed';
      throw wrapped;
    }
    throw err;
  }

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

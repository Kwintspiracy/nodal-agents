// @nodal-agents/llm — retry with exponential backoff + jitter
// Ports retry_with_backoff from AgentOne/agent/resilience.py

import {
  QuotaExhaustedError,
  MessageStructureError,
  RetryExhaustedError,
  LLMTimeoutError,
  LLMCallCancelledError,
} from './errors';

// 429 = transient rate-limit (billing 429 is caught before this set, see throwIfQuotaError)
// 500/502/503 = upstream server errors (transient)
// 408 = Request Timeout (transport/gateway timeout — transient, different from our AbortSignal timeout)
// 504 = Gateway Timeout (reverse-proxy/gateway gave up waiting on the upstream — transient,
//   same family as 502/503; audit#2 M-13. Was missing, so a transient gateway timeout failed
//   the call outright instead of retrying.)
// 529 = Overloaded (Anthropic/MiniMax native — transient capacity pressure, not a quota)
const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);

// ─── Rate-limit (capacity) retry policy ───────────────────────────────────────
//
// 429/529 mean the provider is out of capacity RIGHT NOW — a congestion that
// resolves on the minute scale, not the network-blip scale the generic 1/2/4s
// backoff was built for. Job 47d651c2 (2026-07-17) died exactly there: 4
// attempts in ~7s against an upstream throttle that needed minutes.
//
// Policy (constants match Hermes, conversation_loop.py:4121-4146):
//  - Honor the Retry-After header when present, capped at 600s. Hermes #26293:
//    a 120s cap retried before Anthropic Tier-1's ~171s bucket reset and
//    re-tripped the limit; 600s covers realistic reset windows while rejecting
//    pathological values.
//  - No header → jittered exponential backoff, base 2s, capped at 60s/attempt.
//  - Cumulative wait budget so repeated large Retry-After values can't pin a
//    job for tens of minutes — beyond it, exhaust loudly.
//
// Articulation with failover (Nodal-specific, no Hermes equivalent): when the
// agent HAS a fallback provider configured (`hasFallback`), out-waiting the
// congestion is the wrong move — the backup can serve NOW. One quick retry at
// most, and any wait longer than FALLBACK_MAX_WAIT_MS exhausts immediately so
// failover.ts takes over.
const RATE_LIMIT_BASE_DELAY_MS = 2_000;
const RATE_LIMIT_MAX_DELAY_MS = 60_000;
const RETRY_AFTER_CAP_MS = 600_000;
const RATE_LIMIT_MAX_RETRIES = 5;
const RATE_LIMIT_TOTAL_WAIT_BUDGET_MS = 900_000;
const FALLBACK_MAX_WAIT_MS = 5_000;
const FALLBACK_RATE_LIMIT_MAX_RETRIES = 1;

/**
 * Rate-limit/capacity class: 429, 529, or an explicit rate-limit message when
 * the transport didn't surface a status (some gateways wrap the upstream 429
 * in a 200-with-error-body that the SDK rethrows without a status).
 */
function isRateLimitClass(err: unknown, status: number | null): boolean {
  if (status === 429 || status === 529) return true;
  const msg = errorMessage(err).toLowerCase();
  return msg.includes('rate limit') || msg.includes('rate-limited') || msg.includes('rate_limit');
}

/**
 * Extract a numeric Retry-After (in ms) from the error or its cause chain.
 * AI SDK's APICallError exposes `responseHeaders`; wrapped errors keep it on
 * the cause. Numeric seconds only (like Hermes) — HTTP-date values are rare on
 * LLM APIs and a misparsed date is worse than falling back to backoff.
 */
function getRetryAfterMs(err: unknown): number | null {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur instanceof Error; i++) {
    const headers = (cur as { responseHeaders?: unknown }).responseHeaders;
    if (headers && typeof headers === 'object') {
      for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
        if (key.toLowerCase() === 'retry-after' && typeof value === 'string') {
          const seconds = Number(value);
          if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
        }
      }
    }
    const next = (cur as { cause?: unknown }).cause;
    if (next === cur) break;
    cur = next;
  }
  return null;
}

// ─── Classement du corps d'un 429 ─────────────────────────────────────────────
//
// Un refus de facturation et une congestion passagère arrivent avec le MÊME
// statut HTTP ; seul le corps les distingue. Se tromper coûte dans les deux
// sens : un refus pris pour un passage tourne en boucle contre un compte vide,
// un passage pris pour un refus tue le job d'un coup. Chaque cas porte donc un
// nom, et l'ordre de lecture ci-dessous EST la décision.
//
// Incident 18/09/2026 (issue #163) : OpenRouter a répondu « openrouter could
// not verify available credits for this request in time. retry shortly. ». Le
// seul mot « credit » suffisait à classer ce message en facturation ; deux
// délégations sont mortes en quota_exhausted alors que le fournisseur demandait
// lui-même de réessayer, sans que la politique de réessai ait son mot à dire.
//
// « rate limit exceeded » n'est volontairement AUCUN cas ici : c'est la phrase
// générique des fournisseurs (OpenRouter, Groq, …) pour un simple débit par
// minute, donc un passage, et elle repart par le chemin 429 normal.

/** Les deux classes d'un 429. */
export type Classe429 = 'facturation' | 'passager';

/** Verdict du classement, avec le cas nommé qui l'a décidé. */
export interface Verdict429 {
  classe: Classe429;
  cas: string;
}

/**
 * Les cas reconnus, DANS L'ORDRE DE LECTURE — le premier motif qui accroche
 * décide. L'ordre porte trois arbitrages :
 *  1. le cas passager explicite d'abord : il nomme exactement la panne (la
 *     vérification du solde a expiré, le solde lui-même n'est pas en cause),
 *     donc il l'emporte même si le message parle de crédits ;
 *  2. les refus de facturation ensuite : « insufficient credits, add more and
 *     try again » demande de réessayer, mais le compte refuse quand même ;
 *  3. la demande de réessai générique, puis la simple mention de crédits, qui
 *     reste un refus faute de mieux (prudence d'origine conservée).
 */
const CAS_429: ReadonlyArray<{ cas: string; classe: Classe429; motif: RegExp }> = [
  {
    // « (could not | couldn't | unable to) verify … credit(s) … » : le
    // fournisseur n'a pas pu LIRE le solde à temps, il ne dit rien du solde.
    // La distance entre les deux mots traverse les points : « could not
    // verify. Available credits … » est la même panne, et s'arrêter au premier
    // point la renvoyait dans « credits_evoques », donc en facturation. Elle
    // reste bornée (80 caractères, non gourmande) pour ne pas relier deux
    // phrases sans rapport dans un long corps d'erreur.
    cas: 'solde_non_verifie_a_temps',
    classe: 'passager',
    motif: /(could not|couldn't|cannot|unable to) verify[\s\S]{0,80}?\bcredits?\b/,
  },
  {
    cas: 'credits_insuffisants',
    classe: 'facturation',
    motif:
      /\binsufficient\b|\b(out of|no) credits?\b|\bcredits? (are )?(depleted|exhausted)\b|balance is too low|\badd (more )?credits?\b/,
  },
  { cas: 'quota_depasse', classe: 'facturation', motif: /\bquota\b/ },
  { cas: 'facturation_requise', classe: 'facturation', motif: /\bbilling\b|\bpayment required\b/ },
  {
    // Le fournisseur demande explicitement de réessayer : c'est un passage,
    // quoi que le reste du message mentionne.
    cas: 'reessai_demande',
    classe: 'passager',
    motif: /\b(retry|try again) (shortly|soon|later|in a\b)|\bplease (retry|try again)\b/,
  },
  {
    // Crédits évoqués sans phrase connue : on garde la prudence d'origine et on
    // refuse, plutôt que de boucler contre un compte peut-être vide.
    cas: 'credits_evoques',
    classe: 'facturation',
    motif: /\bcredits?\b/,
  },
];

/**
 * Dit si le corps d'un 429 est un refus de facturation ou une congestion
 * passagère. Aucun fourre-tout : un corps qu'aucun cas ne reconnaît est
 * « non_reconnu » et repart en passager, c'est-à-dire dans la politique de
 * réessai / bascule — le chemin normal d'un 429.
 */
export function classify429Body(body: string): Verdict429 {
  const msg = body.toLowerCase();
  for (const { cas, classe, motif } of CAS_429) {
    if (motif.test(msg)) return { classe, cas };
  }
  return { classe: 'passager', cas: 'non_reconnu' };
}

/**
 * Lève QuotaExhaustedError si le 429 est un refus de facturation. Sinon rend le
 * verdict et la main : l'appelant suit le chemin réessai / bascule, et le cas
 * part dans la ligne `[llm-attempt-failed]` de cette tentative — une seule
 * ligne, pas une troisième à côté de celles qui existent déjà.
 *
 * Le cas voyage aussi dans le message de l'erreur de facturation, donc
 * `agent_jobs.error` dit POURQUOI le job est mort, pas seulement qu'il l'est.
 */
function throwIfQuotaError(err: unknown, provider: string, model: string): Verdict429 {
  const msg = errorMessage(err).toLowerCase();
  const verdict = classify429Body(msg);
  if (verdict.classe === 'facturation') {
    throw new QuotaExhaustedError(provider, model, `${msg} [cas=${verdict.cas}]`);
  }
  return verdict;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function getStatusCode(err: unknown): number | null {
  if (err instanceof Error && 'status' in err) {
    const s = (err as { status: unknown }).status;
    if (typeof s === 'number') return s;
  }
  if (err instanceof Error && 'statusCode' in err) {
    const s = (err as { statusCode: unknown }).statusCode;
    if (typeof s === 'number') return s;
  }
  return null;
}

function isRetryableError(err: unknown): boolean {
  // LLMTimeoutError is NOT retryable: if we waited the full per-call budget
  // (default 300s, matching Hermes' `_compute_non_stream_stale_timeout`) and
  // got nothing back, retrying spends another 300s for the same outcome on
  // the same prompt. Surface the timeout to the caller (orchestrator) so it
  // can take an actual decision — notify the user, switch model, give up.
  // Hermes' transport never retries on its stale timeout for the same reason.
  if (err instanceof LLMTimeoutError) return false;
  // A cancelled call is over: the job it served was stopped.
  if (err instanceof LLMCallCancelledError) return false;

  const msg = errorMessage(err).toLowerCase();

  // Malformed / unparseable provider response. The provider returned a body the
  // SDK couldn't read as JSON (truncated stream, transient encoding glitch, or a
  // non-JSON error page). Checked BEFORE the status gate because the status code
  // is unreliable here — a 200 with a corrupted body is common, and the SDK then
  // computes isRetryable=false. These are almost always transient at the
  // transport layer, so a bounded retry clears them. Live trigger: JobHunter job
  // baee450d (2026-06-04) died at turn 3 on a single such blip with no retry.
  if (
    msg.includes('invalid json response') ||
    msg.includes('unexpected end of json') ||
    msg.includes('unexpected token')
  ) {
    return true;
  }

  // Honor the AI SDK's own retryability verdict when it carries one. APICallError
  // flags 408/409/429/5xx and provider-specific transient cases as retryable; we
  // trust that signal rather than re-deriving it.
  if (err instanceof Error && (err as { isRetryable?: unknown }).isRetryable === true) {
    return true;
  }

  const status = getStatusCode(err);
  if (status !== null) {
    return RETRYABLE_HTTP_STATUSES.has(status);
  }
  // Network errors (ECONNREFUSED, ETIMEDOUT, etc.) are retryable.
  // 'socket hang up' and 'econnreset' cover dropped native connections
  // common on DeepSeek/MiniMax direct endpoints under load.
  return (
    msg.includes('econnrefused') ||
    msg.includes('etimedout') ||
    msg.includes('network') ||
    msg.includes('fetch failed') ||
    msg.includes('socket hang up') ||
    msg.includes('econnreset')
  );
}

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  /** Provider name for QuotaExhaustedError context */
  provider?: string;
  /** Model name for QuotaExhaustedError context */
  model?: string;
  /**
   * True when this client sits in a failover chain with at least one provider
   * AFTER it. Rate-limit waits are then capped short (FALLBACK_MAX_WAIT_MS) so
   * the chain fails over to the backup instead of out-waiting the congestion.
   * The LAST provider of a chain (and a chainless client) keeps the patient
   * policy — waiting is its only remaining card.
   */
  hasFallback?: boolean;
}

/**
 * Calls fn() and retries on transient errors with exponential backoff + jitter.
 *
 * NEVER retries:
 * - MessageStructureError (structural bug — will fail again deterministically)
 * - QuotaExhaustedError (billing depleted — more calls won't help)
 * - Non-retryable HTTP errors (4xx except 429)
 *
 * @param fn          Zero-argument async function to execute
 * @param options     Retry configuration
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const provider = options.provider ?? 'unknown';
  const model = options.model ?? 'unknown';
  const hasFallback = options.hasFallback ?? false;

  let lastErr: unknown;
  const start = Date.now();
  let attempts = 0; // total fn() calls made
  let genericRetries = 0; // retries spent on the generic (network/5xx) path
  let rateLimitRetries = 0; // retries spent on the rate-limit (429/529) path
  let rateLimitWaitMs = 0; // cumulative sleep on the rate-limit path

  const exhaust = (): never => {
    const totalMs = Date.now() - start;
    console.warn(
      `[llm-retry-exhausted] provider=${provider} model=${model} attempts=${attempts} total_ms=${totalMs}`,
    );
    throw new RetryExhaustedError(attempts, lastErr);
  };

  for (;;) {
    attempts++;
    const attemptStart = Date.now();
    try {
      return await fn();
    } catch (err) {
      const attemptMs = Date.now() - attemptStart;

      // Non-retryable by class — fail immediately
      if (err instanceof MessageStructureError) throw err;
      if (err instanceof QuotaExhaustedError) throw err;

      // 429: classify the body first — a billing refusal throws
      // QuotaExhaustedError, a transient one falls through to the retry path
      // and carries its case name into this attempt's log line.
      const status = getStatusCode(err);
      const cas429 = status === 429 ? throwIfQuotaError(err, provider, model).cas : undefined;

      const rateLimited = isRateLimitClass(err, status);
      const retryBudget = rateLimited
        ? hasFallback
          ? FALLBACK_RATE_LIMIT_MAX_RETRIES
          : RATE_LIMIT_MAX_RETRIES
        : maxRetries;

      // A call stopped by the person is not a failed attempt: it is never
      // retried, and logging it as `attempt=1/4` read like the start of a
      // retry loop. The runner traces the stop itself (cancellation_observed).
      if (err instanceof LLMCallCancelledError) throw err;

      // Log the attempt outcome so live failures carry diagnosable info.
      // Without this, RetryExhaustedError stored only "Retry exhausted after N
      // attempts" and we burnt 3 patch cycles speculating on the cause.
      logAttempt({
        attempt: attempts,
        of: retryBudget + 1,
        provider,
        model,
        ms: attemptMs,
        err,
        cas429,
      });

      lastErr = err;

      if (rateLimited) {
        if (rateLimitRetries >= retryBudget) exhaust();
        const retryAfterMs = getRetryAfterMs(err);
        // Retry-After is exact — no jitter; computed backoff gets 0–500ms jitter.
        const delay =
          retryAfterMs !== null
            ? Math.min(retryAfterMs, RETRY_AFTER_CAP_MS)
            : Math.min(
                RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, rateLimitRetries),
                RATE_LIMIT_MAX_DELAY_MS,
              ) +
              Math.random() * 500;
        // With a fallback behind us, a long wait is worse than failing over.
        if (hasFallback && delay > FALLBACK_MAX_WAIT_MS) exhaust();
        if (rateLimitWaitMs + delay > RATE_LIMIT_TOTAL_WAIT_BUDGET_MS) exhaust();
        console.warn(
          `[llm-rate-limited] provider=${provider} model=${model} ` +
            `waiting_ms=${Math.round(delay)} source=${retryAfterMs !== null ? 'retry-after' : 'backoff'} ` +
            `attempt=${rateLimitRetries + 1}/${retryBudget}`,
        );
        rateLimitWaitMs += delay;
        rateLimitRetries++;
        await sleep(delay);
        continue;
      }

      // Non-retryable HTTP error
      if (!isRetryableError(err)) throw err;

      if (genericRetries >= maxRetries) exhaust();
      const jitter = Math.random() * 500; // 0–500ms jitter
      const delay = baseDelayMs * Math.pow(2, genericRetries) + jitter;
      genericRetries++;
      await sleep(delay);
    }
  }
}

function logAttempt({
  attempt,
  of,
  provider,
  model,
  ms,
  err,
  cas429,
}: {
  attempt: number;
  of: number;
  provider: string;
  model: string;
  ms: number;
  err: unknown;
  /** Cas retenu par classify429Body quand la tentative a fini sur un 429. */
  cas429?: string;
}): void {
  const errName = err instanceof Error ? err.name : 'unknown';
  const errMsg = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
  const cause = err instanceof Error ? (err as { cause?: unknown }).cause : undefined;
  const causeName = cause instanceof Error ? cause.name : undefined;
  const causeMsg = cause instanceof Error ? cause.message.slice(0, 160) : undefined;
  const statusCode = getStatusCode(err);
  const parts = [
    `provider=${provider}`,
    `model=${model}`,
    `attempt=${attempt}/${of}`,
    `ms=${ms}`,
    `err=${errName}`,
    `msg=${JSON.stringify(errMsg)}`,
  ];
  if (statusCode !== null) parts.push(`status=${statusCode}`);
  if (cas429) parts.push(`cas429=${cas429}`);
  if (causeName) parts.push(`causeName=${causeName}`);
  if (causeMsg) parts.push(`causeMsg=${JSON.stringify(causeMsg)}`);
  console.warn(`[llm-attempt-failed] ${parts.join(' ')}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

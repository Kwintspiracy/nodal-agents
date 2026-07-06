// @nodal-agents/llm — provider failover
//
// Generic, opt-in resilience: given an ORDERED chain of provider configs
// (primary + user-configured fallbacks), expose a NodalLlmClient that tries
// each provider in turn. On a transient/availability failure (5xx exhausted,
// timeout, or quota) it fails over to the next provider; a deterministic error
// (e.g. malformed messages) propagates immediately because a backup would fail
// identically. When the whole chain is exhausted it throws AllProvidersFailed —
// loud, never silent (the user explicitly configured the chain).
//
// Sticky-forward within a call sequence: once a provider succeeds we start the
// next call from it, so a primary outage doesn't re-pay the primary's full
// retry budget on every turn. We never fall back UP the chain mid-job — a
// recovered primary is picked up on the next job, not mid-run.

import type { ProviderConfig, NodalLlmClient } from './types';
import {
  RetryExhaustedError,
  LLMTimeoutError,
  QuotaExhaustedError,
  AllProvidersFailedError,
  ProviderConfigError,
} from './errors';
import { createLlmClient } from './client';

/**
 * An error is "failover-worthy" when it means the provider can't serve the
 * request right now — a different provider plausibly can. Deterministic errors
 * (message-structure violations, config errors) are NOT failover-worthy: the
 * next provider would reject them identically, so they propagate as-is.
 */
function isFailoverWorthy(err: unknown): boolean {
  return (
    err instanceof RetryExhaustedError ||
    err instanceof LLMTimeoutError ||
    err instanceof QuotaExhaustedError
  );
}

function errLabel(err: unknown): string {
  return err instanceof Error ? err.name : String(err);
}

/**
 * Build a failover client from an ordered list of already-constructed clients.
 * Exposed for unit tests (inject fakes without touching the provider SDKs).
 */
export function createFailoverFromClients(clients: NodalLlmClient[]): NodalLlmClient {
  if (clients.length === 0) {
    throw new ProviderConfigError('failover: at least one client is required');
  }
  // Single provider → no failover semantics at all; return it untouched so the
  // behaviour (and error types) is byte-identical to a plain createLlmClient.
  if (clients.length === 1) return clients[0]!;

  let activeIndex = 0;

  async function runWithFailover<T>(
    op: (client: NodalLlmClient) => Promise<T>,
    label: string,
  ): Promise<T> {
    let lastErr: unknown;
    for (let i = activeIndex; i < clients.length; i++) {
      try {
        const result = await op(clients[i]!);
        activeIndex = i; // stick to the provider that worked
        return result;
      } catch (err) {
        lastErr = err;
        if (!isFailoverWorthy(err)) throw err; // backup won't help → propagate
        const next = i + 1;
        if (next < clients.length) {
          console.warn(
            `[llm-failover] ${label}: ${clients[i]!.config.provider}/${clients[i]!.config.model} ` +
              `failed (${errLabel(err)}) — failing over to ` +
              `${clients[next]!.config.provider}/${clients[next]!.config.model}`,
          );
        }
      }
    }
    throw new AllProvidersFailedError(clients.length, lastErr);
  }

  /**
   * Synchronous counterpart to runWithFailover, used for streamText.
   *
   * Unlike generateText/generateObject, streamText returns a StreamTextResult
   * SYNCHRONOUSLY — the AI SDK starts the request in the background and only
   * surfaces a failure later, through the stream itself (`onError`, or an
   * error part on `fullStream`/`textStream`). By the time such a failure
   * surfaces, the stream object is already in the caller's hands; swapping
   * providers under them would mean discarding a stream someone may already
   * be consuming, so that case is NOT covered here.
   *
   * What IS safe to fail over on, without turning the public (synchronous)
   * signature into a Promise: an error thrown synchronously by `op` itself,
   * before any stream object is produced — e.g. a client-side guard
   * (validateIfMessages) that runs ahead of the SDK call. That is narrower
   * than generateText's coverage (which spans the whole request/response
   * cycle via withStaleRetry/withRetry), but it is the one failure class
   * guaranteed to happen before any chunk is produced.
   *
   * Known limitation: a provider outage that only manifests once the stream
   * starts (after this function has already returned) is NOT failed over —
   * documented here and in failover.test.ts rather than silently pretended
   * away.
   */
  function runStreamFailoverSync<T>(op: (client: NodalLlmClient) => T, label: string): T {
    let lastErr: unknown;
    for (let i = activeIndex; i < clients.length; i++) {
      try {
        const result = op(clients[i]!);
        activeIndex = i; // stick to the provider that worked
        return result;
      } catch (err) {
        lastErr = err;
        if (!isFailoverWorthy(err)) throw err; // backup won't help → propagate
        const next = i + 1;
        if (next < clients.length) {
          console.warn(
            `[llm-failover] ${label}: ${clients[i]!.config.provider}/${clients[i]!.config.model} ` +
              `failed (${errLabel(err)}) — failing over to ` +
              `${clients[next]!.config.provider}/${clients[next]!.config.model}`,
          );
        }
      }
    }
    throw new AllProvidersFailedError(clients.length, lastErr);
  }

  return {
    // Surface the CURRENTLY ACTIVE provider's identity/capabilities, not a frozen
    // snapshot of the primary (F2, audit followup). `activeIndex` moves on
    // failover (sticky-forward), and the runner reads `config.model` to compute
    // the per-model cost cap ($) and the context window for compaction — with a
    // frozen primary config those were computed for the WRONG model after a
    // failover. Getters keep them in lockstep with whichever provider is serving.
    get config() {
      return clients[activeIndex]!.config;
    },
    get capabilities() {
      return clients[activeIndex]!.capabilities;
    },
    generateText: ((args) =>
      runWithFailover(
        (c) => c.generateText(args),
        'generateText',
      )) as NodalLlmClient['generateText'],
    streamText: ((args) =>
      runStreamFailoverSync(
        (c) => c.streamText(args),
        'streamText',
      )) as NodalLlmClient['streamText'],
    generateObject: ((args) =>
      runWithFailover(
        (c) => c.generateObject(args),
        'generateObject',
      )) as NodalLlmClient['generateObject'],
  };
}

/**
 * Build a failover client from an ordered chain of provider configs. The first
 * config is the primary; the rest are fallbacks tried in order. A single config
 * yields a plain client (zero overhead, identical behaviour).
 */
export function createFailoverLlmClient(configs: ProviderConfig[]): NodalLlmClient {
  if (configs.length === 0) {
    throw new ProviderConfigError('failover: at least one provider config is required');
  }
  return createFailoverFromClients(configs.map((c) => createLlmClient(c)));
}

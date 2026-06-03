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

  const primary = clients[0]!;
  return {
    // Surface the primary's identity/capabilities; the chain is homogeneous in
    // the capability that matters here (tool use). Failover is for outages, not
    // capability switching.
    config: primary.config,
    capabilities: primary.capabilities,
    generateText: ((args) =>
      runWithFailover(
        (c) => c.generateText(args),
        'generateText',
      )) as NodalLlmClient['generateText'],
    // Streaming keeps single-provider semantics (the runner loop uses
    // generateText). Delegate to the currently-active provider.
    streamText: ((args) => clients[activeIndex]!.streamText(args)) as NodalLlmClient['streamText'],
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

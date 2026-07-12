// moonshot.test.ts — unit tests for the Moonshot (Kimi) native transport provider.
//
// Tests:
// 1. patchMoonshotRequestBody — pure body-rewrite helper (host-agnostic).
// 2. buildMoonshotModel — constructs a LanguageModel without throwing.
// 3. createLlmClient dispatch — 'moonshot' routes to a client with moonshot
//    capabilities from the registry.
// 4. The fetch wrapper — host-gating + real end-to-end body rewrite, verified
//    on the actual JSON body reaching the intercepted upstream fetch.

import { describe, it, expect, vi } from 'vitest';
import { buildMoonshotModel, patchMoonshotRequestBody } from '../providers/moonshot';
import { createLlmClient } from '../client';
import { CAPABILITY_MATRIX } from '../providers/registry';
import { ProviderConfigError } from '../errors';

// ─── patchMoonshotRequestBody — pure function ─────────────────────────────────

describe('patchMoonshotRequestBody', () => {
  it('deletes temperature unconditionally', () => {
    const body = patchMoonshotRequestBody(
      { model: 'kimi-k2.6', temperature: 0.7, messages: [] },
      { injectThinking: false },
    ) as Record<string, unknown>;
    expect(body).not.toHaveProperty('temperature');
  });

  it('injects thinking:{type:"enabled"} and strips reasoning_effort when injectThinking is true', () => {
    const body = patchMoonshotRequestBody(
      { model: 'kimi-k2.6', reasoning_effort: 'medium', messages: [] },
      { injectThinking: true },
    ) as Record<string, unknown>;
    expect(body['thinking']).toEqual({ type: 'enabled' });
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('does NOT inject thinking or touch reasoning_effort when injectThinking is false', () => {
    const body = patchMoonshotRequestBody(
      { model: 'some-non-reasoning-model', reasoning_effort: 'low', messages: [] },
      { injectThinking: false },
    ) as Record<string, unknown>;
    expect(body).not.toHaveProperty('thinking');
    expect(body['reasoning_effort']).toBe('low');
  });

  it('sanitizes tools[].function.parameters through the shared Moonshot schema sanitizer', () => {
    const body = patchMoonshotRequestBody(
      {
        model: 'kimi-k2.6',
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              parameters: {
                properties: {
                  city: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                  units: { enum: ['metric', 'imperial', null] },
                },
              },
            },
          },
        ],
      },
      { injectThinking: true },
    ) as Record<string, unknown>;

    const tools = body['tools'] as Array<{ function: { parameters: Record<string, unknown> } }>;
    const params = tools[0]!.function.parameters;
    expect(params['type']).toBe('object');
    const props = params['properties'] as Record<string, Record<string, unknown>>;
    expect(props['city']).toEqual({ type: 'string' });
    expect(props['units']).toEqual({ type: 'string', enum: ['metric', 'imperial'] });
  });

  it('leaves a body with no tools untouched beyond the temperature/thinking rules', () => {
    const body = patchMoonshotRequestBody(
      { model: 'kimi-k2.6', messages: [{ role: 'user', content: 'hi' }] },
      { injectThinking: true },
    ) as Record<string, unknown>;
    expect(body).not.toHaveProperty('tools');
    expect(body['thinking']).toEqual({ type: 'enabled' });
  });

  it('passes non-object bodies through unchanged', () => {
    expect(patchMoonshotRequestBody(null, { injectThinking: true })).toBeNull();
    expect(patchMoonshotRequestBody('text', { injectThinking: true })).toBe('text');
  });
});

// ─── buildMoonshotModel ────────────────────────────────────────────────────────

describe('buildMoonshotModel', () => {
  it('constructs a LanguageModel object without throwing', () => {
    const model = buildMoonshotModel({
      provider: 'moonshot',
      model: 'kimi-k2.6',
      apiKey: 'sk-moonshot-test',
    });
    expect(model).toBeDefined();
    expect(typeof (model as { specificationVersion?: unknown }).specificationVersion).toBe(
      'string',
    );
  });

  it('throws ProviderConfigError when apiKey is missing', () => {
    expect(() =>
      buildMoonshotModel({
        provider: 'moonshot',
        model: 'kimi-k2.6',
      }),
    ).toThrow(ProviderConfigError);
  });

  it('accepts a custom baseURL override (e.g. the China-region host)', () => {
    const model = buildMoonshotModel({
      provider: 'moonshot',
      model: 'kimi-k2.6',
      apiKey: 'sk-test',
      baseURL: 'https://api.moonshot.cn/v1',
    });
    expect(model).toBeDefined();
  });
});

// ─── createLlmClient dispatch ─────────────────────────────────────────────────

describe('createLlmClient moonshot dispatch', () => {
  it('routes provider:moonshot to a client with moonshot capabilities', () => {
    const client = createLlmClient({
      provider: 'moonshot',
      model: 'kimi-k2.6',
      apiKey: 'sk-test',
    });
    expect(client.config.provider).toBe('moonshot');
    expect(client.capabilities).toEqual(CAPABILITY_MATRIX['moonshot']);
  });

  it('exposes the standard client methods', () => {
    const client = createLlmClient({
      provider: 'moonshot',
      model: 'kimi-k2.6',
      apiKey: 'sk-test',
    });
    expect(typeof client.generateText).toBe('function');
    expect(typeof client.streamText).toBe('function');
    expect(typeof client.generateObject).toBe('function');
  });
});

// ─── Moonshot fetch wrapper — host-gating + real end-to-end body rewrite ──────
// Exercises the actual fetch wrapper built into the LanguageModel (not a
// reimplementation) by intercepting global fetch and inspecting the exact
// JSON body it sends upstream.

describe('Moonshot fetch wrapper behaviour (end-to-end via generateText)', () => {
  it('rewrites the request body for api.moonshot.ai (temperature stripped, thinking injected)', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fakeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: 'x',
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fakeFetch);

    const client = createLlmClient({
      provider: 'moonshot',
      model: 'kimi-k2.6',
      apiKey: 'sk-test',
    });

    await client.generateText({ prompt: 'hi', temperature: 0.7 });

    expect(capturedBody).toBeDefined();
    expect(capturedBody).not.toHaveProperty('temperature');
    expect(capturedBody!['thinking']).toEqual({ type: 'enabled' });

    vi.unstubAllGlobals();
  });

  it('does NOT rewrite requests to a non-Moonshot host', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fakeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: 'x',
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fakeFetch);

    const client = createLlmClient({
      provider: 'moonshot',
      model: 'kimi-k2.6',
      apiKey: 'sk-test',
      baseURL: 'https://some-other-host.example.com/v1',
    });

    await client.generateText({ prompt: 'hi', temperature: 0.7 });

    expect(capturedBody).toBeDefined();
    // Not host-gated for this host: temperature passes through unmodified.
    expect(capturedBody!['temperature']).toBe(0.7);
    expect(capturedBody).not.toHaveProperty('thinking');

    vi.unstubAllGlobals();
  });
});
